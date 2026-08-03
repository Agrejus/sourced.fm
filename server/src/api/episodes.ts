import type { Context } from "hono";
import type { Accessors, EpisodeRow } from "../db";
import type { Dossier, SourceInput } from "../fetchers/types";
import type { Factcheck, Script } from "../domain";
import { classifyInput, ClassifyError } from "../fetchers/classify";
import { extractSeedUrls } from "../fetchers/deepresearch";
import { buildStageHistory, estimateProgress, type Progress, type StageHistory } from "../progress";

// A research assignment is prose, not a one-line topic, so it gets a much
// larger ceiling than classifyInput's 500 characters.
const MAX_BRIEF_CHARS = 4000;

// Public projection of an episode. dossier.markdown is NEVER exposed — it is
// server-side grounding material only; clients get dossier.sources.
function toDetail(ep: EpisodeRow, progress: Progress | null = null) {
  const source = JSON.parse(ep.source_json) as SourceInput;
  const dossier = ep.dossier_json ? (JSON.parse(ep.dossier_json) as Dossier) : null;
  const script = ep.script_json ? (JSON.parse(ep.script_json) as Script) : null;
  const factcheck = ep.factcheck_json ? (JSON.parse(ep.factcheck_json) as Factcheck) : null;
  return {
    id: ep.id,
    title: ep.title,
    status: ep.status,
    source,
    sourceKind: source.kind,
    dossier: dossier ? { sources: dossier.sources } : null,
    script: script ? { segments: script.segments } : null,
    factcheck: factcheck ? { claims: factcheck.claims } : null,
    durationMs: ep.duration_ms,
    listenedAt: ep.listened_at,
    positionMs: ep.position_ms,
    note: ep.stage_note,
    // Estimated, and null once the episode is ready or failed.
    progress,
    error: ep.error_json ? JSON.parse(ep.error_json) : null,
    createdAt: ep.created_at,
  };
}

function toListItem(ep: EpisodeRow, progress: Progress | null = null) {
  return {
    id: ep.id,
    title: ep.title,
    status: ep.status,
    sourceKind: (JSON.parse(ep.source_json) as SourceInput).kind,
    durationMs: ep.duration_ms,
    listenedAt: ep.listened_at,
    positionMs: ep.position_ms,
    note: ep.stage_note,
    progress,
    createdAt: ep.created_at,
  };
}

// Progress needs this episode's own timings plus the cross-episode history. The
// history is read once per request so listing N episodes stays a fixed number of
// queries, and is skipped entirely when nothing is in flight.
function progressFor(deps: { accessors: Accessors }, eps: EpisodeRow[], now: number): Map<string, Progress> {
  const live = eps.filter((e) => e.status !== "ready" && e.status !== "failed");
  const out = new Map<string, Progress>();
  if (live.length === 0) return out;
  const history: StageHistory = buildStageHistory(deps.accessors.recentStageRuns);
  for (const ep of live) {
    const p = estimateProgress(ep, deps.accessors.episodeStageRuns(ep.id), history, now);
    if (p) out.set(ep.id, p);
  }
  return out;
}

export interface EpisodesDeps {
  accessors: Accessors;
  now: () => number;
}

export function createEpisodesApi(deps: EpisodesDeps) {
  async function create(c: Context): Promise<Response> {
    // Accept JSON {input} or a raw text/plain body (the iOS Shortcut).
    let input: string;
    const contentType = c.req.header("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as { input?: string };
      input = body.input ?? "";
    } else {
      input = await c.req.text();
    }

    let source: SourceInput;
    try {
      source = classifyInput(input);
    } catch (e) {
      if (e instanceof ClassifyError) return c.json({ error: e.message }, 400);
      throw e;
    }

    const ep = deps.accessors.insertEpisode(source, deps.now());
    return c.json({ id: ep.id, status: ep.status, source }, 201);
  }

  // Deep research: a written assignment instead of a link or a one-line topic.
  // Links inside the assignment become seed sources for the research.
  async function createResearch(c: Context): Promise<Response> {
    const body = (await c.req.json().catch(() => ({}))) as { brief?: unknown };
    const brief = typeof body.brief === "string" ? body.brief.trim() : "";
    if (!brief) return c.json({ error: "brief required" }, 400);
    if (brief.length > MAX_BRIEF_CHARS) {
      return c.json({ error: `brief too long (>${MAX_BRIEF_CHARS} chars)` }, 400);
    }
    const source: SourceInput = { kind: "research", brief, seedUrls: extractSeedUrls(brief) };
    const ep = deps.accessors.insertEpisode(source, deps.now());
    return c.json({ id: ep.id, status: ep.status, source }, 201);
  }

  function list(c: Context): Response {
    const eps = deps.accessors.listEpisodes();
    const progress = progressFor(deps, eps, Date.now());
    return c.json(eps.map((ep) => toListItem(ep, progress.get(ep.id) ?? null)));
  }

  function get(c: Context): Response {
    const ep = deps.accessors.getEpisode(c.req.param("id")!);
    if (!ep) return c.json({ error: "not found" }, 404);
    return c.json(toDetail(ep, progressFor(deps, [ep], Date.now()).get(ep.id) ?? null));
  }

  // Mark/unmark an episode as listened. Idempotent: re-marking an already
  // listened episode refreshes the timestamp rather than erroring.
  async function setListened(c: Context): Promise<Response> {
    const id = c.req.param("id")!;
    const body = (await c.req.json().catch(() => ({}))) as { listened?: unknown };
    if (typeof body.listened !== "boolean") {
      return c.json({ error: "listened must be a boolean" }, 400);
    }
    const listenedAt = body.listened ? deps.now() : null;
    if (!deps.accessors.setEpisodeListened(id, listenedAt, deps.now())) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ id, listenedAt });
  }

  // Playback position. The player reports this every 10 seconds while it plays,
  // and again when it pauses, when the page hides, and when it unloads — so a
  // crash costs at most 10 seconds of progress.
  async function setPosition(c: Context): Promise<Response> {
    const id = c.req.param("id")!;
    const body = (await c.req.json().catch(() => ({}))) as { positionMs?: unknown };
    if (typeof body.positionMs !== "number" || !Number.isFinite(body.positionMs)) {
      return c.json({ error: "positionMs must be a finite number" }, 400);
    }
    if (!deps.accessors.setEpisodePosition(id, body.positionMs, deps.now())) {
      return c.json({ error: "not found" }, 404);
    }
    return c.json({ id, positionMs: deps.accessors.getEpisode(id)!.position_ms });
  }

  function chats(c: Context): Response {
    const id = c.req.param("id")!;
    if (!deps.accessors.getEpisode(id)) return c.json({ error: "not found" }, 404);
    return c.json(
      deps.accessors.listChats(id).map((row) => ({
        role: row.role,
        text: row.text,
        positionMs: row.position_ms,
        createdAt: row.created_at,
      })),
    );
  }

  // Manual Range serving — iOS scrubbing breaks without 206 support.
  async function audio(c: Context): Promise<Response> {
    const ep = deps.accessors.getEpisode(c.req.param("id")!);
    if (!ep || !ep.audio_path) return c.json({ error: "no audio" }, 404);

    const file = Bun.file(ep.audio_path);
    const size = file.size;
    const range = c.req.header("Range");

    if (!range) {
      return new Response(file, {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Accept-Ranges": "bytes",
          "Content-Length": String(size),
        },
      });
    }

    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match || (match[1] === "" && match[2] === "")) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    let start: number;
    let end: number;
    if (match[1] === "") {
      // suffix range: last N bytes
      start = Math.max(0, size - Number(match[2]));
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }

    return new Response(file.slice(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": "audio/mpeg",
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(end - start + 1),
      },
    });
  }

  return { create, createResearch, list, get, setListened, setPosition, chats, audio };
}
