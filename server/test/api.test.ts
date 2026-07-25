import { test, expect } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createAccessors, createDb, type Accessors } from "../src/db";
import { createEpisodesApi } from "../src/api/episodes";
import type { Dossier } from "../src/fetchers/types";

function appWith(a: Accessors) {
  const api = createEpisodesApi({ accessors: a, now: () => 1 });
  const app = new Hono();
  app.post("/api/episodes", (c) => api.create(c));
  app.get("/api/episodes", (c) => api.list(c));
  app.get("/api/episodes/:id", (c) => api.get(c));
  app.get("/api/episodes/:id/audio", (c) => api.audio(c));
  app.get("/api/episodes/:id/chats", (c) => api.chats(c));
  return app;
}

test("POST /api/episodes classifies JSON input and returns 201", async () => {
  const app = appWith(createAccessors(createDb(":memory:")));
  const res = await app.request("/api/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "AI" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { status: string; source: { kind: string } };
  expect(body.status).toBe("submitted");
  expect(body.source.kind).toBe("topic");
});

test("POST /api/episodes accepts a raw text/plain body (iOS Shortcut)", async () => {
  const app = appWith(createAccessors(createDb(":memory:")));
  const res = await app.request("/api/episodes", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "https://x.com/u/status/123",
  });
  expect(res.status).toBe(201);
  expect(((await res.json()) as { source: { kind: string } }).source.kind).toBe("tweet");
});

test("POST /api/episodes rejects empty input with 400", async () => {
  const app = appWith(createAccessors(createDb(":memory:")));
  const res = await app.request("/api/episodes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "   " }),
  });
  expect(res.status).toBe(400);
});

test("GET /api/episodes lists newest first with the list projection", async () => {
  const a = createAccessors(createDb(":memory:"));
  a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  a.insertEpisode({ kind: "topic", topic: "kubernetes" }, 2000);
  const res = await appWith(a).request("/api/episodes");
  const list = (await res.json()) as { sourceKind: string; createdAt: number }[];
  expect(list).toHaveLength(2);
  expect(list[0]!.createdAt).toBe(2000); // newest first
  expect(new Set(list.map((e) => e.sourceKind))).toEqual(new Set(["article", "topic"]));
});

test("GET /api/episodes/:id exposes sources but NEVER dossier.markdown", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const dossier: Dossier = {
    markdown: "SECRET_GROUNDING_MATERIAL that must not leak",
    title: "T",
    sources: [{ title: "Src", url: "https://a.com/1" }],
  };
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { dossier_json: JSON.stringify(dossier), title: "T" }, 1000);

  const res = await appWith(a).request(`/api/episodes/${ep.id}`);
  const raw = await res.text();
  expect(res.status).toBe(200);
  expect(raw).not.toContain("SECRET_GROUNDING_MATERIAL");
  const body = JSON.parse(raw) as { dossier: { sources: unknown[]; markdown?: string } };
  expect(body.dossier.sources).toHaveLength(1);
  expect(body.dossier.markdown).toBeUndefined();
});

test("GET /api/episodes/:id returns 404 for unknown id", async () => {
  const res = await appWith(createAccessors(createDb(":memory:"))).request("/api/episodes/nope");
  expect(res.status).toBe(404);
});

test("audio route: Range request returns 206 with correct headers", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const audioPath = join(tmpdir(), `learn-audio-${ep.id}.mp3`);
  await Bun.write(audioPath, new Uint8Array(500)); // 500-byte dummy
  // Walk to ready with the audio path.
  a.updateEpisodeStage(ep.id, "submitted", "sourced", {}, 1);
  a.updateEpisodeStage(ep.id, "sourced", "scripted", {}, 1);
  a.updateEpisodeStage(ep.id, "scripted", "verified", {}, 1);
  a.updateEpisodeStage(ep.id, "verified", "synthesizing", {}, 1);
  a.updateEpisodeStage(ep.id, "synthesizing", "ready", { audio_path: audioPath, duration_ms: 1000 }, 1);

  const app = appWith(a);

  const partial = await app.request(`/api/episodes/${ep.id}/audio`, { headers: { Range: "bytes=0-99" } });
  expect(partial.status).toBe(206);
  expect(partial.headers.get("Content-Length")).toBe("100");
  expect(partial.headers.get("Content-Range")).toBe("bytes 0-99/500");
  expect(partial.headers.get("Accept-Ranges")).toBe("bytes");

  const full = await app.request(`/api/episodes/${ep.id}/audio`);
  expect(full.status).toBe(200);
  expect(full.headers.get("Accept-Ranges")).toBe("bytes");
  expect(full.headers.get("Content-Length")).toBe("500");

  const openEnded = await app.request(`/api/episodes/${ep.id}/audio`, { headers: { Range: "bytes=100-" } });
  expect(openEnded.status).toBe(206);
  expect(openEnded.headers.get("Content-Range")).toBe("bytes 100-499/500");

  const bad = await app.request(`/api/episodes/${ep.id}/audio`, { headers: { Range: "bytes=abc" } });
  expect(bad.status).toBe(416);
});

test("audio route: 404 when no audio yet", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const res = await appWith(a).request(`/api/episodes/${ep.id}/audio`);
  expect(res.status).toBe(404);
});
