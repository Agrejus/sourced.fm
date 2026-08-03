import { z } from "zod";
import type { Accessors, EpisodeRow } from "../db";
import type { Script, Segment } from "../domain";
import type { Dossier, SourceInput } from "../fetchers/types";
import { chatJSON, webSearch } from "../llm";
import { FACTCHECK_SYSTEM_PROMPT } from "../prompts";
import { hostProfileBlock } from "../hosts";
import type { Stage } from "./stages";

const FactcheckSchema = z.object({
  claims: z
    .array(
      z.object({
        segmentIdx: z.number().int(),
        claim: z.string(),
        verdict: z.enum(["supported", "unsupported", "distorted"]),
        note: z.string(),
        sourceUrl: z.string().optional(),
      }),
    )
    .min(1),
  revisedSegments: z
    .array(
      z.object({
        speaker: z.enum(["HOST", "EXPERT", "CRITIC"]),
        text: z.string().min(1),
      }),
    )
    .min(6)
    // Must match the script schema's cap — deep dives run long; the revised
    // script is a full replacement and can have just as many segments.
    .max(400)
    .optional(), // REQUIRED iff any verdict !== "supported"
});

// For topic episodes, gather fresh web evidence so time-sensitive claims can be
// re-checked (the structured call itself stays tool-free for reliable JSON).
async function freshEvidence(source: SourceInput): Promise<string> {
  if (source.kind !== "topic") return "";
  try {
    const results = await webSearch(source.topic, 5);
    if (results.length === 0) return "";
    const body = results
      .map((r) => `- ${r.title} (${r.url})\n  ${r.content.slice(0, 800)}`)
      .join("\n");
    return `\n\n## Fresh web evidence (re-check time-sensitive claims against this)\n${body}`;
  } catch {
    return ""; // evidence is best-effort; never fail the stage over it
  }
}

// scripted -> verified. Exactly one structured call, at most one revision round;
// the revision is trusted (schema-validated, never re-checked). This stage never
// moves an episode to failed on its own — only the worker's attempts-exhausted
// path does; a schema/shape error here throws and rides the normal retry path.
export function factcheckStage(deps: { accessors: Accessors; now: () => number }): Stage {
  return {
    name: "factcheck",
    async run(ep: EpisodeRow) {
      if (!ep.dossier_json) throw new Error("factcheck: episode has no dossier_json");
      if (!ep.script_json) throw new Error("factcheck: episode has no script_json");
      const dossier = JSON.parse(ep.dossier_json) as Dossier;
      const script = JSON.parse(ep.script_json) as Script;
      const source = JSON.parse(ep.source_json) as SourceInput;

      const userContent =
        `## Sources dossier\n${dossier.markdown}${await freshEvidence(source)}\n\n## Script\n` +
        script.segments.map((s) => `[${s.idx}] ${s.speaker}: ${s.text}`).join("\n");

      // The personas ride along because a revision replaces the whole script:
      // without them the reviser rewrites off-character and can drop CRITIC.
      const system = `${FACTCHECK_SYSTEM_PROMPT}\n\n${hostProfileBlock()}`;
      const result = await chatJSON(FactcheckSchema, system, userContent);

      const allSupported = result.claims.every((c) => c.verdict === "supported");
      const factcheckJson = JSON.stringify({ claims: result.claims });

      if (allSupported) {
        // Script passes unchanged; ignore any revisedSegments the model returned.
        deps.accessors.updateEpisodeStage(
          ep.id,
          "scripted",
          "verified",
          { factcheck_json: factcheckJson },
          deps.now(),
        );
        return;
      }

      // Any non-supported verdict REQUIRES a revision (missing => stage error).
      if (!result.revisedSegments) {
        throw new Error("factcheck returned non-supported verdicts without revisedSegments");
      }
      const revised: Script = {
        title: script.title,
        segments: result.revisedSegments.map((s, idx): Segment => ({ ...s, idx })),
      };
      deps.accessors.updateEpisodeStage(
        ep.id,
        "scripted",
        "verified",
        { script_json: JSON.stringify(revised), factcheck_json: factcheckJson },
        deps.now(),
      );
    },
  };
}
