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
    const resp = await fetch(`${config.speechUrl}/tts/episode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episodeId, segments }),
    });
    const body = (await resp.json()) as {
      audioFile?: string;
      durationMs?: number;
      segmentStartMs?: number[];
      error?: string;
    };
    if (!resp.ok || !body.audioFile) {
      throw new SpeechError(body.error || `tts/episode HTTP ${resp.status}`);
    }
    return {
      audioPath: join(config.dataDir, "episodes", episodeId, body.audioFile),
      durationMs: body.durationMs ?? 0,
      segmentStartMs: body.segmentStartMs ?? [],
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
