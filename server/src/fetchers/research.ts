import { RESEARCH_SYSTEM_PROMPT } from "../prompts";
import { harvestInlineUrls, runWebAgent, type SourceMap } from "./webagent";
import type { FetchResult, SourceFetcher, SourceInput } from "./types";

const MAX_TOOL_ROUNDS = 8;
const MIN_SOURCES = 2;

// Topic research: one search-and-read loop that writes a cited brief. This is
// the quick path — a bare topic typed into the composer. The deep path (a
// written assignment, optional seed links, planned sub-questions) lives in
// deepresearch.ts. Fewer than 2 sources fails as no_sources: the system never
// fabricates an episode from model memory (design.md §2.11).
export const researchFetcher: SourceFetcher = {
  kind: "topic",
  async fetch(input: SourceInput): Promise<FetchResult> {
    if (input.kind !== "topic") {
      return { ok: false, error: { code: "http", message: "research fetcher got non-topic input" } };
    }

    const sources: SourceMap = new Map();
    let brief: string;
    try {
      brief = await runWebAgent({
        system: RESEARCH_SYSTEM_PROMPT,
        user: input.topic,
        maxRounds: MAX_TOOL_ROUNDS,
        sources,
      });
    } catch (e) {
      return { ok: false, error: { code: "http", message: e instanceof Error ? e.message : String(e) } };
    }

    harvestInlineUrls(brief, sources);
    if (sources.size < MIN_SOURCES) {
      return { ok: false, error: { code: "no_sources", message: "fewer than 2 usable sources" } };
    }
    return { ok: true, value: { markdown: brief, title: input.topic, sources: [...sources.values()] } };
  },
};
