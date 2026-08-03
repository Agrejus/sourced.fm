import type { EpisodeRow, Status } from "./db";

// A percentage for an episode still being built. Deliberately an estimate: the
// GPU render gives no callback, so within-stage progress can only be
// elapsed-against-expected. It is honest about that by improving as real
// timings accumulate rather than pretending to know up front.
//
// Expected duration comes from this stage's own measured history, scaled by the
// input-size signal recorded with each run (dossier chars predict script time,
// script chars predict fact-check and render time). Duration-per-unit-of-size is
// what makes a 10-minute episode's history useful for predicting an hour-long
// one. Until history exists, seeded constants stand in.

export type StageName = "source" | "script" | "factcheck" | "synthesize";

export const STAGE_ORDER: StageName[] = ["source", "script", "factcheck", "synthesize"];

// Which stage a status is waiting on or running. 'synthesizing' is mid-render.
const STAGE_FOR_STATUS: Partial<Record<Status, StageName>> = {
  submitted: "source",
  sourced: "script",
  scripted: "factcheck",
  verified: "synthesize",
  synthesizing: "synthesize",
};

// Fallbacks until stage_runs has samples, in milliseconds per input character.
// Anchored on the 59.4-minute episode measured 2026-08-03: a 74k-char script
// rendered in ~58 minutes including transcription and mp3 encode, which is
// ~48ms per character, and the render dominates everything else. Sourcing has no
// size signal and varies hugely — a tweet resolves in seconds, a YouTube
// transcript plus six enrichment passes takes many minutes — so it only ever
// gets a flat number.
const SEED_FLAT_MS: Record<StageName, number> = {
  source: 600_000,
  script: 300_000,
  factcheck: 300_000,
  synthesize: 1_800_000,
};
const SEED_PER_CHAR_MS: Partial<Record<StageName, number>> = {
  script: 5,
  factcheck: 5,
  synthesize: 48,
};

// Never show 0% (work has started) or 100% (it has not finished).
const MIN_PERCENT = 1;
const MAX_PERCENT = 97;
const HISTORY_LIMIT = 20;

export interface Progress {
  percent: number;
  /** Seconds remaining, or null when there is no basis for a guess. */
  etaSeconds: number | null;
  stage: StageName;
}

export interface StageSample {
  durationMs: number;
  size: number;
}

/** Measured samples per stage, read once so a list request is not N queries. */
export type StageHistory = Record<string, StageSample[]>;

export function buildStageHistory(recent: (stage: string, limit: number) => StageSample[]): StageHistory {
  const history: StageHistory = {};
  for (const stage of STAGE_ORDER) history[stage] = recent(stage, HISTORY_LIMIT);
  return history;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

// Expected duration for one stage. `size` is the input-size signal when known,
// 0 when it is not — a future stage whose input does not exist yet.
export function expectedStageMs(stage: StageName, size: number, history: StageHistory): number {
  const samples = history[stage] ?? [];
  if (size > 0) {
    const rates = samples.filter((s) => s.size > 0).map((s) => s.durationMs / s.size);
    const rate = median(rates);
    if (rate !== null) return Math.round(rate * size);
    const perChar = SEED_PER_CHAR_MS[stage];
    if (perChar !== undefined) return Math.round(perChar * size);
  }
  // No size to scale by: fall back to how long this stage usually takes.
  return median(samples.map((s) => s.durationMs)) ?? SEED_FLAT_MS[stage];
}

// The size signal available for a stage right now, mirroring worker.inputSize.
// A stage whose input has not been produced yet returns 0.
function knownSize(stage: StageName, ep: EpisodeRow): number {
  switch (stage) {
    case "script":
      return ep.dossier_json?.length ?? 0;
    case "factcheck":
    case "synthesize":
      return ep.script_json?.length ?? 0;
    default:
      return 0;
  }
}

export interface EpisodeRun {
  stage: string;
  startedAt: number;
  endedAt: number | null;
  ok: number | null;
}

/**
 * Progress for one episode, or null when it is finished or failed (nothing to
 * estimate). Time already spent on this episode is real measured time; only the
 * remainder is predicted, so the number self-corrects as the episode proceeds.
 */
export function estimateProgress(
  ep: EpisodeRow,
  runs: EpisodeRun[],
  history: StageHistory,
  now: number,
): Progress | null {
  const stage = STAGE_FOR_STATUS[ep.status];
  if (!stage) return null; // ready, failed — no work in flight

  // Real time already spent, including a retry that failed: the wall clock the
  // user waited through is the honest denominator.
  let spentMs = 0;
  let currentElapsed = 0;
  for (const run of runs) {
    if (run.endedAt !== null) {
      spentMs += Math.max(0, run.endedAt - run.startedAt);
    } else {
      currentElapsed = Math.max(0, now - run.startedAt);
    }
  }

  const currentExpected = expectedStageMs(stage, knownSize(stage, ep), history);
  const currentRemaining = Math.max(0, currentExpected - currentElapsed);

  // Stages after this one: their inputs do not exist yet, so they are predicted
  // from flat history.
  let laterMs = 0;
  for (const later of STAGE_ORDER.slice(STAGE_ORDER.indexOf(stage) + 1)) {
    laterMs += expectedStageMs(later, knownSize(later, ep), history);
  }

  const done = spentMs + currentElapsed;
  const remaining = currentRemaining + laterMs;
  const total = done + remaining;
  const percent = total <= 0 ? MIN_PERCENT : Math.round((done / total) * 100);

  return {
    percent: Math.min(MAX_PERCENT, Math.max(MIN_PERCENT, percent)),
    etaSeconds: Math.round(remaining / 1000),
    stage,
  };
}
