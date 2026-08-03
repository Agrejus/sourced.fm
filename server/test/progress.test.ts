import { test, expect } from "bun:test";
import type { EpisodeRow } from "../src/db";
import {
  buildStageHistory,
  estimateProgress,
  expectedStageMs,
  type EpisodeRun,
  type StageHistory,
  type StageName,
} from "../src/progress";

const NOW = 1_000_000;

function ep(over: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "e1",
    source_json: JSON.stringify({ kind: "youtube", url: "https://youtu.be/x" }),
    title: "t",
    status: "submitted",
    error_json: null,
    dossier_json: null,
    script_json: null,
    factcheck_json: null,
    audio_path: null,
    duration_ms: null,
    listened_at: null,
    position_ms: 0,
    stage_note: null,
    attempts: 0,
    next_attempt_at: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  } as EpisodeRow;
}

const NO_HISTORY: StageHistory = { source: [], script: [], factcheck: [], synthesize: [] };

test("a finished or failed episode has no progress to report", () => {
  expect(estimateProgress(ep({ status: "ready" }), [], NO_HISTORY, NOW)).toBeNull();
  expect(estimateProgress(ep({ status: "failed" }), [], NO_HISTORY, NOW)).toBeNull();
});

test("each status maps to the stage actually doing the work", () => {
  const cases: [EpisodeRow["status"], StageName][] = [
    ["submitted", "source"],
    ["sourced", "script"],
    ["scripted", "factcheck"],
    ["verified", "synthesize"],
    ["synthesizing", "synthesize"],
  ];
  for (const [status, stage] of cases) {
    expect(estimateProgress(ep({ status }), [], NO_HISTORY, NOW)!.stage).toBe(stage);
  }
});

test("percent never reads 0 or 100 while work is still in flight", () => {
  const fresh = estimateProgress(ep(), [{ stage: "source", startedAt: NOW, endedAt: null, ok: null }], NO_HISTORY, NOW)!;
  expect(fresh.percent).toBeGreaterThanOrEqual(1);
  // A stage running far past its estimate must not claim to be finished.
  const overdue = estimateProgress(
    ep({ status: "synthesizing", script_json: "x".repeat(1000) }),
    [{ stage: "synthesize", startedAt: NOW - 10 * 3600_000, endedAt: null, ok: null }],
    NO_HISTORY,
    NOW,
  )!;
  expect(overdue.percent).toBeLessThanOrEqual(97);
  expect(overdue.percent).toBeGreaterThan(fresh.percent);
});

test("progress rises as a stage runs", () => {
  const runs = (elapsedMs: number): EpisodeRun[] => [
    { stage: "synthesize", startedAt: NOW - elapsedMs, endedAt: null, ok: null },
  ];
  const row = ep({ status: "synthesizing", script_json: "x".repeat(60_000) });
  const early = estimateProgress(row, runs(60_000), NO_HISTORY, NOW)!.percent;
  const later = estimateProgress(row, runs(600_000), NO_HISTORY, NOW)!.percent;
  expect(later).toBeGreaterThan(early);
});

test("completed stages count as real time spent, so later stages read higher", () => {
  const row = ep({ status: "synthesizing", dossier_json: "d".repeat(50_000), script_json: "s".repeat(50_000) });
  const withHistory: EpisodeRun[] = [
    { stage: "source", startedAt: 0, endedAt: 300_000, ok: 1 },
    { stage: "script", startedAt: 300_000, endedAt: 500_000, ok: 1 },
    { stage: "factcheck", startedAt: 500_000, endedAt: 700_000, ok: 1 },
    { stage: "synthesize", startedAt: NOW - 60_000, endedAt: null, ok: null },
  ];
  const late = estimateProgress(row, withHistory, NO_HISTORY, NOW)!;
  const fresh = estimateProgress(row, [withHistory[3]!], NO_HISTORY, NOW)!;
  expect(late.percent).toBeGreaterThan(fresh.percent);
});

test("a failed retry still counts as time the user waited through", () => {
  const row = ep({ status: "sourced", dossier_json: "d".repeat(10_000) });
  const bare = estimateProgress(row, [], NO_HISTORY, NOW)!;
  const afterFailure = estimateProgress(
    row,
    [{ stage: "script", startedAt: 0, endedAt: 400_000, ok: 0 }],
    NO_HISTORY,
    NOW,
  )!;
  expect(afterFailure.percent).toBeGreaterThan(bare.percent);
});

test("eta shrinks as the current stage progresses", () => {
  const row = ep({ status: "synthesizing", script_json: "x".repeat(60_000) });
  const a = estimateProgress(row, [{ stage: "synthesize", startedAt: NOW - 60_000, endedAt: null, ok: null }], NO_HISTORY, NOW)!;
  const b = estimateProgress(row, [{ stage: "synthesize", startedAt: NOW - 600_000, endedAt: null, ok: null }], NO_HISTORY, NOW)!;
  expect(b.etaSeconds!).toBeLessThan(a.etaSeconds!);
  expect(b.etaSeconds!).toBeGreaterThanOrEqual(0);
});

test("measured history scales by size, so a longer script predicts a longer render", () => {
  const history: StageHistory = {
    ...NO_HISTORY,
    // 10 minutes for a 40k-char script => 15 ms/char
    synthesize: [{ durationMs: 600_000, size: 40_000 }],
  };
  expect(expectedStageMs("synthesize", 40_000, history)).toBe(600_000);
  expect(expectedStageMs("synthesize", 80_000, history)).toBe(1_200_000);
});

test("history without a size signal still gives a flat estimate", () => {
  const history: StageHistory = { ...NO_HISTORY, source: [{ durationMs: 120_000, size: 0 }] };
  // sourcing has no size signal at all, so the flat median is the answer
  expect(expectedStageMs("source", 0, history)).toBe(120_000);
});

test("with no history at all the seeded constants are used", () => {
  expect(expectedStageMs("source", 0, NO_HISTORY)).toBeGreaterThan(0);
  expect(expectedStageMs("synthesize", 0, NO_HISTORY)).toBeGreaterThan(
    expectedStageMs("script", 0, NO_HISTORY),
  );
});

test("the render is predicted to dominate a long episode", () => {
  const size = 70_000;
  expect(expectedStageMs("synthesize", size, NO_HISTORY)).toBeGreaterThan(
    expectedStageMs("script", size, NO_HISTORY) + expectedStageMs("factcheck", size, NO_HISTORY),
  );
});

test("buildStageHistory reads every stage exactly once", () => {
  const asked: string[] = [];
  const history = buildStageHistory((stage, limit) => {
    asked.push(`${stage}:${limit}`);
    return [];
  });
  expect(asked.length).toBe(4);
  expect(asked.some((a) => a.startsWith("synthesize:"))).toBe(true);
  expect(Object.keys(history).sort()).toEqual(["factcheck", "script", "source", "synthesize"]);
});
