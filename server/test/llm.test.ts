import { test, expect } from "bun:test";
import { createAccessors, createDb } from "../src/db";
import type { Dossier, SourceInput } from "../src/fetchers/types";
import type { Script } from "../src/domain";
import { mmss, groundingBlock, lastNChatTurns, createAsk } from "../src/api/ask";
import { scriptStage } from "../src/pipeline/script";
import { factcheckStage } from "../src/pipeline/factcheck";
import { localSpeech } from "../src/speech/local";

// Live LLM tests run only with a real key; otherwise they skip cleanly so
// `bun test` stays green without network/metered calls.
const KEY = process.env.OLLAMA_API_KEY;
const LIVE = !!KEY && KEY !== "test-key";
const live = test.skipIf(!LIVE);

const NOW = () => 1000;

// The pipeline worker retries a stage up to 5× on error (schema miss, transient
// model output). Mirror that here so these live tests exercise the stage within
// its production retry envelope instead of demanding a first-shot success.
async function withRetry(fn: () => Promise<void>, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

const BRIDGE_MD = `# The Quiet Revolution in Bridge Engineering

The 1940 collapse of the Tacoma Narrows Bridge taught engineers that a steady
wind could drive a slender deck into destructive oscillation through aeroelastic
flutter. Modern suspension bridges fight this on three fronts: the deck is shaped
in a wind tunnel so air separates cleanly instead of forming alternating
vortices; tuned mass dampers swing out of phase with the structure to bleed away
energy; and active control systems sense motion and adjust in real time. The
Akashi Kaikyo Bridge in Japan spans nearly two kilometres between its towers and
rode out the Kobe earthquake during construction with only minor realignment.`;

const BRIDGE_DOSSIER: Dossier = {
  markdown: BRIDGE_MD,
  title: "The Quiet Revolution in Bridge Engineering",
  sources: [{ title: "Bridge Engineering", url: "https://example.com/bridges" }],
};

const ARTICLE: SourceInput = { kind: "article", url: "https://example.com/bridges" };

function seeded() {
  return createAccessors(createDb(":memory:"));
}

// --- pure helpers (always run) ---

test("mmss zero-pads seconds and rolls hours into minutes", () => {
  expect(mmss(0)).toBe("0:00");
  expect(mmss(754000)).toBe("12:34");
  expect(mmss(4510000)).toBe("75:10");
});

test("groundingBlock follows the frozen template", () => {
  const script: Script = {
    title: "T",
    segments: [
      { idx: 0, speaker: "HOST", text: "Why do bridges hum?", startMs: 0 },
      { idx: 1, speaker: "EXPERT", text: "Vortex shedding.", startMs: 5000 },
    ],
  };
  const block = groundingBlock(BRIDGE_DOSSIER, script);
  expect(block).toContain("## Sources");
  expect(block).toContain("- Bridge Engineering: https://example.com/bridges");
  expect(block).toContain("## Source dossier");
  expect(block).toContain("## Episode transcript");
  expect(block).toContain("[0:00] HOST: Why do bridges hum?");
  expect(block).toContain("[0:05] EXPERT: Vortex shedding.");
  expect(block).toContain("## Answer rules");
});

test("lastNChatTurns drops a leading assistant turn", () => {
  const a = seeded();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.insertChat(ep.id, "assistant", "a0", null, 1);
  a.insertChat(ep.id, "user", "u1", 0, 2);
  a.insertChat(ep.id, "assistant", "a1", null, 3);
  const turns = lastNChatTurns(a, ep.id, 6);
  expect(turns[0]!.role).toBe("user");
  expect(turns).toHaveLength(2);
});

// --- live LLM stages (real key required) ---

live("script stage produces a valid script from a dossier", async () => {
  const a = seeded();
  const ep = a.insertEpisode(ARTICLE, 1000);
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { dossier_json: JSON.stringify(BRIDGE_DOSSIER) }, 1000);

  await withRetry(() => scriptStage({ accessors: a, now: NOW }).run(a.getEpisode(ep.id)!));

  const after = a.getEpisode(ep.id)!;
  expect(after.status).toBe("scripted");
  const script = JSON.parse(after.script_json!) as Script;
  expect(script.segments.length).toBeGreaterThanOrEqual(6);
  expect(script.segments.length).toBeLessThanOrEqual(400);
  const speakers = new Set(script.segments.map((s) => s.speaker));
  expect(speakers.has("HOST")).toBe(true);
  expect(speakers.has("EXPERT")).toBe(true);
  expect(after.title).toBe(script.title);

  // fact-check that same script -> verified, >=1 claim
  await withRetry(() => factcheckStage({ accessors: a, now: NOW }).run(a.getEpisode(ep.id)!));
  const fc = a.getEpisode(ep.id)!;
  expect(fc.status).toBe("verified");
  const claims = JSON.parse(fc.factcheck_json!).claims;
  expect(claims.length).toBeGreaterThanOrEqual(1);
}, 300_000);

live("fact-check flags a planted false claim and returns a revision", async () => {
  const a = seeded();
  const ep = a.insertEpisode(ARTICLE, 1000);
  const poisoned: Script = {
    title: "Bridges",
    segments: [
      { idx: 0, speaker: "HOST", text: "Here's why bridges can shake themselves apart in the wind." },
      { idx: 1, speaker: "EXPERT", text: "It comes down to vortex shedding from the deck in a steady wind." },
      { idx: 2, speaker: "HOST", text: "And there's a famous example, right?" },
      { idx: 3, speaker: "EXPERT", text: "The Tacoma Narrows Bridge, which was exactly nine thousand feet long, collapsed in nineteen sixty-two." },
      { idx: 4, speaker: "HOST", text: "So how do engineers stop it now?" },
      { idx: 5, speaker: "EXPERT", text: "Three ways: shape the deck, add tuned mass dampers, and use active control. Those are the takeaways." },
    ],
  };
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { dossier_json: JSON.stringify(BRIDGE_DOSSIER) }, 1000);
  a.updateEpisodeStage(ep.id, "sourced", "scripted", { script_json: JSON.stringify(poisoned) }, 1000);

  await withRetry(() => factcheckStage({ accessors: a, now: NOW }).run(a.getEpisode(ep.id)!));

  const after = a.getEpisode(ep.id)!;
  expect(after.status).toBe("verified");
  const claims = JSON.parse(after.factcheck_json!).claims as { verdict: string }[];
  expect(claims.some((c) => c.verdict !== "supported")).toBe(true);
  // The planted "1962 / nine thousand feet" claim should have been revised out.
  expect(after.script_json).not.toBe(JSON.stringify(poisoned));
}, 300_000);

live("ask-text answers and writes two chat rows per turn", async () => {
  const a = seeded();
  const ep = a.insertEpisode(ARTICLE, 1000);
  const script: Script = {
    title: "Bridges",
    segments: [
      { idx: 0, speaker: "HOST", text: "Why do suspension bridges shake in the wind?", startMs: 0 },
      { idx: 1, speaker: "EXPERT", text: "Vortex shedding drives aeroelastic flutter.", startMs: 6000 },
      { idx: 2, speaker: "HOST", text: "How do engineers fix it?", startMs: 12000 },
      { idx: 3, speaker: "EXPERT", text: "Deck shaping, tuned mass dampers, and active control.", startMs: 18000 },
      { idx: 4, speaker: "HOST", text: "Any famous failure?", startMs: 24000 },
      { idx: 5, speaker: "EXPERT", text: "The Tacoma Narrows Bridge in 1940. Three takeaways: shaping, dampers, control.", startMs: 30000 },
    ],
  };
  a.updateEpisodeStage(ep.id, "submitted", "sourced", { dossier_json: JSON.stringify(BRIDGE_DOSSIER) }, 1000);
  a.updateEpisodeStage(ep.id, "sourced", "scripted", { script_json: JSON.stringify(script) }, 1000);
  a.updateEpisodeStage(ep.id, "scripted", "verified", {}, 1000);

  const ask = createAsk({ accessors: a, speech: localSpeech, now: NOW });

  const first = await ask.answer(ep.id, "What causes the shaking?", 8000);
  expect(first.length).toBeGreaterThan(0);
  const second = await ask.answer(ep.id, "And how is it prevented?", 15000);
  expect(second.length).toBeGreaterThan(0);
  expect(a.listChats(ep.id)).toHaveLength(4); // 2 turns per ask
}, 180_000);
