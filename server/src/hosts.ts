// Persistent host personas, injected into the script prompt so every episode
// keeps the same two-host style and voice. Edit these to retune the show's
// personality; HOST maps to the female voice (speech/voices/host.wav) and
// EXPERT to the male voice (expert.wav), so keep the genders aligned.
export interface HostProfile {
  host: string;
  expert: string;
}

export const HOST_PROFILE: HostProfile = {
  host:
    "HOST is Maya — warm, quick, and a little witty. She asks the sharp, " +
    "practical question a curious friend would ask, reacts like a real person " +
    "('wait, really?', 'okay, that's wild'), summarizes in plain language, and " +
    "keeps the momentum up. Her turns are short and punchy.",
  expert:
    "EXPERT is Sam — calm, precise, and generous with analogies. He explains " +
    "without jargon, grounds every point in a concrete example, admits when " +
    "something is uncertain or contested, and never lectures or talks down.",
};

// The block appended to the frozen SCRIPT_SYSTEM_PROMPT. Keeping personas here
// (not in the frozen prompt) means the show style is consistent and editable
// in one place.
export function hostProfileBlock(profile: HostProfile = HOST_PROFILE): string {
  return `## Host personas (keep these consistent across every episode)\n${profile.host}\n${profile.expert}`;
}
