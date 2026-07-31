import { test, expect } from "bun:test";
import { extractSeedUrls, PlanSchema } from "../src/fetchers/deepresearch";
import { fetcherFor } from "../src/fetchers";
import { harvestInlineUrls, type SourceMap } from "../src/fetchers/webagent";

test("extractSeedUrls finds every link in an assignment and dedupes them", () => {
  const brief = `Research solid-state batteries.
Start from https://example.com/explainer and also https://other.org/paper?id=7.
The first link again: https://example.com/explainer`;
  expect(extractSeedUrls(brief)).toEqual([
    "https://example.com/explainer",
    "https://other.org/paper?id=7",
  ]);
});

test("extractSeedUrls strips trailing punctuation and ignores non-links", () => {
  expect(extractSeedUrls("see https://example.com/a, then https://example.com/b.")).toEqual([
    "https://example.com/a",
    "https://example.com/b",
  ]);
  expect(extractSeedUrls("no links here at all, just prose about x.com")).toEqual([]);
});

test("an assignment with no links is still a valid research input", () => {
  expect(extractSeedUrls("Research how tariffs move grocery prices. Skip the politics.")).toEqual([]);
});

test("fetcherFor routes the research kind to the deep research fetcher", () => {
  expect(fetcherFor("research").kind).toBe("research");
  expect(fetcherFor("topic").kind).toBe("topic");
  expect(fetcherFor("article").kind).toBe("article");
});

test("the deep research fetcher refuses input of another kind", async () => {
  const result = await fetcherFor("research").fetch({ kind: "topic", topic: "x" });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("http");
});

test("harvestInlineUrls collects cited links without duplicating known sources", () => {
  const sources: SourceMap = new Map([["https://a.com/1", { title: "A", url: "https://a.com/1" }]]);
  harvestInlineUrls("As reported (Source: A, https://a.com/1) and (Source: B, https://b.com/2).", sources);
  expect([...sources.keys()]).toEqual(["https://a.com/1", "https://b.com/2"]);
  expect(sources.get("https://a.com/1")!.title).toBe("A"); // the known title is kept
});

test("PlanSchema accepts a well-formed plan and rejects thin or malformed ones", () => {
  const good = {
    title: "Solid-state batteries and the 2027 production claims",
    angle: "Whether the manufacturing problems are solved or just moved.",
    questions: [
      "What is a solid-state battery and how does it differ from lithium-ion?",
      "Why is manufacturing at scale the hard part?",
      "What have the pilot lines actually produced so far?",
      "Which 2027 claims are credible and which are marketing?",
    ],
  };
  expect(PlanSchema.parse(good).questions).toHaveLength(4);

  // Too few questions to cover a topic properly.
  expect(() => PlanSchema.parse({ ...good, questions: good.questions.slice(0, 2) })).toThrow();
  // A runaway question list.
  expect(() => PlanSchema.parse({ ...good, questions: Array(9).fill("a long enough question?") })).toThrow();
  // Missing angle.
  expect(() => PlanSchema.parse({ title: good.title, questions: good.questions })).toThrow();
  // A title that is really a paragraph.
  expect(() => PlanSchema.parse({ ...good, title: "x".repeat(161) })).toThrow();
});
