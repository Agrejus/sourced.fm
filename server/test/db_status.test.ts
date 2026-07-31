import { test, expect } from "bun:test";
import { createAccessors, createDb } from "../src/db";
import type { SourceInput } from "../src/fetchers/types";

function fresh() {
  return createAccessors(createDb(":memory:"));
}

const ARTICLE: SourceInput = { kind: "article", url: "https://example.com/a" };

test("insertEpisode starts submitted with zero attempts", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  expect(ep.status).toBe("submitted");
  expect(ep.attempts).toBe(0);
  expect(JSON.parse(ep.source_json)).toEqual(ARTICLE);
});

test("claimNextPipelineEpisode returns the oldest due episode", () => {
  const a = fresh();
  const first = a.insertEpisode(ARTICLE, 1000);
  a.insertEpisode(ARTICLE, 2000);
  const claimed = a.claimNextPipelineEpisode(5000);
  expect(claimed?.id).toBe(first.id);
});

test("claimNext skips episodes whose backoff has not elapsed", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.scheduleRetry(ep.id, 1, 9000, 1000);
  expect(a.claimNextPipelineEpisode(5000)).toBeNull();
  expect(a.claimNextPipelineEpisode(9000)?.id).toBe(ep.id);
});

test("updateEpisodeStage advances forward and applies the patch", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { dossier_json: "{}", title: "T" }, 2000);
  const after = a.getEpisode(ep.id)!;
  expect(after.status).toBe("sourced");
  expect(after.title).toBe("T");
  expect(after.dossier_json).toBe("{}");
});

test("updateEpisodeStage throws when the prior status does not match", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  // Prior is 'submitted', not 'verified' -> refuse.
  expect(() => a.updateEpisodeStage(ep.id, "verified", "synthesizing", {}, 2000)).toThrow();
  expect(a.getEpisode(ep.id)!.status).toBe("submitted");
});

test("re-running a stage (or any stale prior) is refused by the guard", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", {}, 2000);
  // The source stage running twice would re-assert prior 'submitted' — refused
  // because the current status is already 'sourced'. This is the same guard
  // that prevents any backwards write.
  expect(() => a.updateEpisodeStage(ep.id, "submitted", "sourced", {}, 3000)).toThrow();
  expect(a.getEpisode(ep.id)!.status).toBe("sourced");
});

test("failEpisode records stage + message", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.failEpisode(ep.id, "source", "boom", 2000);
  const after = a.getEpisode(ep.id)!;
  expect(after.status).toBe("failed");
  expect(JSON.parse(after.error_json!)).toEqual({ stage: "source", message: "boom" });
});

test("failed and ready episodes are not claimable", () => {
  const a = fresh();
  const failed = a.insertEpisode(ARTICLE, 1000);
  a.failEpisode(failed.id, "source", "x", 1000);
  const ready = a.insertEpisode(ARTICLE, 2000);
  a.updateEpisodeStage(ready.id, "submitted", "sourced", {}, 2000);
  a.updateEpisodeStage(ready.id, "sourced", "scripted", {}, 2000);
  a.updateEpisodeStage(ready.id, "scripted", "verified", {}, 2000);
  a.updateEpisodeStage(ready.id, "verified", "synthesizing", {}, 2000);
  a.updateEpisodeStage(ready.id, "synthesizing", "ready", {}, 2000);
  expect(a.claimNextPipelineEpisode(9999)).toBeNull();
});

test("resetStuckSynthesizing moves synthesizing back to verified and bumps attempts", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", {}, 1000);
  a.updateEpisodeStage(ep.id, "sourced", "scripted", {}, 1000);
  a.updateEpisodeStage(ep.id, "scripted", "verified", {}, 1000);
  a.updateEpisodeStage(ep.id, "verified", "synthesizing", {}, 1000);
  const n = a.resetStuckSynthesizing(2000);
  expect(n).toBe(1);
  const after = a.getEpisode(ep.id)!;
  expect(after.status).toBe("verified");
  expect(after.attempts).toBe(1);
});

test("insertChat / listChats round-trip in order", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.insertChat(ep.id, "user", "q1", 1234, 1000);
  a.insertChat(ep.id, "assistant", "a1", null, 1001);
  const chats = a.listChats(ep.id);
  expect(chats.map((c) => c.role)).toEqual(["user", "assistant"]);
  expect(chats[0]!.position_ms).toBe(1234);
});

test("setEpisodeListened marks, clears, and reports a missing episode", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  expect(a.getEpisode(ep.id)!.listened_at).toBeNull();

  expect(a.setEpisodeListened(ep.id, 5000, 5000)).toBe(true);
  expect(a.getEpisode(ep.id)!.listened_at).toBe(5000);

  // Clearing the mark puts it back in the "to listen" pile.
  expect(a.setEpisodeListened(ep.id, null, 6000)).toBe(true);
  expect(a.getEpisode(ep.id)!.listened_at).toBeNull();

  expect(a.setEpisodeListened("no-such-id", 5000, 5000)).toBe(false);
});

test("listened state survives the pipeline advancing the episode", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.setEpisodeListened(ep.id, 5000, 5000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { title: "T" }, 6000);
  expect(a.getEpisode(ep.id)!.listened_at).toBe(5000);
});

test("setEpisodePosition stores, clamps to duration, and floors at zero", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  expect(a.getEpisode(ep.id)!.position_ms).toBe(0);

  expect(a.setEpisodePosition(ep.id, 42_500, 2000)).toBe(true);
  expect(a.getEpisode(ep.id)!.position_ms).toBe(42_500);

  a.setEpisodePosition(ep.id, -5, 2000);
  expect(a.getEpisode(ep.id)!.position_ms).toBe(0);

  // With a known duration, an overshoot clamps to the end of the audio.
  a.updateEpisodeStage(ep.id, "submitted", "sourced", {}, 1);
  a.updateEpisodeStage(ep.id, "sourced", "scripted", {}, 1);
  a.updateEpisodeStage(ep.id, "scripted", "verified", {}, 1);
  a.updateEpisodeStage(ep.id, "verified", "synthesizing", {}, 1);
  a.updateEpisodeStage(ep.id, "synthesizing", "ready", { duration_ms: 60_000 }, 1);
  a.setEpisodePosition(ep.id, 99_999, 3000);
  expect(a.getEpisode(ep.id)!.position_ms).toBe(60_000);

  expect(a.setEpisodePosition("no-such-id", 1000, 3000)).toBe(false);
});

test("marking listened clears the saved position; unmarking leaves it cleared", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.setEpisodePosition(ep.id, 30_000, 2000);

  a.setEpisodeListened(ep.id, 5000, 5000);
  const listened = a.getEpisode(ep.id)!;
  expect(listened.listened_at).toBe(5000);
  expect(listened.position_ms).toBe(0);

  a.setEpisodeListened(ep.id, null, 6000);
  const cleared = a.getEpisode(ep.id)!;
  expect(cleared.listened_at).toBeNull();
  expect(cleared.position_ms).toBe(0);
});

test("position survives the pipeline advancing the episode", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.setEpisodePosition(ep.id, 20_000, 2000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { title: "T" }, 3000);
  expect(a.getEpisode(ep.id)!.position_ms).toBe(20_000);
});

test("setEpisodeNote records stage progress and clears it", () => {
  const a = fresh();
  const ep = a.insertEpisode(ARTICLE, 1000);
  expect(a.getEpisode(ep.id)!.stage_note).toBeNull();

  a.setEpisodeNote(ep.id, "researching 2 of 5: how it works", 2000);
  expect(a.getEpisode(ep.id)!.stage_note).toBe("researching 2 of 5: how it works");

  a.setEpisodeNote(ep.id, null, 3000);
  expect(a.getEpisode(ep.id)!.stage_note).toBeNull();
});
