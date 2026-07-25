import { test, expect } from "bun:test";
import { createWorker } from "../src/pipeline/worker";
import type { Stage } from "../src/pipeline/stages";
import type { EpisodeRow, Status } from "../src/db";

function episode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: "ep1",
    source_json: "{}",
    title: "",
    status: "submitted" as Status,
    error_json: null,
    dossier_json: null,
    script_json: null,
    factcheck_json: null,
    audio_path: null,
    duration_ms: null,
    attempts: 0,
    next_attempt_at: 0,
    created_at: 0,
    updated_at: 0,
    ...overrides,
  };
}

function harness(queue: EpisodeRow[], stages: Partial<Record<string, Stage>>) {
  const calls = { scheduleRetry: [] as unknown[][], failEpisode: [] as unknown[][] };
  const worker = createWorker({
    now: () => 1000,
    claimNext: () => queue.shift() ?? null,
    scheduleRetry: (...args) => calls.scheduleRetry.push(args),
    failEpisode: (...args) => calls.failEpisode.push(args),
    stages: stages as never,
  });
  return { worker, calls };
}

test("tick runs the stage mapped to the episode status", async () => {
  const ran: string[] = [];
  const stages = { submitted: { name: "source", run: async (ep: EpisodeRow) => { ran.push(ep.id); } } };
  const { worker } = harness([episode({ id: "e", status: "submitted" })], stages);
  expect(await worker.tick()).toBe(true);
  expect(ran).toEqual(["e"]);
});

test("empty queue does nothing", async () => {
  const { worker, calls } = harness([], {});
  expect(await worker.tick()).toBe(false);
  expect(calls.scheduleRetry).toHaveLength(0);
  expect(calls.failEpisode).toHaveLength(0);
});

test("stage error schedules a backoff retry with incremented attempts", async () => {
  const stages = { submitted: { name: "source", run: async () => { throw new Error("nope"); } } };
  const { worker, calls } = harness([episode({ id: "e", status: "submitted", attempts: 0 })], stages);
  await worker.tick();
  expect(calls.failEpisode).toHaveLength(0);
  expect(calls.scheduleRetry).toHaveLength(1);
  const [id, attempts, nextAt] = calls.scheduleRetry[0]!;
  expect(id).toBe("e");
  expect(attempts).toBe(1);
  expect(nextAt).toBe(1000 + 30_000 * 2 ** 1);
});

test("exceeding max attempts fails the episode", async () => {
  const stages = { submitted: { name: "source", run: async () => { throw new Error("still nope"); } } };
  const { worker, calls } = harness([episode({ id: "e", status: "submitted", attempts: 5 })], stages);
  await worker.tick();
  expect(calls.scheduleRetry).toHaveLength(0);
  expect(calls.failEpisode).toHaveLength(1);
  expect(calls.failEpisode[0]![0]).toBe("e");
  expect(calls.failEpisode[0]![1]).toBe("source");
});

test("a status with no registered stage fails cleanly instead of crashing", async () => {
  const { worker, calls } = harness([episode({ id: "e", status: "sourced" })], {});
  expect(await worker.tick()).toBe(true);
  expect(calls.failEpisode).toHaveLength(1);
  expect(String(calls.failEpisode[0]![2])).toContain("no stage registered");
});
