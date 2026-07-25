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

    try {
      await stage.run(ep);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const attempts = ep.attempts + 1;
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
