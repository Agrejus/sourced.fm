import { z } from "zod";
import { chatJSON, chatText, webFetch } from "../llm";
import {
  DEEP_RESEARCH_PLAN_PROMPT,
  DEEP_RESEARCH_SECTION_PROMPT,
  DEEP_RESEARCH_SYNTHESIS_PROMPT,
} from "../prompts";
import { harvestInlineUrls, runWebAgent, type SourceMap } from "./webagent";
import type { FetchResult, ProgressReporter, SourceFetcher, SourceInput } from "./types";

// Deep research runs three stages inside the source stage:
//   1. read the seed links (if the assignment contains any)
//   2. plan 4-6 sub-questions, then research each one in its own agent loop
//   3. synthesize every note into one dossier
// Sub-questions run one at a time on purpose: the worker's whole concurrency
// model is one thing at a time, and the LLM provider is metered per token, not
// per minute. A run takes minutes, so each stage reports progress.

const MAX_SEEDS = 3;
const SEED_CHARS = 6000;
const SECTION_ROUNDS = 5;
const MIN_SOURCES = 3;
const MIN_DOSSIER_CHARS = 2000;

export const PlanSchema = z.object({
  title: z.string().min(3).max(160),
  angle: z.string().min(3),
  questions: z.array(z.string().min(8)).min(3).max(6),
});

// A one-line label for a URL, for progress notes ("reading nytimes.com").
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 40);
  }
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export const deepResearchFetcher: SourceFetcher = {
  kind: "research",
  async fetch(input: SourceInput, onProgress?: ProgressReporter): Promise<FetchResult> {
    if (input.kind !== "research") {
      return {
        ok: false,
        error: { code: "http", message: "deep research fetcher got non-research input" },
      };
    }

    const sources: SourceMap = new Map();
    try {
      // ---- 1. seed links -------------------------------------------------
      const seedBlocks: string[] = [];
      const seeds = input.seedUrls.slice(0, MAX_SEEDS);
      for (const [i, url] of seeds.entries()) {
        onProgress?.(`reading source ${i + 1} of ${seeds.length}: ${hostOf(url)}`);
        try {
          const fetched = await webFetch(url);
          sources.set(url, { title: fetched.title || url, url });
          seedBlocks.push(
            `### Seed: ${fetched.title || url}\n${url}\n\n${fetched.content.slice(0, SEED_CHARS)}`,
          );
        } catch (e) {
          // A dead seed link is not fatal — the research still runs, and the
          // note tells the model not to cite what it could not read.
          seedBlocks.push(
            `### Seed: ${url}\n(this link could not be read: ${
              e instanceof Error ? e.message : String(e)
            })`,
          );
        }
      }

      // ---- 2. plan -------------------------------------------------------
      onProgress?.("planning the research");
      const planInput =
        `## Research assignment\n${input.brief}` +
        (seedBlocks.length ? `\n\n## Seed material the user supplied\n${seedBlocks.join("\n\n")}` : "");
      const plan = await chatJSON(PlanSchema, DEEP_RESEARCH_PLAN_PROMPT, planInput);

      // ---- 3. one research pass per question ------------------------------
      const notes: string[] = [];
      for (const [i, question] of plan.questions.entries()) {
        onProgress?.(`researching ${i + 1} of ${plan.questions.length}: ${clip(question, 80)}`);
        const answer = await runWebAgent({
          system: DEEP_RESEARCH_SECTION_PROMPT,
          user:
            `Research question: ${question}\n\n` +
            `## The overall assignment (for context — answer only the question above)\n${input.brief}\n\n` +
            `## The angle\n${plan.angle}`,
          maxRounds: SECTION_ROUNDS,
          sources,
        });
        if (answer) notes.push(`## ${question}\n\n${answer}`);
      }
      if (notes.length === 0) {
        return {
          ok: false,
          error: { code: "empty", message: "no research question produced an answer" },
        };
      }

      // ---- 4. synthesis ---------------------------------------------------
      onProgress?.(`writing the dossier from ${notes.length} research notes`);
      const markdown = await chatText([
        { role: "system", content: DEEP_RESEARCH_SYNTHESIS_PROMPT },
        {
          role: "user",
          content:
            `## Research assignment\n${input.brief}\n\n## Angle\n${plan.angle}\n\n` +
            (seedBlocks.length ? `## Seed material\n${seedBlocks.join("\n\n")}\n\n` : "") +
            `# Research notes\n\n${notes.join("\n\n")}`,
        },
      ]);

      harvestInlineUrls(markdown, sources);

      if (markdown.length < MIN_DOSSIER_CHARS) {
        return { ok: false, error: { code: "empty", message: "synthesized dossier too short" } };
      }
      if (sources.size < MIN_SOURCES) {
        return { ok: false, error: { code: "no_sources", message: "fewer than 3 usable sources" } };
      }
      return { ok: true, value: { markdown, title: plan.title, sources: [...sources.values()] } };
    } catch (e) {
      return { ok: false, error: { code: "http", message: e instanceof Error ? e.message : String(e) } };
    }
  },
};

// Links inside the assignment become seed sources. Exported for the submit
// route and its tests.
export function extractSeedUrls(brief: string): string[] {
  const seen = new Set<string>();
  for (const match of brief.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const url = match[0].replace(/[.,;:!?]+$/, "");
    try {
      new URL(url);
      seen.add(url);
    } catch {
      /* not a usable URL — ignore it */
    }
  }
  return [...seen];
}
