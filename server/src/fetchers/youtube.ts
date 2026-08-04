import { config } from "../config";
import { enrichDossier } from "./enrich";
import type { Dossier, FetchResult, ProgressReporter, SourceFetcher, SourceInput } from "./types";

// A YouTube link becomes an episode by way of its transcript.
//
// The transcript comes from the speech service, not from here. Scraping the
// watch page no longer works: the timedtext endpoint answers 200 with an empty
// body unless the request carries a proof-of-origin token, so the signed
// `baseUrl` in the page is useless (VERIFIED 2026-07-31, every fmt and header
// combination returned zero bytes). yt-dlp tracks that plumbing, and it lives
// in the speech container next to the GPU, which also transcribes videos that
// have no captions at all.

// Transcription of a long video can take minutes on top of the download.
const TRANSCRIPT_TIMEOUT_MS = 15 * 60_000;
const MIN_TRANSCRIPT_CHARS = 400;
const DESCRIPTION_CHARS = 800;

export interface YoutubeTranscript {
  title: string;
  author: string;
  durationSec: number;
  description: string;
  /** "captions" when the video had them, "whisper" when the audio was transcribed. */
  source: "captions" | "whisper";
  transcript: string;
}

// watch?v=, youtu.be/, /shorts/, /embed/, /live/ all carry the same 11-char id.
export function youtubeIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const id = (value: string | null | undefined): string | null =>
    value && /^[A-Za-z0-9_-]{11}$/.test(value) ? value : null;

  if (host === "youtu.be") return id(parsed.pathname.slice(1).split("/")[0]);
  if (host !== "youtube.com") return null;
  if (parsed.pathname === "/watch") return id(parsed.searchParams.get("v"));

  const [, section, value] = parsed.pathname.split("/");
  if (section && ["shorts", "embed", "live", "v"].includes(section)) return id(value);
  return null;
}

// The dossier states how the words were obtained, because auto-captions and
// machine transcription both mishear, and the script must not quote them as
// exact speech.
export function buildYoutubeDossier(data: YoutubeTranscript, url: string): Dossier {
  const minutes = data.durationSec ? Math.round(data.durationSec / 60) : 0;
  const provenance =
    data.source === "captions"
      ? "The transcript below is the video's caption track. Automatic captions " +
        "carry no punctuation or speaker labels and mishear proper nouns, so treat " +
        "wording as approximate and do not quote it as exact speech."
      : "The video had no captions, so the transcript below was produced by " +
        "transcribing the audio. Treat wording as approximate, especially names " +
        "and numbers, and do not quote it as exact speech.";

  const parts = [
    `# ${data.title}`,
    [
      data.author ? `YouTube video by ${data.author}` : "YouTube video",
      minutes ? `${minutes} minutes` : "",
    ]
      .filter(Boolean)
      .join(" · "),
    url,
    "",
    provenance,
  ];
  const description = data.description.trim().slice(0, DESCRIPTION_CHARS);
  if (description) parts.push("", "## Description as published", description);
  parts.push("", "## Transcript", data.transcript);

  return {
    markdown: parts.join("\n"),
    title: data.title,
    sources: [{ title: `${data.title}${data.author ? ` (${data.author})` : ""}`, url }],
  };
}

export const youtubeFetcher: SourceFetcher = {
  kind: "youtube",
  async fetch(input: SourceInput, onProgress?: ProgressReporter): Promise<FetchResult> {
    if (input.kind !== "youtube") {
      return {
        ok: false,
        error: { code: "http", message: "youtube fetcher got non-youtube input" },
      };
    }
    const videoId = youtubeIdFromUrl(input.url);
    if (!videoId) {
      return {
        ok: false,
        error: { code: "http", message: `that link has no video id: ${input.url}` },
      };
    }

    onProgress?.("reading the video transcript");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIPT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${config.speechUrl}/youtube`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${videoId}` }),
        signal: controller.signal,
      });
      const body = (await resp.json()) as Partial<YoutubeTranscript> & { error?: string };
      if (!resp.ok) {
        // 422 is a video we cannot use (no captions, too long, a playlist).
        return {
          ok: false,
          error: {
            code: resp.status === 422 ? "empty" : "http",
            message: body.error ?? `speech service HTTP ${resp.status}`,
          },
        };
      }
      if (!body.transcript || body.transcript.length < MIN_TRANSCRIPT_CHARS) {
        return { ok: false, error: { code: "empty", message: "transcript too short to use" } };
      }
      if (body.source === "whisper") onProgress?.("transcribed the audio, building the dossier");
      const base = buildYoutubeDossier(
        {
          title: body.title ?? input.url,
          author: body.author ?? "",
          durationSec: body.durationSec ?? 0,
          description: body.description ?? "",
          source: body.source ?? "captions",
          transcript: body.transcript,
        },
        input.url,
      );
      // A transcript names concepts and moves on, which leaves the episode
      // unable to explain them (the script stage may only use the dossier).
      // Enrichment researches those gaps so the depth exists in the source
      // material rather than being invented in the dialogue. Degrades to the
      // bare transcript on any failure.
      return { ok: true, value: await enrichDossier(base, { sourceNoun: "the video", onProgress }) };
    } catch (e) {
      const aborted = e instanceof Error && e.name === "AbortError";
      return {
        ok: false,
        error: {
          code: aborted ? "timeout" : "http",
          message: aborted ? "transcript timed out" : e instanceof Error ? e.message : String(e),
        },
      };
    } finally {
      clearTimeout(timer);
    }
  },
};
