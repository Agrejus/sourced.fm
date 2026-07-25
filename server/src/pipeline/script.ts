import { z } from "zod";
import type { Accessors, EpisodeRow } from "../db";
import type { Dossier } from "../fetchers/types";
import type { Script } from "../domain";
import { chatJSON } from "../llm";
import { SCRIPT_SYSTEM_PROMPT } from "../prompts";
import type { Stage } from "./stages";

const ScriptSchema = z.object({
  title: z.string(),
  segments: z
    .array(
      z.object({
        speaker: z.enum(["HOST", "EXPERT"]),
        text: z.string().min(1),
      }),
    )
    .min(6)
    .max(60),
});

// sourced -> scripted. The user content is dossier.markdown and NOTHING else —
// the script stage never gets tools, web access, or model memory as source
// material (design.md §2.11). The script's title overwrites the episode title.
export function scriptStage(deps: { accessors: Accessors; now: () => number }): Stage {
  return {
    name: "script",
    async run(ep: EpisodeRow) {
      if (!ep.dossier_json) throw new Error("script: episode has no dossier_json");
      const dossier = JSON.parse(ep.dossier_json) as Dossier;

      const parsed = await chatJSON(ScriptSchema, SCRIPT_SYSTEM_PROMPT, dossier.markdown);

      const script: Script = {
        title: parsed.title,
        segments: parsed.segments.map((s, idx) => ({ ...s, idx })),
      };
      deps.accessors.updateEpisodeStage(
        ep.id,
        "sourced",
        "scripted",
        { script_json: JSON.stringify(script), title: script.title },
        deps.now(),
      );
    },
  };
}
