# podcast-learning — article → interactive podcast

Standalone system. It shares **nothing** with rust-runtime — no bus, no Mongo,
no browserless container. rust-runtime was reference material only (its scrape
SDK showed the render-via-headless-browser approach; here we use Firecrawl
instead).

## Part 1: What this is (for humans)

Give the system an article URL. It fetches the page as clean markdown
(Firecrawl), rewrites it as a two-host dialogue, synthesizes it **locally on
the box's RTX 2080 Ti** (VibeVoice), and publishes it as an episode you can
play on your iPhone from anywhere (Tailscale). While you listen, you can
interrupt — hold the mic button **or say the word "question"** — ask a question
out loud, hear the answer spoken back, and resume playback. Audio in both
directions is local and free; the only metered cost in the whole system is
Anthropic tokens.

### The flow

1. **Submit** — paste a URL in the PWA (or share-sheet it from iOS via a
   Shortcut). The episode is queued.
2. **Scrape** — a **self-hosted Firecrawl** instance (runs on the same box)
   renders the page in its own headless browser and returns main-content
   markdown + title/byline metadata. Same one-call API as the cloud product,
   but free, private, and ours.
3. **Script** — an LLM rewrites the article as a dialogue between two hosts:
   HOST (curious, asks the questions you would) and EXPERT (explains). Output is
   structured segments, not free text.
4. **Synthesize** — VibeVoice-1.5B renders the whole dialogue in one pass on
   the GPU (that's what it's built for: stable voice identities and natural
   turn-taking across a full episode). faster-whisper then force-aligns the
   result to give every transcript segment a real timestamp.
5. **Listen** — the PWA lists episodes and plays them. Media Session API so
   lock-screen controls work; HTTP Range support so scrubbing works on iOS.
6. **Interrupt** — wake word or hold-to-talk pauses playback, records your
   question, transcribes it (faster-whisper, local GPU), answers it with an LLM
   grounded on the article + transcript **+ where you are in the episode**,
   speaks the answer (Kokoro, local GPU — small, near-instant), and resumes.

### Shape of the system

One app service, a scraping stack, and a GPU speech service. A single
Bun/TypeScript process serves the PWA, the API, and runs the pipeline worker
in-process. SQLite holds episodes/chats/queue state; audio mp3s live on disk.
Alongside it, the same compose file runs **self-hosted Firecrawl** (its API +
worker + Redis + Playwright containers) and a **`speech` container** (Python,
GPU) that owns all audio models — none of these are reachable outside the
compose network. Everything runs on the Fedora box (`192.168.68.85`, rootless
podman, RTX 2080 Ti) and the app is fronted by `tailscale serve` for HTTPS. No
message broker or second database *for our app* — at personal volume a worker
loop over a SQLite table is the whole queue (Firecrawl's internal Redis is its
own business).

Dependencies (server-side; keys via `.env` on the box):

| Dependency | Used for | Notes |
|---|---|---|
| Firecrawl (self-hosted) | URL → clean markdown + metadata | AGPL, free; 4 containers on the box; no cloud key. Cloud-only anti-bot ("fire-engine") is absent — hard-bot-walled sites may fail (see §2.3) |
| LLM provider (Anthropic) | dialogue script + Q&A answers | the only metered cost |
| `speech` service (local GPU) | episode TTS (VibeVoice-1.5B), answer TTS (Kokoro-82M), STT + alignment (faster-whisper) | free; ~11GB VRAM budget, see §2.7 |
| ElevenLabs (optional fallback) | episode/answer TTS if local quality disappoints | pure config swap behind the SpeechProvider seam (§2.6); no key needed unless enabled |

### Honest constraints (iPhone realities)

- **Mic requires HTTPS.** `getUserMedia` only works in a secure context, so the
  PWA must be reached via `tailscale serve` (real cert on the tailnet). Plain
  `http://192.168.68.85` will never get mic access.
- **Wake word only works with the app foregrounded and screen on.** iOS
  suspends PWA JS (and the mic) when the screen locks. Lock screen = playback
  controls only; questions need the phone awake. Platform limit, not a choice.
- **Use headphones for wake word.** On speaker the mic hears the podcast; echo
  cancellation helps, but a host saying "question" can false-trigger.
- **Episodes render slower than cloud TTS.** VibeVoice-1.5B on a 2080 Ti takes
  minutes, not seconds, per episode. Irrelevant for a batch pipeline; noted so
  nobody "fixes" it. The Turing card also means fp16 (no bf16) and SDPA (no
  FlashAttention 2) — both must be set explicitly, VibeVoice defaults to bf16.
- **Cost.** Audio is free (local GPU + electricity). The only metered spend is
  Anthropic tokens (script + Q&A). The ElevenLabs fallback, if ever enabled,
  costs ~$1.50–4 per 12-minute episode.

---

## Part 2: Binding design (for agents)

### 2.1 Repo layout

```
podcast-learning/
  server/            Bun + Hono service: API, static PWA hosting, pipeline worker
    src/
      api/           route handlers (episodes, ask, audio)
      pipeline/      stage functions + worker loop
      fetchers/      ArticleFetcher interface + firecrawl.ts
      speech/        SpeechProvider interface + local.ts (+ elevenlabs.ts only if enabled)
      db.ts          bun:sqlite schema + accessors
      config.ts      env parsing (parse once at boot, crash on missing)
  app/               PWA (Vite + TS): player, chat pane, wake word, submit
  speech/            Python FastAPI GPU service: VibeVoice, Kokoro, faster-whisper
  deploy/            Dockerfiles, compose.yml, box setup notes (incl. GPU/CDI)
  specs/design.md    this document
  data/              gitignored: sqlite db + episodes/<id>/audio.mp3
```

### 2.2 Pipeline (in-process worker, SQLite-backed)

Status machine on the episode row — the only source of truth:

```
submitted → scraped → scripted → synthesizing → ready
     └─────────┴─────────┴────────────┴────────→ failed
```

- One worker loop: every tick, claim the oldest episode in a non-terminal,
  non-`ready` status and run **one** stage (`scrape`, `script`, `synthesize`),
  then persist the new status. Concurrency 1 across the whole pipeline —
  one episode on the GPU at a time, and the loop stays trivial.
- Crash safety: statuses persist per stage; on boot the worker just resumes
  from whatever statuses it finds. An episode stuck in `synthesizing` resumes
  segment-by-segment (below).
- Retries: `attempts` + `next_attempt_at` columns, exponential backoff, max 5 →
  `failed` with `{stage, message}`. Resubmitting a URL always creates a fresh
  episode; there are no in-place retry semantics to maintain.
- Synthesize stage (local path): one `SpeechProvider.synthesizeEpisode(script)`
  call → the speech service renders the whole dialogue in a single VibeVoice
  pass (that one-pass render is *why* the voices stay consistent — do not
  "optimize" it into per-segment calls), then whisper-aligns the audio against
  the segment texts and returns `{audioPath, startMs per segment}`. A retry
  regenerates the episode from scratch — GPU time is free, so there is no
  resume machinery on this path.
- Synthesize stage (elevenlabs fallback path): per-segment TTS written to
  `data/episodes/<id>/seg-<idx>.mp3`, **skipping segments whose file already
  exists** (a retry resumes, never re-bills); ffmpeg concat + ffprobe durations
  → `startMs` → `audio.mp3` → delete seg files. This resume rule exists only
  because this path costs money per segment.

### 2.3 Article fetching (Strategy — the one seam we pay for)

```ts
interface ArticleFetcher {
  id: "firecrawl" | "playwright";
  fetch(url: string): Promise<Result<FetchedArticle, FetchError>>;
}
interface FetchedArticle {
  markdown: string;            // main content only
  title: string;
  byline?: string; siteName?: string;
}
```

- V1 implements **firecrawl only**, pointed at the self-hosted instance:
  `POST ${FIRECRAWL_API_URL}/v2/scrape` (`http://firecrawl-api:3002` inside the
  compose network) with `formats: ["markdown"]`, `onlyMainContent: true`, and
  the self-set bearer token. Validate at the boundary: empty/near-empty
  markdown (< 500 chars) is a `FetchError`, not an episode.
- Because `FIRECRAWL_API_URL` + key are plain env, the cloud API is a config
  change, not a code change — the escape hatch if a bot-walled site defeats the
  self-hosted engine (self-host lacks the cloud-only "fire-engine" anti-bot
  layer).
- The interface exists because scraping is the most likely component to change.
  Nothing else in the system may know which fetcher ran. Do NOT build a bespoke
  playwright fetcher preemptively (YAGNI) — but if it comes, note Bun cannot
  drive Playwright's WebSocket transport; it would be a sidecar or a Node
  subprocess.

### 2.4 Storage (bun:sqlite, WAL mode)

```sql
episodes(id TEXT PK,            -- uuid v7
         url, title, status, error_json,
         article_json,          -- {markdown, byline, siteName}
         script_json,           -- {segments:[{idx, speaker, text, startMs?}]}
         audio_path, duration_ms,
         attempts INT DEFAULT 0, next_attempt_at,
         created_at, updated_at)
chats(id TEXT PK, episode_id FK, role TEXT CHECK(role IN ('user','assistant')),
      text, position_ms, created_at)
```

- `speaker` is `"HOST" | "EXPERT"` — exhaustive; an unknown speaker fails the
  script parse at the boundary, never mid-synthesis.
- Audio bytes never go in SQLite; `audio_path` points into `data/episodes/`.

### 2.5 Script generation contract

- One LLM call (Claude, structured output): `{title, segments:[{speaker,text}]}`.
- Target 10–15 min spoken (~1,500–2,200 words). HOST asks/reacts/summarizes;
  EXPERT explains. First segment: HOST cold-opens on why the article matters.
  Last segment: HOST recaps 3 takeaways.
- Parse, don't validate downstream: reject empty segments, unknown speakers,
  > 60 segments → stage error (backoff retry covers model flakiness).

### 2.6 Speech provider (Strategy — mirror of the fetcher seam)

```ts
interface SpeechProvider {
  id: "local" | "elevenlabs";
  synthesizeEpisode(script: Script, outDir: string):
    Promise<Result<{ audioPath: string; segmentStartMs: number[] }, SpeechError>>;
  synthesizeAnswer(text: string): Promise<Result<ReadableStream, SpeechError>>; // streamed audio
  transcribe(audio: Blob): Promise<Result<string, SpeechError>>;
}
```

- V1 implements **local only** (thin HTTP client for the speech service).
  ElevenLabs is the fallback implementation, added only if local episode
  quality disappoints in practice — selected by `SPEECH_PROVIDER` env, never
  per-request logic. Nothing outside `server/src/speech/` knows which provider
  ran.

### 2.7 The speech service (Python, GPU) and the VRAM budget

FastAPI container owning every audio model; the Bun app is its only client.

| Endpoint | Model | Residency |
|---|---|---|
| `POST /tts/episode` (script → wav + per-segment startMs) | VibeVoice-1.5B (~7GB) | **load → render → release**, per call |
| `POST /tts/answer` (text → streamed audio) | Kokoro-82M (~1GB) | resident |
| `POST /stt` (audio → text) | faster-whisper distil/small (~1–2GB) | resident |

- The 2080 Ti has 11GB with everything else on the box using ~0 (verified
  2026-07-25: 166MiB, gnome-shell only). Resident interactive set is ~3GB;
  VibeVoice fits in the remainder only because it is load/unload — it must
  never be kept resident between episodes, or the interactive loop loses its
  headroom.
- `/tts/episode` also runs the whisper forced alignment (it already has the
  model) so timestamps come back in the same response.
- Turing constraints, set explicitly: `torch_dtype=float16` (no bf16),
  attention via SDPA (no FlashAttention 2).
- One episode render at a time (FastAPI-level lock); the pipeline's
  concurrency-1 already guarantees this, the lock is the negative-space guard.
- Model weights live in a named volume; first boot downloads them (~5GB total).

### 2.8 Voice question loop (synchronous HTTP, never queued)

```
POST /api/episodes/:id/ask        multipart: audio (webm/mp4) + positionMs
  1. STT: SpeechProvider.transcribe (faster-whisper on the GPU) → question text
  2. LLM: system prompt = article markdown + transcript segments up to
     positionMs (marked "the listener has heard up to here") + last N chat
     turns for this episode
  3. TTS: SpeechProvider.synthesizeAnswer (Kokoro, streamed) → pipe audio
     straight to the response (never buffer the full answer server-side)
POST /api/episodes/:id/ask-text   {question, positionMs} → {answerText}
```

- Every Q/A turn persists to `chats` — the chat pane doubles as rereadable
  show-notes.
- The question loop is a request/response path in the server, NOT a pipeline
  stage — it must never sit behind the worker queue.

### 2.9 PWA client behavior

- **Playback**: `<audio>` + Media Session API (title/artwork/seek on lock
  screen). `GET /api/episodes/:id/audio` must support `Range` (206) — iOS
  scrubbing breaks without it; a non-206 partial response in dev is a bug.
- **Hold-to-talk**: press → `audio.pause()` → `MediaRecorder` → release → POST
  `/ask` → play answer stream → resume at saved position.
- **Wake word ("question")**: while playing and `document.visibilityState ===
  "visible"`, run `webkitSpeechRecognition` (continuous, interim results); any
  transcript containing the standalone word "question" triggers the
  hold-to-talk flow (pause → beep → record). Guards: `echoCancellation: true`;
  restart on iOS's ~60s recognition auto-stop (`onend` → `start()`); visible
  "listening" indicator; settings toggle to disable. Fallback only if Web
  Speech proves too flaky on iOS: Porcupine WASM custom keyword — do not build
  preemptively.
- **Submission**: URL paste box; plus an iOS Shortcut POSTing the shared URL to
  `POST /api/episodes` (accept a bare-URL text body so the Shortcut is one
  action).

### 2.10 Deploy (Fedora box, rootless podman)

- App image: Bun base + ffmpeg; `data/` bind-mounted for SQLite + audio.
- `deploy/compose.yml` services:
  - `learn` — the app, port `7900:7900`, `restart: unless-stopped`.
  - `speech` — Python/FastAPI GPU image (CUDA base). GPU via CDI:
    `devices: [nvidia.com/gpu=all]`. Named volume for model weights. **No
    published ports** — only `learn` reaches it.
  - `firecrawl-api`, `firecrawl-worker`, `firecrawl-redis`,
    `firecrawl-playwright` — pinned upstream Firecrawl images (mirror the
    ports/env of Firecrawl's own self-host compose; pin tags, don't track
    `latest`). **No published ports** — only `learn` may reach them, on the
    compose network. `shm_size: 1gb` on the playwright service (Chromium
    /dev/shm crashes without it). `TEST_API_KEY`/bearer set even though it's
    internal-only (defense in depth on a shared box).
- One-time box setup for rootless GPU containers: install
  `nvidia-container-toolkit` and generate the CDI spec
  (`nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`); verify with
  `podman run --rm --device nvidia.com/gpu=all ... nvidia-smi`. Document in
  `deploy/README`.
- Env (`.env` on the box, gitignored): `FIRECRAWL_API_URL`
  (`http://firecrawl-api:3002`), `FIRECRAWL_API_KEY` (self-set token),
  `ANTHROPIC_API_KEY`, `SPEECH_URL` (`http://speech:7910`),
  `SPEECH_PROVIDER=local`, `PORT`. ElevenLabs vars (`ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_HOST/EXPERT`) exist only if the fallback provider is
  enabled.
- Ship code like rust-runtime does: bare-push over SSH
  (`git config receive.denyCurrentBranch=updateInstead` on the box), then
  `podman compose up -d --build`.
- `tailscale serve --bg 7900` fronts the service with HTTPS on the tailnet —
  this is what makes the mic work (§Part 1); it is not optional for voice.

### 2.11 Negative space (what must NOT happen)

- The voice round-trip never enters the pipeline queue.
- VibeVoice is never resident between episode renders — it would evict the
  interactive models' VRAM headroom (§2.7).
- The one-pass episode render is never split into per-segment TTS calls on the
  local path — cross-segment voice consistency is the point of VibeVoice.
- On the elevenlabs fallback path only: a retried synthesize never re-bills
  segments that already have files.
- No stage writes a status backwards; assert expected prior status and drop.
- No API key (Firecrawl/Anthropic/ElevenLabs-if-enabled) ever reaches the PWA —
  all external calls are server-side.
- Nothing outside `fetchers/` knows which fetcher produced the article;
  nothing outside `server/src/speech/` knows which speech provider ran.
- The Firecrawl and speech containers are never reachable from outside the
  compose network (no published ports, not on the tailnet) — a headless
  browser that fetches arbitrary URLs and a GPU service are not things the LAN
  gets to talk to.
- `audio.mp3` is immutable once status is `ready`.
- Config is parsed once at boot; a missing required env var crashes the process
  at startup, not mid-episode.
