import { config } from "../config";
import { localSpeech } from "./local";
import type { SpeechProvider } from "./types";

// Provider selection by env, never per-request. V1 has local only; enabling
// elevenlabs is a config swap plus adding its implementation here.
function selectProvider(): SpeechProvider {
  switch (config.speechProvider) {
    case "local":
      return localSpeech;
    case "elevenlabs":
      throw new Error("SPEECH_PROVIDER=elevenlabs is not built in V1 (design.md §2.6)");
  }
}

export const speech: SpeechProvider = selectProvider();
export type { SpeechProvider, EpisodeAudio } from "./types";
export { SpeechError } from "./types";
