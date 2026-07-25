import type { Segment } from "../domain";

export interface EpisodeAudio {
  audioPath: string;
  durationMs: number;
  segmentStartMs: number[];
}

// Mirror of the fetcher seam. Nothing outside server/src/speech/ knows which
// provider ran. V1 ships `local` only; ElevenLabs is a config-only swap.
export interface SpeechProvider {
  id: "local" | "elevenlabs";
  synthesizeEpisode(
    episodeId: string,
    segments: Pick<Segment, "idx" | "speaker" | "text">[],
  ): Promise<EpisodeAudio>;
  synthesizeAnswer(text: string): Promise<ReadableStream<Uint8Array>>;
  transcribe(audio: Blob): Promise<string>;
}

export class SpeechError extends Error {}
