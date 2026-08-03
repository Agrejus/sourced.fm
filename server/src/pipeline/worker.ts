import type { ClaimableStatus, EpisodeRow } from "../db";
import type { Stage } from "./stages";

const BASE_BACKOFF_MS = 30_000;
const MAX_ATTEMPTS = 5;
const DEFAULT_TICK_MS = 2000;

export interface WorkerDeps {
  claimNext(now: number): EpisodeRow | null;
  scheduleRetry(id: string, attempts: number, nextAttemptAt: number, now: number): void;
  failEpisode(id: string, stage: string, message: string, now: number): void;
  stages: Partial<Record<ClaimableStatus, Stage>>;
  now?: () => number;
  tickMs?: number;
  onError?: (message: string) => void;
  /** Stage timing, for the progress estimate. Optional: tests omit it. */
  startStageRun?: (episodeId: string, stage: string, size: number, now: number) => number;
  finishStageRun?: (id: number, ok: boolean, now: number) => void;
}

// What predicts this stage's duration, read off the row BEFORE the stage runs.
// Sourcing has no signal yet — the material does not exist — so it falls back to
// a flat historical median.
function inputSize(ep: EpisodeRow): number {
  switch (ep.status) {
    case "sourced":
      return ep.dossier_json?.length ?? 0; // script is written from the dossier
    case "scripted":
    case "verified":
      return ep.script_json?.length ?? 0; // factcheck reads it, synthesis speaks it
    default:
      return 0;
  }
}

// Single-loop worker. Concurrency is exactly 1 (the loop IS the guarantee — no
// workers, queues, or Promise.all). Each tick claims the oldest due episode and
// runs one stage; a drained tick reschedules immediately, an idle tick waits.
export function createWorker(deps: WorkerDeps) {
  const now = deps.now ?? (() => Date.now());
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  // Returns true if an episode was processed this tick.
  async function tick(): Promise<boolean> {
    const ep = deps.claimNext(now());
    if (!ep) return false;

    const stage = deps.stages[ep.status as ClaimableStatus];
    if (!stage) {
      deps.failEpisode(ep.id, ep.status, `no stage registered for status '${ep.status}'`, now());
      return true;
    }

    // Timing is recorded around the stage, not inside it, so every stage is
    // measured the same way and a stage never has to know it is being timed.
    const runId = deps.startStageRun?.(ep.id, stage.name, inputSize(ep), now());
    try {
      await stage.run(ep);
      if (runId !== undefined) deps.finishStageRun?.(runId, true, now());
    } catch (e) {
      if (runId !== undefined) deps.finishStageRun?.(runId, false, now());
      const message = e instanceof Error ? e.message : String(e);
      const attempts = ep.attempts + 1;
      deps.onError?.(`stage ${stage.name} failed for ${ep.id} (attempt ${attempts}): ${message}`);
      if (attempts > MAX_ATTEMPTS) {
        deps.failEpisode(ep.id, stage.name, message, now());
      } else {
        deps.scheduleRetry(ep.id, attempts, now() + BASE_BACKOFF_MS * 2 ** attempts, now());
      }
    }
    return true;
  }

  function schedule(delay: number): void {
    if (stopped) return;
    timer = setTimeout(loop, delay);
  }

  async function loop(): Promise<void> {
    if (stopped) return;
    let processed = false;
    try {
      processed = await tick();
    } catch (e) {
      deps.onError?.(e instanceof Error ? e.message : String(e));
    }
    schedule(processed ? 0 : tickMs);
  }

  return {
    tick,
    start(): void {
      stopped = false;
      schedule(0);
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
