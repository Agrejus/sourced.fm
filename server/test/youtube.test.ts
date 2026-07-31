import { test, expect } from "bun:test";
import { classifyInput } from "../src/fetchers/classify";
import { buildYoutubeDossier, youtubeIdFromUrl } from "../src/fetchers/youtube";

test("a YouTube link classifies as youtube, not as an article", () => {
  for (const url of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ]) {
    expect(classifyInput(url)).toEqual({ kind: "youtube", url });
  }
  // everything else still routes the way it did
  expect(classifyInput("https://example.com/post").kind).toBe("article");
  expect(classifyInput("https://x.com/jack/status/20").kind).toBe("tweet");
  expect(classifyInput("solid state batteries").kind).toBe("topic");
});

test("the video id survives every URL shape, and junk is rejected", () => {
  expect(youtubeIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1")).toBe("dQw4w9WgXcQ");
  expect(youtubeIdFromUrl("https://youtu.be/dQw4w9WgXcQ?t=30")).toBe("dQw4w9WgXcQ");
  expect(youtubeIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youtubeIdFromUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  expect(youtubeIdFromUrl("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  // not a video
  expect(youtubeIdFromUrl("https://www.youtube.com/@CompilerCorner")).toBeNull();
  expect(youtubeIdFromUrl("https://www.youtube.com/watch?v=short")).toBeNull();
  expect(youtubeIdFromUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  expect(youtubeIdFromUrl("not a url")).toBeNull();
});

test("the dossier records how the words were obtained", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const base = {
    title: "How a compiler erases a runtime",
    author: "Compiler Corner",
    durationSec: 1975,
    description: "A walk through the passes that remove the runtime.",
    transcript: "so the compiler walks the tree and drops the runtime",
  };

  const captions = buildYoutubeDossier({ ...base, source: "captions" }, url);
  expect(captions.title).toBe("How a compiler erases a runtime");
  expect(captions.sources).toEqual([
    { title: "How a compiler erases a runtime (Compiler Corner)", url },
  ]);
  expect(captions.markdown).toContain("YouTube video by Compiler Corner · 33 minutes");
  expect(captions.markdown).toContain("caption track");
  expect(captions.markdown).toContain("do not quote it as exact speech");
  expect(captions.markdown).toContain("## Description as published");
  expect(captions.markdown).toContain("## Transcript");

  // a machine transcript carries a different, stronger caveat
  const whisper = buildYoutubeDossier({ ...base, source: "whisper" }, url);
  expect(whisper.markdown).toContain("had no captions");
  expect(whisper.markdown).toContain("transcribing the audio");
  expect(whisper.markdown).not.toContain("caption track");
});

test("a video with no author or duration still produces a sane dossier", () => {
  const d = buildYoutubeDossier(
    { title: "Untitled", author: "", durationSec: 0, description: "", source: "captions", transcript: "words" },
    "https://youtu.be/dQw4w9WgXcQ",
  );
  expect(d.markdown).toContain("YouTube video\n");
  expect(d.markdown).not.toContain("## Description as published");
  expect(d.sources[0]!.title).toBe("Untitled");
});
