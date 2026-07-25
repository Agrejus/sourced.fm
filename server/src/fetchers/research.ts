import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config";
import { RESEARCH_SYSTEM_PROMPT } from "../prompts";
import type { FetchResult, SourceFetcher, SourceInput } from "./types";

const MODEL = "claude-opus-4-8";
const MAX_CONTINUATIONS = 5;

const client = new Anthropic({ apiKey: config.anthropicApiKey });

// Topic research: one Claude call with the server-side web search tool. The
// dossier is the cited brief; sources come from the tool results (plus any the
// brief cites inline). Fewer than 2 sources fails as no_sources — the system
// never fabricates an episode from model memory (design.md §2.11).
export const researchFetcher: SourceFetcher = {
  kind: "topic",
  async fetch(input: SourceInput): Promise<FetchResult> {
    if (input.kind !== "topic") {
      return { ok: false, error: { code: "http", message: "research fetcher got non-topic input" } };
    }

    const messages: Anthropic.MessageParam[] = [{ role: "user", content: input.topic }];
    const textParts: string[] = [];
    const sources = new Map<string, { title: string; url: string }>();

    try {
      for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
        const response = await client.messages.create({
          model: MODEL,
          max_tokens: 16000,
          thinking: { type: "adaptive" },
          system: RESEARCH_SYSTEM_PROMPT,
          tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
          messages,
        });

        for (const block of response.content) {
          if (block.type === "text") {
            textParts.push(block.text);
          } else if (block.type === "web_search_tool_result") {
            const content = block.content as unknown;
            // A tool-result whose content is an object (not a list) is an error.
            if (!Array.isArray(content)) {
              return { ok: false, error: { code: "http", message: "web_search tool error" } };
            }
            for (const result of content as { url?: string; title?: string }[]) {
              if (result.url) sources.set(result.url, { title: result.title || result.url, url: result.url });
            }
          }
        }

        if (response.stop_reason === "pause_turn" && turn < MAX_CONTINUATIONS) {
          messages.push({ role: "assistant", content: response.content });
          continue;
        }
        break;
      }
    } catch (e) {
      return { ok: false, error: { code: "http", message: e instanceof Error ? e.message : String(e) } };
    }

    const markdown = textParts.join("\n").trim();
    // Also pick up sources cited inline in the brief ("(Source: pub, https://...)").
    for (const match of markdown.matchAll(/(https?:\/\/[^\s)]+)/g)) {
      const url = match[1]!.replace(/[.,]+$/, "");
      if (!sources.has(url)) sources.set(url, { title: url, url });
    }

    if (sources.size < 2) {
      return { ok: false, error: { code: "no_sources", message: "fewer than 2 usable sources" } };
    }

    return {
      ok: true,
      value: { markdown, title: input.topic, sources: [...sources.values()] },
    };
  },
};
