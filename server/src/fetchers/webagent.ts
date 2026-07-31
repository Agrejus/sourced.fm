import type { Message } from "ollama";
import { ollama, MODEL, WEB_TOOLS, LLM_OPTIONS, webSearch, webFetch } from "../llm";

// The search-and-read loop shared by topic research and deep research. The model
// may call web_search / web_fetch until it answers in prose or the round budget
// runs out. Every URL a tool returns lands in `sources`, so the caller ends up
// holding the full citation set without parsing the prose for it.

export type SourceMap = Map<string, { title: string; url: string }>;

const SEARCH_RESULT_CHARS = 2000;
const FETCH_CONTENT_CHARS = 4000;

export interface WebAgentOptions {
  system: string;
  user: string;
  maxRounds: number;
  /** Collected in place, so several agent runs can share one citation set. */
  sources: SourceMap;
}

// Returns the model's final prose, or "" when it never stopped calling tools.
export async function runWebAgent(options: WebAgentOptions): Promise<string> {
  const messages: Message[] = [
    { role: "system", content: options.system },
    { role: "user", content: options.user },
  ];

  for (let round = 0; round <= options.maxRounds; round++) {
    const response = await ollama.chat({
      model: MODEL,
      stream: false,
      tools: WEB_TOOLS,
      options: LLM_OPTIONS,
      messages,
    });
    const msg = response.message;
    messages.push(msg);

    const calls = msg.tool_calls ?? [];
    if (calls.length === 0) return msg.content.trim();

    for (const call of calls) {
      const name = call.function.name;
      const args = (call.function.arguments ?? {}) as {
        query?: string;
        max_results?: number;
        url?: string;
      };
      let toolContent: string;
      try {
        if (name === "web_search") {
          const results = await webSearch(String(args.query ?? ""), Number(args.max_results ?? 8));
          for (const r of results) options.sources.set(r.url, { title: r.title || r.url, url: r.url });
          toolContent = JSON.stringify(
            results.map((r) => ({
              title: r.title,
              url: r.url,
              content: r.content.slice(0, SEARCH_RESULT_CHARS),
            })),
          );
        } else if (name === "web_fetch") {
          const url = String(args.url ?? "");
          const fetched = await webFetch(url);
          if (url) options.sources.set(url, { title: fetched.title || url, url });
          toolContent = JSON.stringify({
            title: fetched.title,
            content: fetched.content.slice(0, FETCH_CONTENT_CHARS),
          });
        } else {
          toolContent = `unknown tool: ${name}`;
        }
      } catch (e) {
        // A failed tool call is reported back to the model, which can retry a
        // different query rather than losing the whole run.
        toolContent = `tool error: ${e instanceof Error ? e.message : String(e)}`;
      }
      messages.push({ role: "tool", content: toolContent, tool_name: name });
    }
  }
  return "";
}

// Any URL the prose cites inline counts as a source too — the model sometimes
// cites a page it read inside a search result rather than fetching it directly.
export function harvestInlineUrls(text: string, sources: SourceMap): void {
  for (const match of text.matchAll(/(https?:\/\/[^\s)\]]+)/g)) {
    const url = match[1]!.replace(/[.,;]+$/, "");
    if (!sources.has(url)) sources.set(url, { title: url, url });
  }
}
