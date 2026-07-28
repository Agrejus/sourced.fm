import { test, expect } from "bun:test";
import { parseFirecrawl } from "../src/fetchers/firecrawl";
import {
  articleBlocksToMarkdown,
  buildTweetDossier,
  tweetIdFromUrl,
  type FxTweet,
} from "../src/fetchers/tweet";
import firecrawlFixture from "./fixtures/firecrawl.json";
import fxFixture from "./fixtures/fxtwitter.json";

test("parseFirecrawl builds a dossier from the recorded fixture", () => {
  const result = parseFirecrawl(firecrawlFixture, "https://example.com/bridge-engineering");
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.value.title).toBe("The Quiet Revolution in Bridge Engineering");
    expect(result.value.sources).toEqual([
      { title: "The Quiet Revolution in Bridge Engineering", url: "https://example.com/bridge-engineering" },
    ]);
    expect(result.value.markdown.length).toBeGreaterThan(500);
  }
});

test("parseFirecrawl rejects near-empty markdown", () => {
  const result = parseFirecrawl({ success: true, data: { markdown: "too short" } }, "u");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("empty");
});

test("parseFirecrawl treats a failed scrape as http error", () => {
  const result = parseFirecrawl({ success: false }, "u");
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe("http");
});

test("tweetIdFromUrl extracts the last numeric segment", () => {
  expect(tweetIdFromUrl("https://x.com/jack/status/20")).toBe("20");
  expect(tweetIdFromUrl("https://x.com/jack/status/20?s=21")).toBe("20");
  expect(tweetIdFromUrl("https://x.com/jack")).toBeNull();
});

test("buildTweetDossier renders a single tweet (fxtwitter fixture)", () => {
  const tweet = (fxFixture as { tweet: FxTweet }).tweet;
  const dossier = buildTweetDossier([tweet], null);
  expect(dossier.markdown.startsWith("# jack (@jack) on X")).toBe(true);
  expect(dossier.markdown).toContain("just setting up my twttr");
  expect(dossier.sources).toEqual([{ title: "jack (@jack) on X", url: "https://x.com/jack/status/20" }]);
});

test("buildTweetDossier renders a thread, quote, and linked article", () => {
  const a: FxTweet = {
    url: "https://x.com/n/status/1",
    id: "1",
    text: "First point, see https://example.com/deep-dive for more",
    author: { name: "Nora", screen_name: "nora" },
    replying_to: null,
    replying_to_status: null,
    quote: { text: "the original claim", author: { name: "Sam", screen_name: "sam" } },
  };
  const b: FxTweet = {
    url: "https://x.com/n/status/2",
    id: "2",
    text: "Second point that follows.",
    author: { name: "Nora", screen_name: "nora" },
    replying_to: "nora",
    replying_to_status: "1",
  };
  const dossier = buildTweetDossier([a, b], { markdown: "ARTICLE BODY", url: "https://example.com/deep-dive" });
  expect(dossier.markdown).toContain("First point");
  expect(dossier.markdown).toContain("Second point that follows.");
  expect(dossier.markdown).toContain("## Quoted tweet");
  expect(dossier.markdown).toContain("Sam (@sam): the original claim");
  expect(dossier.markdown).toContain("## Linked article");
  expect(dossier.markdown).toContain("ARTICLE BODY");
  expect(dossier.sources).toEqual([
    { title: "Nora (@nora) on X", url: "https://x.com/n/status/1" },
    { title: "Linked article", url: "https://example.com/deep-dive" },
  ]);
});

test("articleBlocksToMarkdown maps Draft.js block types", () => {
  const md = articleBlocksToMarkdown([
    { type: "header-one", text: "The Big Idea" },
    { type: "unstyled", text: "A plain paragraph." },
    { type: "blockquote", text: "a quote" },
    { type: "unordered-list-item", text: "a bullet" },
    { type: "atomic", text: " ", data: { urls: [{ text: "https://example.com/embed" }] } },
    { type: "unknown-future-type", text: "kept as text" },
    { type: "unstyled", text: "   " },
  ]);
  expect(md).toBe(
    "## The Big Idea\n\nA plain paragraph.\n\n> a quote\n\n- a bullet\n\nhttps://example.com/embed\n\nkept as text",
  );
});

test("buildTweetDossier renders an X native Article (empty text, article field)", () => {
  const tweet: FxTweet = {
    url: "https://x.com/IntuitMachine/status/2078419526354378975",
    id: "2078419526354378975",
    text: "",
    author: { name: "Carlos E. Perez", screen_name: "IntuitMachine" },
    replying_to: null,
    replying_to_status: null,
    article: {
      title: "From Loop Engineering to Graph Engineering?",
      content: {
        blocks: [
          { type: "header-one", text: "What the shift is really about" },
          { type: "unstyled", text: "Loops optimize a single number; graphs model relationships." },
        ],
      },
    },
  };
  const dossier = buildTweetDossier([tweet], null);
  expect(dossier.title).toBe("From Loop Engineering to Graph Engineering?");
  expect(dossier.markdown.startsWith("# From Loop Engineering to Graph Engineering?")).toBe(true);
  expect(dossier.markdown).toContain("An X Article by Carlos E. Perez (@IntuitMachine).");
  expect(dossier.markdown).toContain("## What the shift is really about");
  expect(dossier.markdown).toContain("Loops optimize a single number");
  // The empty-tweet "handle" header must NOT be what we ship.
  expect(dossier.markdown).not.toContain("Carlos E. Perez (@IntuitMachine) on X");
  expect(dossier.sources).toEqual([
    { title: "From Loop Engineering to Graph Engineering?", url: tweet.url },
  ]);
});
