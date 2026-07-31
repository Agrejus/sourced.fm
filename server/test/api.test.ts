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
  app.post("/api/episodes/research", (c) => api.createResearch(c));
  app.get("/api/episodes", (c) => api.list(c));
  app.get("/api/episodes/:id", (c) => api.get(c));
  app.put("/api/episodes/:id/listened", (c) => api.setListened(c));
  app.put("/api/episodes/:id/position", (c) => api.setPosition(c));
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

test("PUT /api/episodes/:id/listened marks, unmarks, and surfaces in the projections", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "topic", topic: "kubernetes" }, 1000);
  const app = appWith(a);

  const listBefore = (await (await app.request("/api/episodes")).json()) as { listenedAt: number | null }[];
  expect(listBefore[0]!.listenedAt).toBeNull();

  const marked = await app.request(`/api/episodes/${ep.id}/listened`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listened: true }),
  });
  expect(marked.status).toBe(200);
  expect(((await marked.json()) as { listenedAt: number | null }).listenedAt).toBe(1);

  const detail = (await (await app.request(`/api/episodes/${ep.id}`)).json()) as { listenedAt: number | null };
  expect(detail.listenedAt).toBe(1);

  const cleared = await app.request(`/api/episodes/${ep.id}/listened`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listened: false }),
  });
  expect(((await cleared.json()) as { listenedAt: number | null }).listenedAt).toBeNull();
});

test("PUT /api/episodes/:id/listened rejects a non-boolean body and unknown ids", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "topic", topic: "kubernetes" }, 1000);
  const app = appWith(a);

  const bad = await app.request(`/api/episodes/${ep.id}/listened`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listened: "yes" }),
  });
  expect(bad.status).toBe(400);

  const missing = await app.request("/api/episodes/nope/listened", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listened: true }),
  });
  expect(missing.status).toBe(404);
});

test("PUT /api/episodes/:id/position saves progress and reports it in both projections", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const app = appWith(a);

  const before = (await (await app.request("/api/episodes")).json()) as { positionMs: number }[];
  expect(before[0]!.positionMs).toBe(0);

  const saved = await app.request(`/api/episodes/${ep.id}/position`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs: 61_500 }),
  });
  expect(saved.status).toBe(200);
  expect(((await saved.json()) as { positionMs: number }).positionMs).toBe(61_500);

  const detail = (await (await app.request(`/api/episodes/${ep.id}`)).json()) as { positionMs: number };
  expect(detail.positionMs).toBe(61_500);
});

test("PUT /api/episodes/:id/position rejects a non-number and an unknown id", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const app = appWith(a);

  for (const positionMs of ["12", null, Number.NaN]) {
    const res = await app.request(`/api/episodes/${ep.id}/position`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ positionMs }),
    });
    expect(res.status).toBe(400);
  }

  const missing = await app.request("/api/episodes/nope/position", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs: 10 }),
  });
  expect(missing.status).toBe(404);
});

test("PUT /api/episodes/:id/listened clears a saved position over HTTP", async () => {
  const a = createAccessors(createDb(":memory:"));
  const ep = a.insertEpisode({ kind: "article", url: "https://a.com/1" }, 1000);
  const app = appWith(a);
  await app.request(`/api/episodes/${ep.id}/position`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ positionMs: 30_000 }),
  });
  await app.request(`/api/episodes/${ep.id}/listened`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listened: true }),
  });
  const detail = (await (await app.request(`/api/episodes/${ep.id}`)).json()) as {
    positionMs: number;
    listenedAt: number | null;
  };
  expect(detail.positionMs).toBe(0);
  expect(detail.listenedAt).toBe(1);
});

test("POST /api/episodes/research queues a research episode with its seed links", async () => {
  const a = createAccessors(createDb(":memory:"));
  const app = appWith(a);
  const brief = "Research solid-state batteries, focus on manufacturing. Start from https://example.com/x";
  const res = await app.request("/api/episodes/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    status: string;
    source: { kind: string; brief: string; seedUrls: string[] };
  };
  expect(body.status).toBe("submitted");
  expect(body.source.kind).toBe("research");
  expect(body.source.brief).toBe(brief);
  expect(body.source.seedUrls).toEqual(["https://example.com/x"]);

  // It shows up in the list as a research episode, awaiting the pipeline.
  const list = (await (await app.request("/api/episodes")).json()) as {
    sourceKind: string;
    note: string | null;
  }[];
  expect(list[0]!.sourceKind).toBe("research");
  expect(list[0]!.note).toBeNull();
});

test("POST /api/episodes/research rejects an empty or oversized brief", async () => {
  const app = appWith(createAccessors(createDb(":memory:")));
  for (const brief of ["", "   ", undefined]) {
    const res = await app.request("/api/episodes/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brief }),
    });
    expect(res.status).toBe(400);
  }
  const tooLong = await app.request("/api/episodes/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "x".repeat(4001) }),
  });
  expect(tooLong.status).toBe(400);
});

test("a research brief far longer than the 500-char topic limit is accepted", async () => {
  const a = createAccessors(createDb(":memory:"));
  const res = await appWith(a).request("/api/episodes/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "Research this deeply. " + "detail ".repeat(200) }),
  });
  expect(res.status).toBe(201);
});
