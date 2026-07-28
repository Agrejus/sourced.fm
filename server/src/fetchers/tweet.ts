import type { Dossier, FetchResult, SourceFetcher, SourceInput } from "./types";
import { fetchArticleUrl } from "./firecrawl";

// fxtwitter resolver — X blocks scrapers, so we never fetch the page.
// VERIFIED shape (2026-07-25, GET https://api.fxtwitter.com/status/20):
//   { code: 200, message: "OK", tweet: {
//       url, id, text,
//       author: { name, screen_name },
//       replying_to: <screen_name|null>, replying_to_status: <id|null>,
//       quote?: { text, author: { name, screen_name } } } }
// Thread expansion walks replying_to_status backwards while the author stays
// the same (bounded), which is what the resolver exposes; server also sees
// fixture server/test/fixtures/fxtwitter.json in the unit test.
//
// X native long-form "Articles" (VERIFIED 2026-07-28, status 2078419526354378975)
// carry an EMPTY `text` and instead expose the whole post under `article`:
//   article: { title, preview_text, content: { blocks: [{ text, type, data }] } }
// where `type` is Draft.js ("header-one", "unstyled", "blockquote",
// "unordered-list-item", "ordered-list-item", "code-block", "atomic"). We render
// those blocks to markdown — the resolver is the only way in, X walls the page.
const FX_BASE = "https://api.fxtwitter.com";
const MAX_THREAD = 25;

export interface FxArticleBlock {
  text?: string;
  type?: string;
  data?: { urls?: { text?: string }[] } | null;
}
export interface FxArticle {
  title: string;
  preview_text?: string;
  content?: { blocks?: FxArticleBlock[] } | null;
}

export interface FxTweet {
  url: string;
  id: string;
  text: string;
  author: { name: string; screen_name: string };
  replying_to: string | null;
  replying_to_status: string | null;
  quote?: { text: string; author: { name: string; screen_name: string } } | null;
  article?: FxArticle | null;
}

// Draft.js content blocks → markdown. Only the block types X actually emits
// are mapped; unknown types fall back to their plain text so nothing is lost.
export function articleBlocksToMarkdown(blocks: FxArticleBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const text = (b.text ?? "").trim();
    switch (b.type) {
      case "header-one":
        if (text) out.push(`## ${text}`);
        break;
      case "header-two":
        if (text) out.push(`### ${text}`);
        break;
      case "header-three":
        if (text) out.push(`#### ${text}`);
        break;
      case "blockquote":
        if (text) out.push(`> ${text}`);
        break;
      case "unordered-list-item":
        if (text) out.push(`- ${text}`);
        break;
      case "ordered-list-item":
        if (text) out.push(`1. ${text}`);
        break;
      case "code-block":
        if (text) out.push("```\n" + text + "\n```");
        break;
      case "atomic": {
        // Embeds (quoted tweets, media) surface only as a URL, if any.
        const url = b.data?.urls?.find((u) => u.text)?.text;
        if (url) out.push(url);
        break;
      }
      default:
        if (text) out.push(text);
    }
  }
  return out.filter(Boolean).join("\n\n");
}

export function tweetIdFromUrl(url: string): string | null {
  try {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      if (/^\d+$/.test(segments[i]!)) return segments[i]!;
    }
    return null;
  } catch {
    return null;
  }
}

function firstNonTwitterUrl(text: string): string | null {
  const matches = text.match(/https?:\/\/[^\s]+/g) ?? [];
  for (const raw of matches) {
    const url = raw.replace(/[.,)]+$/, "");
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (
      host === "t.co" ||
      host.endsWith("twitter.com") ||
      host.endsWith("x.com") ||
      host.endsWith("fxtwitter.com") ||
      host.endsWith("vxtwitter.com")
    ) {
      continue;
    }
    return url;
  }
  return null;
}

// Pure assembly of the frozen dossier from a resolved thread (oldest→newest),
// plus optional linked-article markdown. No network here.
export function buildTweetDossier(
  thread: FxTweet[],
  linkedArticle: { markdown: string; url: string } | null,
): Dossier {
  const head = thread[0]!;
  const author = head.author;

  // X native long-form Article: the tweet `text` is empty and the real post
  // lives in `article`. Render it as the dossier — the article IS the source.
  const article = head.article;
  if (article && article.content?.blocks?.length) {
    const body = articleBlocksToMarkdown(article.content.blocks);
    const md = [
      `# ${article.title}`,
      "",
      `An X Article by ${author.name} (@${author.screen_name}).`,
      "",
      body,
    ]
      .join("\n")
      .trim();
    return {
      markdown: md,
      title: article.title,
      sources: [{ title: article.title, url: head.url }],
    };
  }

  const lines: string[] = [`# ${author.name} (@${author.screen_name}) on X`, ""];
  lines.push(thread.map((t) => t.text).join("\n\n"));

  const quote = head.quote ?? thread.map((t) => t.quote).find(Boolean) ?? null;
  if (quote) {
    lines.push("", "## Quoted tweet", `${quote.author.name} (@${quote.author.screen_name}): ${quote.text}`);
  }

  const sources = [{ title: `${author.name} (@${author.screen_name}) on X`, url: head.url }];
  if (linkedArticle) {
    lines.push("", "## Linked article", linkedArticle.markdown);
    sources.push({ title: "Linked article", url: linkedArticle.url });
  }

  return {
    markdown: lines.join("\n").trim(),
    title: `${author.name} on X`,
    sources,
  };
}

async function resolve(id: string): Promise<FxTweet | null> {
  const resp = await fetch(`${FX_BASE}/status/${id}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!resp.ok) return null;
  const json = (await resp.json()) as { code?: number; tweet?: FxTweet };
  if (json.code !== 200 || !json.tweet) return null;
  return json.tweet;
}

export const tweetFetcher: SourceFetcher = {
  kind: "tweet",
  async fetch(input: SourceInput): Promise<FetchResult> {
    if (input.kind !== "tweet") {
      return { ok: false, error: { code: "http", message: "tweet fetcher got non-tweet input" } };
    }
    const id = tweetIdFromUrl(input.url);
    if (!id) {
      return { ok: false, error: { code: "http", message: `no tweet id in ${input.url}` } };
    }

    let head: FxTweet | null;
    try {
      head = await resolve(id);
    } catch (e) {
      return { ok: false, error: { code: "http", message: e instanceof Error ? e.message : String(e) } };
    }
    if (!head) {
      return { ok: false, error: { code: "http", message: "fxtwitter resolver failed" } };
    }

    // Walk the same-author reply chain backwards, then order oldest→newest.
    const chain: FxTweet[] = [head];
    let cursor = head;
    for (let i = 0; i < MAX_THREAD; i++) {
      if (!cursor.replying_to_status || cursor.replying_to !== head.author.screen_name) break;
      let parent: FxTweet | null;
      try {
        parent = await resolve(cursor.replying_to_status);
      } catch {
        break;
      }
      if (!parent || parent.author.screen_name !== head.author.screen_name) break;
      chain.unshift(parent);
      cursor = parent;
    }

    const linkUrl = firstNonTwitterUrl(head.text);
    let linkedArticle: { markdown: string; url: string } | null = null;
    if (linkUrl) {
      const article = await fetchArticleUrl(linkUrl);
      if (article.ok) linkedArticle = { markdown: article.value.markdown, url: linkUrl };
      // On article failure: skip silently (design.md §2.3).
    }

    return { ok: true, value: buildTweetDossier(chain, linkedArticle) };
  },
};
