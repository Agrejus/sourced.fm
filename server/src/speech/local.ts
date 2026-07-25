import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { config } from "../config";
import type { Segment } from "../domain";
import { SpeechError, type EpisodeAudio, type SpeechProvider } from "./types";

// Thin HTTP client for the local speech service. Frozen contract: impl §1.1.
export const localSpeech: SpeechProvider = {
  id: "local",

  // No request timeout — episodes take minutes; rely on the service's own
  // failure responses. The service writes the mp3 to the shared mount itself,
  // so we only receive metadata and reconstruct the path.
  async synthesizeEpisode(
    episodeId: string,
    segments: Pick<Segment, "idx" | "speaker" | "text">[],
  ): Promise<EpisodeAudio> {
    // A full episode render holds the connection idle for minutes. Bun's fetch
    // enforces an internal ~5-min timeout that neither the `timeout` option nor
    // an AbortSignal reliably overrides (VERIFIED 2026-07-25), so it would abort
    // mid-render and roll the stage back while the GPU keeps working. node:http
    // has no default request timeout — rely on the service's own failure
    // responses (design §2.2).
    const url = new URL(`${config.speechUrl}/tts/episode`);
    const payload = JSON.stringify({ episodeId, segments });
    const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: "POST",
          headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
        },
        (res) => {
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
        },
      );
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    let parsed: { audioFile?: string; durationMs?: number; segmentStartMs?: number[]; error?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new SpeechError(`tts/episode bad response (HTTP ${status}): ${body.slice(0, 200)}`);
    }
    if (status < 200 || status >= 300 || !parsed.audioFile) {
      throw new SpeechError(parsed.error || `tts/episode HTTP ${status}`);
    }
    return {
      audioPath: join(config.dataDir, "episodes", episodeId, parsed.audioFile),
      durationMs: parsed.durationMs ?? 0,
      segmentStartMs: parsed.segmentStartMs ?? [],
    };
  },

  async synthesizeAnswer(text: string): Promise<ReadableStream<Uint8Array>> {
    const resp = await fetch(`${config.speechUrl}/tts/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!resp.ok || !resp.body) {
      throw new SpeechError(`tts/answer HTTP ${resp.status}`);
    }
    return resp.body;
  },

  async transcribe(audio: Blob): Promise<string> {
    const form = new FormData();
    form.append("audio", audio, "audio.webm");
    const resp = await fetch(`${config.speechUrl}/stt`, { method: "POST", body: form });
    const body = (await resp.json()) as { text?: string; error?: string };
    if (!resp.ok || body.text === undefined) {
      throw new SpeechError(body.error || `stt HTTP ${resp.status}`);
    }
    return body.text;
  },
};
