import type { Accessors, ClaimableStatus, EpisodeRow } from "../db";
import type { Script } from "../domain";
import type { SourceInput } from "../fetchers/types";
import { fetcherFor } from "../fetchers";
import type { SpeechProvider } from "../speech";

export interface Stage {
  name: string;
  run(ep: EpisodeRow): Promise<void>;
}

export interface StageDeps {
  accessors: Accessors;
  speech: SpeechProvider;
  now: () => number;
}

// submitted -> sourced: build the dossier via the fetcher for the input kind.
// A FetchError throws so the worker's backoff/attempts path handles it; the
// stage never sets a status on failure (the row stays claimable).
export function sourceStage(deps: StageDeps): Stage {
  return {
    name: "source",
    async run(ep) {
      const input = JSON.parse(ep.source_json) as SourceInput;
      const result = await fetcherFor(input.kind).fetch(input);
      if (!result.ok) {
        throw new Error(`${result.error.code}: ${result.error.message}`);
      }
      const dossier = result.value;
      deps.accessors.updateEpisodeStage(
        ep.id,
        "submitted",
        "sourced",
        { dossier_json: JSON.stringify(dossier), title: dossier.title },
        deps.now(),
      );
    },
  };
}

// verified -> synthesizing -> ready. 'synthesizing' is the crash-detection
// marker (boot recovery resets it to 'verified'). If the speech call fails we
// roll the status back to 'verified' so the worker's retry can reclaim it —
// 'synthesizing' is not a claimable status.
export function synthesizeStage(deps: StageDeps): Stage {
  return {
    name: "synthesize",
    async run(ep) {
      deps.accessors.updateEpisodeStage(ep.id, "verified", "synthesizing", {}, deps.now());
      try {
        if (!ep.script_json) throw new Error("synthesize: episode has no script_json");
        const script = JSON.parse(ep.script_json) as Script;
        const audio = await deps.speech.synthesizeEpisode(
          ep.id,
          script.segments.map((s) => ({ idx: s.idx, speaker: s.speaker, text: s.text })),
        );
        const stamped: Script = {
          ...script,
          segments: script.segments.map((s, i) => ({ ...s, startMs: audio.segmentStartMs[i] ?? 0 })),
        };
        deps.accessors.updateEpisodeStage(
          ep.id,
          "synthesizing",
          "ready",
          {
            audio_path: audio.audioPath,
            duration_ms: audio.durationMs,
            script_json: JSON.stringify(stamped),
          },
          deps.now(),
        );
      } catch (e) {
        deps.accessors.updateEpisodeStage(ep.id, "synthesizing", "verified", {}, deps.now());
        throw e;
      }
    },
  };
}

// M2 wires the non-LLM stages; script (sourced) and factcheck (scripted) are
// registered in M3.
export function productionStages(deps: StageDeps): Partial<Record<ClaimableStatus, Stage>> {
  return {
    submitted: sourceStage(deps),
    verified: synthesizeStage(deps),
  };
}
