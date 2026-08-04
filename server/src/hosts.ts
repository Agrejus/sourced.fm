import { readFileSync } from "node:fs";
import { join } from "node:path";

// Persistent host personas, tunable as markdown in server/personas/. They are
// read fresh on every episode (cheap) and appended to the script prompt, so
// edits take effect on the next episode without a rebuild when the personas
// dir is bind-mounted (see deploy/compose.yml). HOST maps to the female voice
// (speech/voices/host.wav), EXPERT and CRITIC to the two male voices
// (expert.wav, critic.wav) — keep the genders aligned if you retune them.
const PERSONAS_DIR = join(import.meta.dir, "../personas");

// Fallbacks if a file is missing/unreadable, so script generation never breaks
// over a persona edit. Each one must still convey the role's boundary, because
// a silent fallback that reads like the others collapses the three-way dynamic.
const FALLBACK_HOST =
  "HOST is Maya — warm, quick, and in charge of the show. She opens, sets up each thread, hands the questioning to CRITIC, keeps the exchange moving, and recaps at the end. She never explains the material and never runs the interrogation herself.";
const FALLBACK_EXPERT =
  "EXPERT is Sam — calm and precise, generous with analogies. He explains without jargon, expands every term of art he uses, answers CRITIC's pressure by going a level deeper rather than restating, admits real uncertainty, and never lectures.";
const FALLBACK_CRITIC =
  "CRITIC is Ray — sharp and direct, adversarial on the listener's behalf and never hostile. He refuses vague answers, stops EXPERT to unpack any acronym or jargon, presses for mechanism, numbers, tradeoffs and failure cases, and follows up until the explanation is real. He asks; he never asserts or answers himself.";

function readPersona(file: string, fallback: string): string {
  try {
    const text = readFileSync(join(PERSONAS_DIR, file), "utf8").trim();
    return text || fallback;
  } catch {
    return fallback;
  }
}

// The block appended to the frozen SCRIPT_SYSTEM_PROMPT, and to the factcheck
// prompt — a revision rewrites whole segments, so the reviser needs the same
// personas or a corrected episode drifts off-character and can lose CRITIC.
export function hostProfileBlock(): string {
  const host = readPersona("host.md", FALLBACK_HOST);
  const expert = readPersona("expert.md", FALLBACK_EXPERT);
  const critic = readPersona("critic.md", FALLBACK_CRITIC);
  return (
    "## Host personas (keep these consistent across every episode)\n\n" +
    "### HOST\n" +
    host +
    "\n\n### EXPERT\n" +
    expert +
    "\n\n### CRITIC\n" +
    critic
  );
}
