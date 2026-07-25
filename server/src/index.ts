import { Hono } from "hono";
import { config } from "./config";
import { accessors, db } from "./db";
import { speech } from "./speech";
import { productionStages } from "./pipeline/stages";
import { createWorker } from "./pipeline/worker";

// Boot order: config (parsed at import — crashes here on bad env), db (schema
// ensured at import), http, then the pipeline worker.
void db;

const app = new Hono();
app.get("/api/healthz", (c) => c.json({ ok: true }));

const now = () => Date.now();

// Crash recovery: re-render anything left mid-synthesis (§2.2).
const reset = accessors.resetStuckSynthesizing(now());
if (reset > 0) console.log(`reset ${reset} stuck synthesizing episode(s) to verified`);

const worker = createWorker({
  claimNext: accessors.claimNextPipelineEpisode,
  scheduleRetry: accessors.scheduleRetry,
  failEpisode: accessors.failEpisode,
  stages: productionStages({ accessors, speech, now }),
  now,
  onError: (message) => console.error(`worker tick error: ${message}`),
});
worker.start();

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`learn listening on http://localhost:${server.port}`);

export { app };
