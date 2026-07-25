import { config } from "../config";
import type { FetchResult, SourceFetcher, SourceInput } from "./types";

const FIRECRAWL_TIMEOUT_MS = 60_000;
const MIN_MARKDOWN_CHARS = 500;

// Self-hosted Firecrawl v2 /scrape returns { success, data: { markdown, metadata } }.
// Response shape is VERIFIED against the running instance in M5; until then the
// unit test drives this parser with server/test/fixtures/firecrawl.json.
export function parseFirecrawl(json: unknown, url: string): FetchResult {
  const body = json as {
    success?: boolean;
    data?: { markdown?: string; metadata?: { title?: string } };
  };
  if (!body || body.success === false || !body.data) {
    return { ok: false, error: { code: "http", message: `firecrawl returned no data for ${url}` } };
  }
  const markdown = body.data.markdown ?? "";
  if (markdown.trim().length < MIN_MARKDOWN_CHARS) {
    return {
      ok: false,
      error: { code: "empty", message: `markdown under ${MIN_MARKDOWN_CHARS} chars` },
    };
  }
  const title = body.data.metadata?.title || url;
  return { ok: true, value: { markdown, title, sources: [{ title, url }] } };
}

// Shared by the article fetcher and by tweet.ts (linked-article fetch).
export async function fetchArticleUrl(url: string): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIRECRAWL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${config.firecrawlApiUrl}/v2/scrape`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.firecrawlApiKey}`,
      },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: true }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: { code: "http", message: `firecrawl HTTP ${resp.status}` } };
    }
    return parseFirecrawl(await resp.json(), url);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const aborted = e instanceof Error && e.name === "AbortError";
    return { ok: false, error: { code: aborted ? "timeout" : "http", message } };
  } finally {
    clearTimeout(timer);
  }
}

export const firecrawlFetcher: SourceFetcher = {
  kind: "article",
  async fetch(input: SourceInput): Promise<FetchResult> {
    if (input.kind !== "article") {
      return { ok: false, error: { code: "http", message: "firecrawl fetcher got non-article input" } };
    }
    return fetchArticleUrl(input.url);
  },
};
