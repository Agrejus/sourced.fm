import type { SourceInput } from "./types";

// Thrown for input that is not a valid submission at all (empty / too long).
// The submit route turns this into a 400.
export class ClassifyError extends Error {}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

const TWEET_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "mobile.twitter.com",
  "vxtwitter.com",
  "fxtwitter.com",
]);

// Deliberately dumb so it is deterministic: a body is a URL ONLY when the whole
// trimmed string is a single token starting with http(s):// or www. Anything
// else — including leading prose before a link — is a topic.
export function classifyInput(text: string): SourceInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new ClassifyError("empty input");
  if (trimmed.length > 500) throw new ClassifyError("input too long (>500 chars)");

  const lower = trimmed.toLowerCase();
  const hasWhitespace = /\s/.test(trimmed);
  let urlString: string | null = null;
  if ((lower.startsWith("http://") || lower.startsWith("https://")) && !hasWhitespace) {
    urlString = trimmed;
  } else if (lower.startsWith("www.") && !hasWhitespace) {
    urlString = "https://" + trimmed;
  }

  if (urlString) {
    let host: string;
    try {
      host = new URL(urlString).hostname.toLowerCase();
    } catch {
      return { kind: "topic", topic: trimmed };
    }
    const isTweet =
      TWEET_HOSTS.has(host) ||
      host.endsWith(".x.com") ||
      host.endsWith(".twitter.com");
    if (isTweet) return { kind: "tweet", url: urlString };
    // A YouTube link is read as a transcript, not scraped as an article.
    if (YOUTUBE_HOSTS.has(host)) return { kind: "youtube", url: urlString };
    return { kind: "article", url: urlString };
  }

  return { kind: "topic", topic: trimmed };
}
