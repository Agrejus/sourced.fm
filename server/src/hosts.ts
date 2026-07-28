import { readFileSync } from "node:fs";
import { join } from "node:path";

// Persistent host personas, tunable as markdown in server/personas/. They are
// read fresh on every episode (cheap) and appended to the script prompt, so
// edits take effect on the next episode without a rebuild when the personas
// dir is bind-mounted (see deploy/compose.yml). HOST maps to the female voice
// (speech/voices/host.wav), EXPERT to the male voice (expert.wav) — keep the
// genders aligned if you retune them.
const PERSONAS_DIR = join(import.meta.dir, "../personas");

// Fallbacks if a file is missing/unreadable, so script generation never breaks
// over a persona edit.
const FALLBACK_HOST =
  "HOST is Maya — warm, quick, and curious. She asks the sharp question a smart friend would, reacts genuinely, summarizes plainly, and keeps momentum. Short turns.";
const FALLBACK_EXPERT =
  "EXPERT is Sam — calm and precise, generous with analogies. He explains without jargon, admits uncertainty, and never lectures.";

function readPersona(file: string, fallback: string): string {
  try {
    const text = readFileSync(join(PERSONAS_DIR, file), "utf8").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

// The block appended to the frozen SCRIPT_SYSTEM_PROMPT.
export function hostProfileBlock(): string {
  const host = readPersona("host.md", FALLBACK_HOST);
  const expert = readPersona("expert.md", FALLBACK_EXPERT);
  return (
    "## Host personas (keep these consistent across every episode)\n\n" +
    "### HOST\n" +
    host +
    "\n\n### EXPERT\n" +
    expert
  );
}
