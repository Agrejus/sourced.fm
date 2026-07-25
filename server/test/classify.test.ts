import { test, expect } from "bun:test";
import { classifyInput, ClassifyError } from "../src/fetchers/classify";

test("required classification cases (spec §2.2)", () => {
  expect(classifyInput("AI")).toEqual({ kind: "topic", topic: "AI" });
  expect(classifyInput("Node.js")).toEqual({ kind: "topic", topic: "Node.js" });
  expect(classifyInput("https://x.com/u/status/123")).toEqual({
    kind: "tweet",
    url: "https://x.com/u/status/123",
  });
  expect(classifyInput("www.example.com/post")).toEqual({
    kind: "article",
    url: "https://www.example.com/post",
  });
  // Leading prose before a link is NOT a URL.
  expect(classifyInput("check out https://foo.com")).toEqual({
    kind: "topic",
    topic: "check out https://foo.com",
  });
});

test("twitter/x hosts classify as tweet", () => {
  for (const url of [
    "https://twitter.com/a/status/1",
    "https://mobile.twitter.com/a/status/1",
    "https://vxtwitter.com/a/status/1",
    "https://fxtwitter.com/a/status/1",
    "https://x.com/a/status/1",
  ]) {
    expect(classifyInput(url).kind).toBe("tweet");
  }
});

test("other URLs classify as article", () => {
  expect(classifyInput("https://kubernetes.io/docs").kind).toBe("article");
  expect(classifyInput("HTTPS://Example.COM/Post").kind).toBe("article");
});

test("empty and over-long inputs are rejected", () => {
  expect(() => classifyInput("   ")).toThrow(ClassifyError);
  expect(() => classifyInput("x".repeat(501))).toThrow(ClassifyError);
});
