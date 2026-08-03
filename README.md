# Sourced.fm

Turn an article URL, a YouTube link, an X/Twitter link, a bare topic, or a
written research assignment into a fact-checked, interactive three-host podcast you can listen to
and interrupt with spoken questions. Every episode is built from a cited source
dossier and passes a claim-by-claim verification stage before any audio is
rendered.

One Bun service runs the API, hosts the PWA, and runs the pipeline worker in
process. State is a single SQLite file; audio is mp3 on disk. Article ingestion
uses self-hosted Firecrawl; YouTube links are read from the video transcript
(captions when they exist, otherwise the audio is transcribed on the GPU). Speech runs locally on an NVIDIA GPU: VibeVoice for
episodes, Kokoro for spoken answers, faster-whisper for transcription and
timestamp alignment. A hosted LLM (Ollama Cloud by default) writes the dialogue,
runs the fact-check, researches topics, and answers questions, and its tokens
are the only metered cost.

Full design: [`specs/design.md`](./specs/design.md).
Deploy: [`deploy/README.md`](./deploy/README.md).

## Requirements

- A Linux host with a container runtime that supports compose (`podman compose`
  or `docker compose`) and GPU passthrough.
- An NVIDIA GPU with about 11 GB of VRAM. Cards without bf16 support need the
  float16 and SDPA overrides the speech service already applies.
- An LLM API key (`OLLAMA_API_KEY` by default) in a `.env` file at the repo root.
- HTTPS in front of the app if you want the microphone. Browsers only grant
  `getUserMedia` in a secure context, so voice questions do not work over a
  plain `http://` address. A reverse proxy or `tailscale serve` both do the job.

## Run it

```sh
cd app && bun install && bun run build   # the app image copies app/dist
cd ../deploy && podman compose up -d --build
```

Only the app publishes a port (7900). Firecrawl and the speech service stay on
the internal compose network.

## Tests

```sh
cd server && bun test
cd app && bun run build && bun run lint
```

## Third-party material

`speech/voices/host.wav`, `speech/voices/expert.wav` and
`speech/voices/critic.wav` are the demo voice prompts from the
[vibevoice-community VibeVoice
fork](https://github.com/vibevoice-community/VibeVoice) (`en-Alice_woman.wav`,
`en-Frank_man.wav` and `in-Samuel_man.wav`), redistributed under that project's
MIT license.
`deploy/compose.yml` mirrors the topology of
[Firecrawl](https://github.com/firecrawl/firecrawl)'s compose file and pulls its
published images by digest.
