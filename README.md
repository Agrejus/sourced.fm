# podcast-learning

Turn an article URL into an interactive two-host podcast you can listen to —
and interrupt with spoken questions — on an iPhone.

Standalone system: one Bun service (API + PWA + pipeline worker), SQLite +
on-disk audio, Firecrawl for article ingestion, ElevenLabs for TTS/STT, Claude
for the dialogue script and Q&A. Deploys as a single container to the home
Linux box behind Tailscale HTTPS.

Full design: [`specs/design.md`](./specs/design.md).
