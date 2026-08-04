import { z } from "zod";
import { chatJSON } from "../llm";
import { ENRICH_GAPS_PROMPT, ENRICH_SECTION_PROMPT } from "../prompts";
import { harvestInlineUrls, runWebAgent, type SourceMap } from "./webagent";
import type { Dossier, ProgressReporter } from "./types";

// Thin sources name things without explaining them. A transcript says "we use
// BPE" and moves on; the script stage may only use what the dossier contains,
// so EXPERT ends up saying the video doesn't get into it — exactly where a
// listener wanted the mechanism. Enrichment closes that gap upstream: find the
// concepts the source names but never explains, research each one with
// citations, and append them to the dossier so the episode has real material to
// draw on without any host inventing it.
//
// The appended material is NOT the source's content and says so in the dossier,
// because the script prompt preserves attribution — otherwise EXPERT would
// credit the video with an explanation it never gave.

const MAX_CONCEPTS = 6;
const SECTION_ROUNDS = 5;
// Below this the source is a stub, not a talk; there is nothing to mine for
// named-but-unexplained concepts.
const MIN_SOURCE_CHARS = 1200;

const GapsSchema = z.object({
  concepts: z
    .array(
      z.object({
        term: z.string().min(1),
        why: z.string(),
        query: z.string().min(1),
      }),
    )
    .max(20), // the prompt asks for <=6; tolerate an over-eager model, then slice
});

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export interface Gap {
  term: string;
  why: string;
  query: string;
}

// The two LLM steps, separated so the orchestration around them (the guards,
// the degradation, the attribution preamble) is testable without a model.
export interface EnrichDeps {
  findGaps(markdown: string): Promise<Gap[]>;
  research(gap: Gap, sources: SourceMap): Promise<string>;
}

export const llmEnrichDeps: EnrichDeps = {
  async findGaps(markdown) {
    const gaps = await chatJSON(GapsSchema, ENRICH_GAPS_PROMPT, markdown);
    return gaps.concepts;
  },
  research(gap, sources) {
    return runWebAgent({
      system: ENRICH_SECTION_PROMPT,
      user: `Concept: ${gap.term}\nWhat the source leaves unexplained: ${gap.why}\nStart from this search: ${gap.query}`,
      maxRounds: SECTION_ROUNDS,
      sources,
    });
  },
};

export interface EnrichOptions {
  /** What the hosts will call this source out loud: "the video", "the thread". */
  sourceNoun: string;
  onProgress?: ProgressReporter;
}

// Returns an enriched copy, or the dossier unchanged. Never throws and never
// fails the episode: a source that explains itself, a model that returns no
// gaps, or any error along the way all degrade to the original dossier.
export async function enrichDossier(
  dossier: Dossier,
  options: EnrichOptions,
  deps: EnrichDeps = llmEnrichDeps,
): Promise<Dossier> {
  if (dossier.markdown.length < MIN_SOURCE_CHARS) return dossier;

  let concepts: Gap[];
  try {
    options.onProgress?.("looking for concepts the source leaves unexplained");
    concepts = (await deps.findGaps(dossier.markdown)).slice(0, MAX_CONCEPTS);
  } catch {
    return dossier; // gap detection is best-effort; the base dossier still works
  }
  if (concepts.length === 0) return dossier;

  const sources: SourceMap = new Map();
  const blocks: string[] = [];
  for (const [i, concept] of concepts.entries()) {
    options.onProgress?.(
      `researching background ${i + 1} of ${concepts.length}: ${clip(concept.term, 60)}`,
    );
    try {
      const prose = await deps.research(concept, sources);
      if (!prose) continue;
      harvestInlineUrls(prose, sources);
      blocks.push(`### ${concept.term}\n\n${prose}`);
    } catch {
      continue; // one concept failing must not cost the others
    }
  }
  if (blocks.length === 0) return dossier;

  // The preamble is load-bearing: without it the script stage attributes this
  // research to the source, and EXPERT tells the listener the video explained
  // something it only mentioned.
  const section = [
    `## Background on concepts ${options.sourceNoun} names but does not explain`,
    "",
    `This section is NOT part of ${options.sourceNoun}. It is separately`,
    `researched background, added because ${options.sourceNoun} names these`,
    "concepts without explaining how they work. Every claim here is cited",
    "inline. Attribute it as general background — \"the standard explanation",
    `is…\", \"outside the video itself…\" — and never as something ${options.sourceNoun}`,
    "or its author said.",
    "",
    blocks.join("\n\n"),
  ].join("\n");

  const merged = [...dossier.sources];
  const seen = new Set(merged.map((s) => s.url));
  for (const s of sources.values()) {
    if (!seen.has(s.url)) {
      merged.push(s);
      seen.add(s.url);
    }
  }

  options.onProgress?.(`added background on ${blocks.length} concepts`);
  return {
    ...dossier,
    markdown: `${dossier.markdown}\n\n${section}`,
    sources: merged,
  };
}
