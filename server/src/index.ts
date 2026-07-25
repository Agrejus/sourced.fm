import { Hono } from "hono";
import { config } from "./config";
import { db } from "./db";

// Boot order: config (already parsed at import — crashes here if env is bad),
// then db (schema ensured at import), then http. The pipeline worker is wired
// in once its stages exist.
const app = new Hono();

app.get("/api/healthz", (c) => c.json({ ok: true }));

// Touch db so the schema is applied at boot even before any request.
void db;

const server = Bun.serve({ port: config.port, fetch: app.fetch });
console.log(`learn listening on http://localhost:${server.port}`);

export { app };
