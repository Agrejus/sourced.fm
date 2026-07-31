# Sourced.fm — article → interactive podcast

Standalone system: no message bus, no second database, no browserless
container. Article rendering goes through Firecrawl rather than a
headless-browser SDK.

## Part 1: What this is (for humans)

Give the system **an article URL, a YouTube link, an X/Twitter link, or just a
topic**. It
builds a cited source dossier, rewrites it as a two-host dialogue,
**fact-checks the script against the sources before any audio exists**,
synthesizes it locally on an NVIDIA GPU (VibeVoice), and publishes it
as an episode you can play on your phone from anywhere. While
you listen, you can interrupt — hold the mic button **or say the word
"question"** — ask a question out loud, hear the answer spoken back, and
resume playback. Audio in both directions is local and free; the only metered
cost in the whole system is Ollama Cloud tokens (the LLM).

### Factual correctness is a pipeline property, not a prompt

Three layers, because no single one is sufficient:

1. **Grounding** — the script is written only from a *source dossier* (the
   article, the full tweet thread + what it links to, or a web-researched
   brief with citations). The prompt forbids inventing facts, but we don't
   rely on that alone.
2. **Verification** — before synthesis, a separate pass extracts every factual
   claim from the script and checks each against the dossier (and live web
   search for topic episodes). Unsupported claims are removed or explicitly
   hedged in one bounded revision.
3. **Traceability** — every episode page lists its sources, and the Q&A chat
   answers from the same dossier, so you can always ask "where does that come
   from?" mid-listen.

Honest limit: this makes fabrications rare and catchable, not impossible — the
dossier itself can contain a source's error. The sources list is the audit
trail.

### The flow

1. **Submit** — paste a URL, an X link, or type a topic in the PWA (or
   share-sheet it from iOS via a Shortcut). The episode is queued.
2. **Source** — build the dossier, by input type:
   - *Article URL* → self-hosted **Firecrawl** (same box, own headless
     browser) returns main-content markdown + metadata.
   - *X/Twitter link* → tweet-resolver API returns the tweet, its full
     same-author thread, and any quoted tweet; a linked article inside the
     tweet is fetched via Firecrawl and appended. (X itself blocks scrapers —
     we go through a resolver, not the page.)
   - *Topic* → **research mode**: the LLM with Ollama's web search/fetch tools
     gathers current sources and writes a cited brief. The dossier is the brief
     plus the source list.
3. **Script** — an LLM rewrites the dossier as a dialogue between two hosts:
   HOST (curious, asks the questions you would) and EXPERT (explains). Output is
   structured segments, not free text.
4. **Fact-check** — a separate LLM pass lists the script's factual claims,
   verifies each against the dossier (plus fresh web search for topic
   episodes), and produces one revised script with unsupported claims cut or
   hedged. Only a verified script reaches the GPU.
5. **Synthesize** — VibeVoice-1.5B renders the whole dialogue in one pass on
   the GPU (that's what it's built for: stable voice identities and natural
   turn-taking across a full episode). faster-whisper then force-aligns the
   result to give every transcript segment a real timestamp.
6. **Listen** — the PWA lists episodes (each with its sources) and plays
   them. Media Session API so lock-screen controls work; HTTP Range support so
   scrubbing works on iOS.
7. **Interrupt** — wake word or hold-to-talk pauses playback, records your
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
compose network. Everything runs on one Linux box (rootless
container runtime, one NVIDIA GPU) and the app is fronted by HTTPS. No
message broker or second database *for our app* — at personal volume a worker
loop over a SQLite table is the whole queue (Firecrawl's internal Redis is its
own business).

Dependencies (server-side; keys via `.env` on the host):

| Dependency | Used for | Notes |
|---|---|---|
| Firecrawl (self-hosted) | URL → clean markdown + metadata | AGPL, free; 4 containers on the host; no cloud key. Cloud-only anti-bot ("fire-engine") is absent — hard-bot-walled sites may fail (see §2.3) |
| LLM provider (Ollama Cloud) | topic research (via Ollama web search/fetch), dialogue script, fact-check pass, Q&A answers | the only metered cost; `glm-5.2` by default (`OLLAMA_MODEL`; `gpt-oss:120b` also verified) |
| Tweet-resolver API | X/Twitter link → tweet + thread JSON | X blocks scrapers; resolver choice pinned in implementation.md |
| `speech` service (local GPU) | episode TTS (VibeVoice-1.5B), answer TTS (Kokoro-82M), STT + alignment (faster-whisper) | free; ~11GB VRAM budget, see §2.7 |
| ElevenLabs (optional fallback) | episode/answer TTS if local quality disappoints | pure config swap behind the SpeechProvider seam (§2.6); no key needed unless enabled |

### Honest constraints (iPhone realities)

- **Mic requires HTTPS.** `getUserMedia` only works in a secure context, so the
  PWA must be reached over HTTPS with a real certificate. Plain
  a plain `http://` LAN address will never get mic access.
- **Wake word only works with the app foregrounded and screen on.** iOS
  suspends PWA JS (and the mic) when the screen locks. Lock screen = playback
  controls only; questions need the phone awake. Platform limit, not a choice.
- **Use headphones for wake word.** On speaker the mic hears the podcast; echo
  cancellation helps, but a host saying "question" can false-trigger.
- **Episodes render slower than cloud TTS.** VibeVoice-1.5B on a consumer GPU takes
  minutes, not seconds, per episode. Irrelevant for a batch pipeline; noted so
  nobody "fixes" it. The Turing card also means fp16 (no bf16) and SDPA (no
  FlashAttention 2) — both must be set explicitly, VibeVoice defaults to bf16.
- **Cost.** Audio is free (local GPU + electricity). The only metered spend is
  Ollama Cloud tokens (research + script + fact-check + Q&A). The ElevenLabs fallback, if ever enabled,
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
      fetchers/      SourceFetcher interface + firecrawl.ts, tweet.ts, research.ts
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
submitted → sourced → scripted → verified → synthesizing → ready
     └────────┴──────────┴──────────┴────────────┴────────→ failed
```

- One worker loop: every tick, claim the oldest episode in a non-terminal,
  non-`ready` status and run **one** stage (`source`, `script`, `factcheck`,
  `synthesize`),
  then persist the new status. Concurrency 1 across the whole pipeline —
  one episode on the GPU at a time, and the loop stays trivial.
- Crash safety: statuses persist per stage; on boot the worker just resumes
  from whatever statuses it finds. An episode stuck in `synthesizing` (crash
  mid-render) is reset to `verified` and re-rendered from scratch — GPU time
  is free, so the local path has no resume machinery (segment-level resume
  exists only on the paid elevenlabs fallback path, below).
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

### 2.3 Sourcing (Strategy — one seam, three fetchers, one output shape)

Every input type resolves to the same **dossier**; nothing downstream knows
which fetcher ran.

```ts
type SourceInput =
  | { kind: "article"; url: string }
  | { kind: "tweet"; url: string }
  | { kind: "topic"; topic: string };

interface Dossier {
  markdown: string;                    // the material the script may use — nothing else
  title: string;
  sources: { title: string; url: string }[];  // ≥ 1, shown on the episode page
}

interface SourceFetcher {
  kind: SourceInput["kind"];
  fetch(input: SourceInput): Promise<Result<Dossier, FetchError>>;
}
```

Input classification happens once at the submit boundary: body is a URL →
`x.com`/`twitter.com` hosts are `tweet`, any other URL is `article`; a non-URL
text body is `topic`.

- **`article` (firecrawl)** — self-hosted instance:
  `POST ${FIRECRAWL_API_URL}/v2/scrape` (`http://firecrawl-api:3002` inside
  the compose network), `formats: ["markdown"]`, `onlyMainContent: true`,
  self-set bearer token. Empty/near-empty markdown (< 500 chars) is a
  `FetchError`, not an episode. `sources` = the article itself. Because
  `FIRECRAWL_API_URL` + key are plain env, cloud Firecrawl is a config-only
  escape hatch for bot-walled sites.
- **`tweet`** — X blocks scrapers (Firecrawl self-host will not get through);
  go through a tweet-resolver API instead of the page. The dossier is: the
  tweet, its full same-author thread in order, any quoted tweet, and — when
  the tweet links an article — that article fetched via the firecrawl fetcher
  and appended under a `## Linked article` heading. `sources` = the tweet URL
  (+ linked article URL). A bare opinion tweet with no substance still makes
  an episode — the dossier honestly says it's one person's claim, and the
  fact-check stage hedges accordingly. **X native long-form Articles** are a
  special case: the tweet's `text` is empty and the whole post lives in the
  resolver's `article` field (title + Draft.js content blocks). We render those
  blocks to markdown and the article *is* the dossier (`sources` = the article
  URL); X walls the article page, so the resolver is the only way in.
- **`topic` (research mode)** — an LLM agent loop with **Ollama's web
  search/fetch tools**: research the topic from several angles, prefer
  primary/recent sources, and write a **comprehensive** structured brief
  (~2,500–4,000 words, sectioned: facts, mechanism, state of the art/debate,
  tradeoffs, a misconception, a counterargument) where every claim carries its
  source. The brief is the only material the episode is built from, so it must
  be deep enough to support a long discussion. The dossier is the brief;
  `sources` come from the tool results. A topic that turns up no usable sources
  is a `FetchError`, not a made-up episode.

### 2.4 Storage (bun:sqlite, WAL mode)

```sql
episodes(id TEXT PK,            -- uuid v7
         source_json,           -- SourceInput: {kind, url? , topic?}
         title, status, error_json,
         dossier_json,          -- Dossier: {markdown, title, sources[]}
         script_json,           -- {segments:[{idx, speaker, text, startMs?}]}
         factcheck_json,        -- {claims:[{segmentIdx, claim, verdict, note, sourceUrl?}]} — the audit trail (shape in implementation.md §3.1b)
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

- One LLM call (Ollama, structured output): `{title, segments:[{speaker,text}]}`.
  The user content is the **dossier markdown only** — the script may not draw
  on anything else, and the prompt forbids inventing facts beyond it.
- **Deep dive, no length cap.** The script covers the dossier thoroughly and
  runs as long as the material warrants (a rich source → often 30+ min); the
  prompt sets no word/minute target and forbids padding or compressing. HOST
  asks/reacts/summarizes and EXPERT explains a level deeper than the source
  states it (mechanisms, examples, tradeoffs, a counterargument) — all still
  grounded strictly in the dossier. Opening: a short branded intro — HOST
  welcomes listeners to "Sourced," the two hosts introduce themselves by name
  (from the personas), and HOST tees up the topic — then into the substance.
  Last segment: HOST recaps the 3–5 most important takeaways and signs off.
- **Host profiles** — tunable markdown at `server/personas/host.md` (Maya, the
  female voice) and `expert.md` (Sam, the male voice), read fresh each episode
  by `hosts.ts` and appended to the script system prompt so every episode keeps
  the same two-host personas and style. The personas dir is bind-mounted into
  `learn` (read-only), so editing on the host retunes the show on the next
  episode with no rebuild. Keep genders aligned with `speech/voices/`.
- Parse, don't validate downstream: reject empty segments, unknown speakers,
  > 400 segments → stage error (a runaway guard, not a target; backoff retry
  covers model flakiness).
- **Context window.** Every Ollama call sets `num_ctx` (`OLLAMA_NUM_CTX`,
  default 65536) and `num_predict: -1`. A deep-dive script plus the fact-check
  stage's full revised script are large; the previously-unset context default
  truncated big calls, surfacing as invalid JSON. `num_ctx` must hold dossier
  + full script (+ revised script for fact-check).

### 2.5b Fact-check stage (scripted → verified)

- One LLM call, structured output: given the dossier and the script, return
  `{claims: [{claim, verdict: "supported" | "unsupported" | "distorted",
  segmentIdx, note}], revisedSegments?}`. For `topic` episodes the call also
  gets the web search tool to re-check time-sensitive claims.
- If every claim is `supported`, the script passes unchanged. Otherwise the
  same call returns the full revised script (unsupported claims removed,
  distortions corrected, genuinely-uncertain statements explicitly hedged in
  the dialogue itself — "the article claims…", "this isn't well established…").
- The revised script re-validates against the script schema; the claim table
  persists as `factcheck_json` and renders on the episode page.
- **Exactly one revision round, and the revision is trusted.** The revised
  script is schema-validated but NOT fact-checked again — no verify-revise
  loops (a looping fact-checker burns tokens and never converges). The
  fact-check stage therefore always ends in `verified` unless the call itself
  errors (bad schema, revision required but missing), which fails through the
  normal retry/attempts path with `{stage, message}` as the error.

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

- The VRAM budget assumes about 11GB with nothing else resident (verified
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
  2. LLM: system prompt = dossier markdown (with its sources list) +
     transcript segments up to positionMs (marked "the listener has heard up
     to here") + last N chat turns for this episode; answers cite which
     source they lean on when asked
  3. TTS: SpeechProvider.synthesizeAnswer (Kokoro, streamed) → pipe audio
     straight to the response (never buffer the full answer server-side)
POST /api/episodes/:id/ask-text   {question, positionMs} → {answerText}
```

- Every Q/A turn persists to `chats` — the chat pane doubles as rereadable
  show-notes.
- The question loop is a request/response path in the server, NOT a pipeline
  stage — it must never sit behind the worker queue.

### 2.9 PWA client behavior

- **Playback**: `<audio>` (no native `controls`) driven by a **custom transport**
  — large play/pause button, full-width scrubber, ±15/30s skip, tap-to-seek
  transcript — because iOS's native audio controls are small and pause
  unreliably (VERIFIED on device 2026-07-28). Media Session API still wires
  lock-screen title/seek. `GET /api/episodes/:id/audio` must support `Range`
  (206) — iOS scrubbing breaks without it; a non-206 partial response in dev is
  a bug.
- **Hold-to-talk**: press → `audio.pause()` → `MediaRecorder` → release → POST
  `/ask` → play answer stream → resume at saved position.
- **Wake word ("question")**: while playing and `document.visibilityState ===
  "visible"`, run `webkitSpeechRecognition` (continuous, interim results); any
  transcript containing the standalone word "question" triggers the
  hold-to-talk flow (pause → beep → record). Guards: `echoCancellation: true`;
  restart on iOS's ~60s recognition auto-stop (`onend` → `start()`); visible
  "listening" indicator; settings toggle. **Default off (opt-in)** — an always-on
  mic holds the iOS audio session open and can block normal play/pause, so the
  user enables it explicitly (with headphones). Fallback only if Web Speech
  proves too flaky on iOS: Porcupine WASM custom keyword — do not build
  preemptively.
- **Submission**: one text box accepting an article URL, an X link, or a
  topic (classified server-side, §2.3); plus an iOS Shortcut POSTing the
  shared URL/text to `POST /api/episodes` (accept a bare text body so the
  Shortcut is one action).
- **Episode page**: shows the sources list and the fact-check claim table —
  the audit trail behind "factually correct".

### 2.10 Deploy (compose, rootless-friendly)

- App image: Bun base + ffmpeg; `data/` bind-mounted for SQLite + audio.
- `deploy/compose.yml` services:
  - `learn` — the app, port `7900:7900`, `restart: unless-stopped`.
  - `speech` — Python/FastAPI GPU image (CUDA base). GPU via CDI:
    `devices: [nvidia.com/gpu=all]` plus `security_opt: [label=disable]` (the
    box runs SELinux enforcing; without it the container is denied
    `/dev/nvidia*`). Named volume for model weights. **No published ports** —
    only `learn` reaches it.
  - **Self-hosted Firecrawl (v2.11.0 topology, VERIFIED 2026-07-25).** The
    upstream self-host stack is now five services, not four:
    `firecrawl-api` (the harness that also runs the workers),
    `playwright-service`, `redis`, `rabbitmq`, and `nuq-postgres` (the queue
    backend moved to Postgres/RabbitMQ). We pull the upstream **ghcr images
    pinned by digest** (`ghcr.io/firecrawl/{firecrawl,playwright-service,nuq-postgres}`;
    redis/rabbitmq are stock) — do not build from source, do not track
    `latest`. Deltas from upstream's compose: remove ALL published `ports:`,
    add `shm_size: "1gb"` on playwright (Chromium /dev/shm), and
    `USE_DB_AUTHENTICATION=false` (self-host has no bearer; learn still sends
    its `FIRECRAWL_API_KEY` header, ignored server-side). The optional
    FoundationDB backend is omitted (Postgres backend is the default). **No
    published ports** — only `learn` reaches them on the compose network.
- One-time box setup for rootless GPU containers: install
  `nvidia-container-toolkit` and generate the CDI spec
  (`nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`); verify with
  `podman run --rm --device nvidia.com/gpu=all ... nvidia-smi`. Document in
  `deploy/README`.
- Env (`.env` on the host, gitignored): `FIRECRAWL_API_URL`
  (`http://firecrawl-api:3002`), `FIRECRAWL_API_KEY` (self-set token),
  `OLLAMA_API_KEY` (+ optional `OLLAMA_HOST`, `OLLAMA_MODEL`), `SPEECH_URL`
  (`http://speech:7910`), `SPEECH_PROVIDER=local`, `PORT`. ElevenLabs vars (`ELEVENLABS_API_KEY`,
  `ELEVENLABS_VOICE_HOST/EXPERT`) exist only if the fallback provider is
  enabled.
- Ship code by whatever means suits the host, build `app/dist`, then
  `podman compose up -d --build`.
- HTTPS in front of the service is required — this is what makes the mic work
  (§Part 1); it is not optional for voice. Any reverse proxy with a real
  certificate works; `tailscale serve` is the least setup on a tailnet.

### 2.11 Negative space (what must NOT happen)

- The voice round-trip never enters the pipeline queue.
- VibeVoice is never resident between episode renders — it would evict the
  interactive models' VRAM headroom (§2.7).
- The one-pass episode render is never split into per-segment TTS calls on the
  local path — cross-segment voice consistency is the point of VibeVoice.
- On the elevenlabs fallback path only: a retried synthesize never re-bills
  segments that already have files.
- No stage writes a status backwards; assert expected prior status and drop.
- The script stage sees ONLY the dossier — never raw web access, never model
  memory presented as source material.
- Nothing reaches the GPU (or the listener) without passing the fact-check
  stage; there is no "skip verification" flag.
- The fact-check stage runs exactly one revision round — never a loop.
- A topic with no usable sources fails at sourcing; the system never
  fabricates an episode from model memory alone.
- No API key (Firecrawl/Ollama/ElevenLabs-if-enabled) ever reaches the PWA —
  all external calls are server-side.
- Nothing outside `fetchers/` knows which fetcher produced the article;
  nothing outside `server/src/speech/` knows which speech provider ran.
- The Firecrawl and speech containers are never reachable from outside the
  compose network (no published ports) — a headless
  browser that fetches arbitrary URLs and a GPU service are not things the LAN
  gets to talk to.
- `audio.mp3` is immutable once status is `ready`.
- Config is parsed once at boot; a missing required env var crashes the process
  at startup, not mid-episode.
