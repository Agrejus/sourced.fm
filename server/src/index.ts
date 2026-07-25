import { join } from "node:path";
import { Hono } from "hono";
import { config } from "./config";
import { accessors, db } from "./db";
import { speech } from "./speech";
import { productionStages } from "./pipeline/stages";
import { createWorker } from "./pipeline/worker";
import { createAsk } from "./api/ask";
import { createEpisodesApi } from "./api/episodes";

// Boot order: config (parsed at import — crashes here on bad env), db (schema
// ensured at import), http, then the pipeline worker.
void db;

const app = new Hono();
app.get("/api/healthz", (c) => c.json({ ok: true }));

const now = () => Date.now();

const episodes = createEpisodesApi({ accessors, now });
app.post("/api/episodes", (c) => episodes.create(c));
app.get("/api/episodes", (c) => episodes.list(c));
app.get("/api/episodes/:id", (c) => episodes.get(c));
app.get("/api/episodes/:id/audio", (c) => episodes.audio(c));
app.get("/api/episodes/:id/chats", (c) => episodes.chats(c));

const ask = createAsk({ accessors, speech, now });
app.post("/api/episodes/:id/ask-text", (c) => ask.handleAskText(c));
app.post("/api/episodes/:id/ask", (c) => ask.handleAsk(c));

// Serve the built PWA (app/dist) for any non-/api path; SPA fallback to index.html.
const STATIC_ROOT = join(import.meta.dir, "../../app/dist");
app.get("/*", async (c) => {
  if (c.req.path.startsWith("/api/")) return c.notFound();
  const rel = c.req.path === "/" ? "/index.html" : c.req.path;
  let file = Bun.file(join(STATIC_ROOT, rel));
  if (!(await file.exists())) file = Bun.file(join(STATIC_ROOT, "index.html"));
  if (!(await file.exists())) return c.notFound();
  return new Response(file);
});

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
