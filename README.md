# Sourced.fm

_Repo and deploy paths are still `podcast-learning`; only the product name changed._

Turn an article URL, an X/Twitter link, or a bare topic into a fact-checked,
interactive two-host podcast you can listen to — and interrupt with spoken
questions — on an iPhone. Every episode is built from a cited source dossier
and passes a claim-by-claim verification stage before any audio is rendered.

Standalone system: one Bun service (API + PWA + pipeline worker), SQLite +
on-disk audio, self-hosted Firecrawl for article ingestion, local GPU speech
(VibeVoice episodes, Kokoro answers, faster-whisper STT on the box's 2080 Ti),
and Claude for the dialogue script and Q&A — Anthropic tokens are the only
metered cost. Deploys via podman compose to the home Linux box behind
Tailscale HTTPS.

Full design: [`specs/design.md`](./specs/design.md).
