import type { Message } from "ollama";
import { ollama, MODEL, WEB_TOOLS, webSearch, webFetch } from "../llm";
import { RESEARCH_SYSTEM_PROMPT } from "../prompts";
import type { FetchResult, SourceFetcher, SourceInput } from "./types";

const MAX_TOOL_ROUNDS = 8;

// Topic research: an Ollama chat with the web_search / web_fetch tools in an
// agent loop. The model searches, reads, and writes a cited brief; sources are
// harvested from the tool results. Fewer than 2 sources fails as no_sources —
// the system never fabricates an episode from model memory (design.md §2.11).
export const researchFetcher: SourceFetcher = {
  kind: "topic",
  async fetch(input: SourceInput): Promise<FetchResult> {
    if (input.kind !== "topic") {
      return { ok: false, error: { code: "http", message: "research fetcher got non-topic input" } };
    }

    const messages: Message[] = [
      { role: "system", content: RESEARCH_SYSTEM_PROMPT },
      { role: "user", content: input.topic },
    ];
    const sources = new Map<string, { title: string; url: string }>();
    let brief = "";

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        const response = await ollama.chat({ model: MODEL, stream: false, tools: WEB_TOOLS, messages });
        const msg = response.message;
        messages.push(msg);

        const calls = msg.tool_calls ?? [];
        if (calls.length === 0) {
          brief = msg.content.trim();
          break;
        }

        for (const call of calls) {
          const name = call.function.name;
          const args = (call.function.arguments ?? {}) as { query?: string; max_results?: number; url?: string };
          let toolContent: string;
          try {
            if (name === "web_search") {
              const results = await webSearch(String(args.query ?? ""), Number(args.max_results ?? 8));
              for (const r of results) sources.set(r.url, { title: r.title || r.url, url: r.url });
              toolContent = JSON.stringify(
                results.map((r) => ({ title: r.title, url: r.url, content: r.content.slice(0, 2000) })),
              );
            } else if (name === "web_fetch") {
              const url = String(args.url ?? "");
              const fetched = await webFetch(url);
              if (url) sources.set(url, { title: fetched.title || url, url });
              toolContent = JSON.stringify({ title: fetched.title, content: fetched.content.slice(0, 4000) });
            } else {
              toolContent = `unknown tool: ${name}`;
            }
          } catch (e) {
            toolContent = `tool error: ${e instanceof Error ? e.message : String(e)}`;
          }
          messages.push({ role: "tool", content: toolContent, tool_name: name });
        }
      }
    } catch (e) {
      return { ok: false, error: { code: "http", message: e instanceof Error ? e.message : String(e) } };
    }

    // Also pick up any sources the brief cites inline.
    for (const match of brief.matchAll(/(https?:\/\/[^\s)]+)/g)) {
      const url = match[1]!.replace(/[.,]+$/, "");
      if (!sources.has(url)) sources.set(url, { title: url, url });
    }

    if (sources.size < 2) {
      return { ok: false, error: { code: "no_sources", message: "fewer than 2 usable sources" } };
    }
    return { ok: true, value: { markdown: brief, title: input.topic, sources: [...sources.values()] } };
  },
};
