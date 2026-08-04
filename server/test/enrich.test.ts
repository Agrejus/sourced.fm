import { test, expect } from "bun:test";
import { enrichDossier, type EnrichDeps, type Gap } from "../src/fetchers/enrich";
import type { Dossier } from "../src/fetchers/types";

// A transcript long enough to clear MIN_SOURCE_CHARS.
const LONG = "the compiler walks the tree and drops the runtime. ".repeat(40);

function dossier(markdown = LONG): Dossier {
  return {
    markdown,
    title: "How It Works",
    sources: [{ title: "the video", url: "https://youtu.be/abc" }],
  };
}

const GAP: Gap = { term: "BPE (byte pair encoding)", why: "never explained", query: "how bpe works" };

function deps(over: Partial<EnrichDeps> = {}): EnrichDeps {
  return {
    findGaps: async () => [GAP],
    research: async (_g, sources) => {
      sources.set("https://ex.com/bpe", { title: "BPE explained", url: "https://ex.com/bpe" });
      return "It merges frequent pairs (Source: Ex, https://ex.com/bpe).";
    },
    ...over,
  };
}

test("a source too short to mine is returned untouched", async () => {
  const d = dossier("too short to bother with");
  let called = false;
  const out = await enrichDossier(d, { sourceNoun: "the video" }, deps({
    findGaps: async () => { called = true; return [GAP]; },
  }));
  expect(out).toBe(d);
  expect(called).toBe(false);
});

test("a source that explains itself is returned untouched", async () => {
  const d = dossier();
  const out = await enrichDossier(d, { sourceNoun: "the video" }, deps({ findGaps: async () => [] }));
  expect(out).toBe(d);
});

test("gap detection failing degrades to the original dossier", async () => {
  const d = dossier();
  const out = await enrichDossier(d, { sourceNoun: "the video" }, deps({
    findGaps: async () => { throw new Error("model down"); },
  }));
  expect(out).toBe(d);
});

test("every concept failing degrades to the original dossier", async () => {
  const d = dossier();
  const out = await enrichDossier(d, { sourceNoun: "the video" }, deps({
    research: async () => { throw new Error("search down"); },
  }));
  expect(out).toBe(d);
});

test("one concept failing does not cost the others", async () => {
  const gaps: Gap[] = [
    { ...GAP, term: "first" },
    { ...GAP, term: "second" },
    { ...GAP, term: "third" },
  ];
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps({
    findGaps: async () => gaps,
    research: async (g, s) => {
      if (g.term === "second") throw new Error("boom");
      s.set(`https://ex.com/${g.term}`, { title: g.term, url: `https://ex.com/${g.term}` });
      return `prose for ${g.term}`;
    },
  }));
  expect(out.markdown).toContain("### first");
  expect(out.markdown).not.toContain("### second");
  expect(out.markdown).toContain("### third");
});

test("empty research prose is skipped rather than appended blank", async () => {
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps({
    findGaps: async () => [{ ...GAP, term: "kept" }, { ...GAP, term: "blank" }],
    research: async (g) => (g.term === "blank" ? "" : "real prose"),
  }));
  expect(out.markdown).toContain("### kept");
  expect(out.markdown).not.toContain("### blank");
});

test("at most six concepts are researched", async () => {
  const many: Gap[] = Array.from({ length: 11 }, (_v, i) => ({ ...GAP, term: `c${i}` }));
  let count = 0;
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps({
    findGaps: async () => many,
    research: async (g) => { count++; return `prose ${g.term}`; },
  }));
  expect(count).toBe(6);
  expect(out.markdown).toContain("### c5");
  expect(out.markdown).not.toContain("### c6");
});

test("the appended section disowns the source, so EXPERT cannot miscredit it", async () => {
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps());
  // The preamble is load-bearing: the script prompt preserves attribution, so
  // without it the dialogue credits the video with research it never contained.
  expect(out.markdown).toContain("is NOT part of the video");
  expect(out.markdown).toContain("never as something the video");
  expect(out.markdown).toContain("Background on concepts the video names but does not explain");
});

test("the source noun follows the fetcher, not the video", async () => {
  const out = await enrichDossier(dossier(), { sourceNoun: "the thread" }, deps());
  expect(out.markdown).toContain("is NOT part of the thread");
  expect(out.markdown).not.toContain("the video names but does not explain");
});

test("the original markdown survives ahead of the appended background", async () => {
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps());
  expect(out.markdown.startsWith(LONG)).toBe(true);
  expect(out.title).toBe("How It Works");
});

test("researched citations join the dossier sources without duplicating", async () => {
  const out = await enrichDossier(dossier(), { sourceNoun: "the video" }, deps({
    research: async (_g, s) => {
      s.set("https://youtu.be/abc", { title: "dupe of the original", url: "https://youtu.be/abc" });
      s.set("https://ex.com/new", { title: "new one", url: "https://ex.com/new" });
      return "prose citing https://ex.com/inline";
    },
  }));
  const urls = out.sources.map((s) => s.url);
  expect(urls).toContain("https://youtu.be/abc");
  expect(urls).toContain("https://ex.com/new");
  // harvestInlineUrls picks up a URL cited in prose but never returned by a tool
  expect(urls).toContain("https://ex.com/inline");
  expect(new Set(urls).size).toBe(urls.length);
});

test("progress is reported per concept", async () => {
  const notes: string[] = [];
  await enrichDossier(
    dossier(),
    { sourceNoun: "the video", onProgress: (n) => notes.push(n) },
    deps({ findGaps: async () => [{ ...GAP, term: "alpha" }, { ...GAP, term: "beta" }] }),
  );
  expect(notes.some((n) => n.includes("alpha"))).toBe(true);
  expect(notes.some((n) => n.includes("beta"))).toBe(true);
  expect(notes.at(-1)).toContain("2 concepts");
});
