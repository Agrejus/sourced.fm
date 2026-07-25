import type { Context } from "hono";
import type { Accessors, EpisodeRow } from "../db";
import type { Dossier, SourceInput } from "../fetchers/types";
import type { Factcheck, Script } from "../domain";
import { classifyInput, ClassifyError } from "../fetchers/classify";

// Public projection of an episode. dossier.markdown is NEVER exposed — it is
// server-side grounding material only; clients get dossier.sources.
function toDetail(ep: EpisodeRow) {
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
    error: ep.error_json ? JSON.parse(ep.error_json) : null,
    createdAt: ep.created_at,
  };
}

function toListItem(ep: EpisodeRow) {
  return {
    id: ep.id,
    title: ep.title,
    status: ep.status,
    sourceKind: (JSON.parse(ep.source_json) as SourceInput).kind,
    durationMs: ep.duration_ms,
    createdAt: ep.created_at,
  };
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

  function list(c: Context): Response {
    return c.json(deps.accessors.listEpisodes().map(toListItem));
  }

  function get(c: Context): Response {
    const ep = deps.accessors.getEpisode(c.req.param("id")!);
    if (!ep) return c.json({ error: "not found" }, 404);
    return c.json(toDetail(ep));
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

  return { create, list, get, chats, audio };
}
