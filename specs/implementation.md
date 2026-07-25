# Implementation plan — podcast-learning

This document is the **build order and exact contracts** for `specs/design.md`.
Read design.md first for intent; this file wins on any detail-level conflict.

## Rules for the implementing agent (read before writing any code)

1. **Work milestone by milestone, in order (M0 → M6).** Do not start a
   milestone until the previous milestone's DONE-gate commands pass. Do not
   build ahead ("while I'm here…").
2. **The HTTP contracts, SQL DDL, env var names, and directory layout in this
   file are FROZEN.** If upstream reality (a library API, the VibeVoice repo)
   forces a change to a frozen contract, STOP and update this spec first in the
   same commit — never silently diverge.
3. **Internals are yours; seams are not.** Inside a module, adapt to what the
   libraries actually expose. At module boundaries, match this file exactly.
4. **Where this file says VERIFY, run the command and paste the output into
   the commit message or PR notes.** A milestone without its gate output is
   not done.
5. **No extra dependencies** beyond the pinned list per milestone. If you
   think you need one, that's a spec change (rule 2).
6. Never put a ticket ID or spec reference in code comments.
7. Anything in design.md §2.11 (negative space) is an acceptance criterion,
   not advice.

## Fixed identifiers (use these exact strings everywhere)

| Thing | Value |
|---|---|
| App service name / container | `learn` (port **7900**) |
| Speech service name / container | `speech` (port **7910**, internal only) |
| Firecrawl API base (internal) | `http://firecrawl-api:3002` |
| Shared data mount (both learn + speech) | host `./data` → container `/data` |
| SQLite file | `/data/learn.db` |
| Episode audio | `/data/episodes/<episodeId>/audio.mp3` |
| Speaker enum | `"HOST"` \| `"EXPERT"` (exactly, uppercase) |
| Episode statuses | `submitted → scraped → scripted → synthesizing → ready`, terminal `failed` |
| LLM model id | `claude-opus-4-8` |
| Whisper model | `distil-small.en` (faster-whisper) |
| Episode TTS model | `microsoft/VibeVoice-1.5B` |
| Answer TTS model | Kokoro-82M (`hexgrad/Kokoro-82M`) |

---

## M0 — Scaffold and tooling

Create:

```
server/            (bun init; Hono)
  src/index.ts     boots config → db → http → worker; crashes on bad config
  src/config.ts    parse env ONCE at boot (see env table, Appendix C)
  src/db.ts        bun:sqlite, WAL mode, schema from Appendix A, migrations = CREATE TABLE IF NOT EXISTS
app/               (bun create vite → react-ts template)
speech/            Python 3.11, FastAPI (see M1)
deploy/            compose.yml + README.md (box setup)
data/              gitignored
```

Pinned deps — server: `hono`, `@anthropic-ai/sdk`, `zod`. Nothing else
(uuid v7 via `Bun.randomUUIDv7()`, sqlite via `bun:sqlite` — built in).
Pinned deps — app: react, react-dom only (Vite template defaults). No UI
library, no state library, no router (single page).

`config.ts` contract: exports a frozen `config` object; a missing required
env var throws at import time with the var name in the message. Never read
`process.env` anywhere else in the server.

**DONE-gate:** `cd server && bun run src/index.ts` starts, logs the port,
`curl localhost:7900/api/healthz` → `{"ok":true}`; `bun test` runs (0 tests ok).

---

## M1 — Speech service (do this FIRST after scaffold; riskiest unknown)

Python 3.11 + FastAPI + uvicorn. All models load via functions in
`speech/models.py`; endpoints in `speech/main.py` stay thin.

### 1.1 Frozen HTTP contract

| Endpoint | Request | Response |
|---|---|---|
| `GET /healthz` | — | `200 {"ok": true, "gpu": "<torch.cuda.get_device_name(0)>"}` — must FAIL (503) if CUDA unavailable |
| `POST /stt` | multipart field `audio` (webm/mp4/wav bytes) | `200 {"text": "<transcript>"}` |
| `POST /tts/answer` | JSON `{"text": "..."}` | `200 audio/wav` **streamed** body |
| `POST /tts/episode` | JSON `{"episodeId": "...", "segments": [{"idx": 0, "speaker": "HOST", "text": "..."}]}` | `200 {"audioFile": "audio.mp3", "durationMs": <int>, "segmentStartMs": [<int per segment, same order>]}` |

`/tts/episode` writes `/data/episodes/<episodeId>/audio.mp3` itself (shared
mount) — audio bytes never travel over HTTP for episodes. Errors: any failure
returns `500 {"error": "<message>"}`; the caller retries via the pipeline.

### 1.2 Residency policy (frozen)

- Load **once at boot, keep resident**: faster-whisper `distil-small.en`
  (`device="cuda", compute_type="float16"`), Kokoro.
- **VibeVoice loads inside the `/tts/episode` handler and is released before
  returning** (`del model; torch.cuda.empty_cache()`), in a `finally` block.
- One global `asyncio.Lock` around the whole `/tts/episode` handler.

### 1.3 VibeVoice specifics (verify against upstream, then freeze your wrapper)

Before writing the wrapper, **read the pinned upstream README**
(`github.com/microsoft/VibeVoice`, pin the commit hash you used in
`speech/requirements.txt` comments). Known facts to build around — verify each:

- Input is the full script as text with per-line speaker labels
  (`Speaker 1: ...` / `Speaker 2: ...`). Map `HOST → Speaker 1`,
  `EXPERT → Speaker 2` in one function `to_vibevoice_script(segments)`.
- It conditions on **voice prompt wav files** — ship two chosen voices from
  the upstream demo voices into `speech/voices/host.wav` and
  `speech/voices/expert.wav`; these files are part of the repo, not env config.
- **Turing constraints (2080 Ti): `torch_dtype=torch.float16` (the repo
  defaults to bfloat16 — Turing has no bf16) and `attn_implementation="sdpa"`
  (FlashAttention 2 does not support Turing).** If the upstream loader doesn't
  expose these, patch at load time; do not skip.
- Output is a wav; convert to mp3 with ffmpeg
  (`ffmpeg -i in.wav -codec:a libmp3lame -qscale:a 4 out.mp3`).

### 1.4 Timestamp alignment (frozen algorithm)

After rendering, produce `segmentStartMs` with faster-whisper against the
generated audio (`word_timestamps=True`):

1. Normalize (lowercase, strip everything but `[a-z0-9 ]`) both the whisper
   word list and each script segment's text.
2. Greedy walk: for each segment in order, advance a pointer through the
   whisper words until you've consumed ≥ 80% of that segment's words (matched
   in order, allowing skips); the timestamp of the first matched word is that
   segment's `startMs`.
3. If any segment matches < 50% of its words, discard alignment for the whole
   episode and fall back to **proportional-by-character-count** over
   `durationMs`. Never fail the episode over alignment.
4. `segmentStartMs[0]` is always `0`. Values must be non-decreasing (clamp).

Write `speech/test_align.py` covering: perfect match, noisy match, fallback
trigger, monotonicity. These run on CPU with synthetic word lists (no GPU).

### 1.5 GPU container + box setup

- `speech/Dockerfile`: `FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04`, install
  python3.11, pip deps from `requirements.txt` (pin every version), ffmpeg.
  Model weights go to a named volume via `HF_HOME=/models` (declare volume).
- One-time on the box (document in `deploy/README.md`):
  `sudo rpm-ostree install nvidia-container-toolkit` (Silverblue) or dnf
  equivalent, reboot if needed, then
  `sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml`.
- **VERIFY on the box before writing any more code:**
  `podman run --rm --device nvidia.com/gpu=all docker.io/nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi`
  must print the 2080 Ti. If this fails, fix CDI before proceeding.

**DONE-gate (run on the box):**
1. `curl speech:7910/healthz` → `{"ok":true,"gpu":"NVIDIA GeForce RTX 2080 Ti"}`
2. `python speech/smoke_episode.py` — a checked-in script that POSTs a 6-segment
   two-speaker script to `/tts/episode`, asserts the mp3 exists, durationMs > 0,
   segmentStartMs is monotonic. **Listen to the mp3** (send it to the user for
   a quality check before building anything downstream).
3. `/stt` round-trip: record any short wav, POST it, get sensible text.
4. `nvidia-smi` after step 2 shows VibeVoice memory released (< 4GB used).

---

## M2 — Server core: db, fetcher, pipeline

### 2.1 SQL (Appendix A is the frozen DDL)

`db.ts` exposes typed functions only — no raw SQL outside this file:
`insertEpisode`, `getEpisode`, `listEpisodes`, `claimNextPipelineEpisode`,
`updateEpisodeStage` (asserts expected prior status — throws on mismatch),
`failEpisode`, `insertChat`, `listChats`.

### 2.2 ArticleFetcher (design.md §2.3, frozen interface)

`server/src/fetchers/types.ts`:

```ts
export type FetchedArticle = { markdown: string; title: string; byline?: string; siteName?: string };
export type FetchError = { code: "http" | "empty" | "timeout"; message: string };
export type FetchResult = { ok: true; value: FetchedArticle } | { ok: false; error: FetchError };
export interface ArticleFetcher { id: "firecrawl"; fetch(url: string): Promise<FetchResult>; }
```

`firecrawl.ts`: `POST ${config.firecrawlApiUrl}/v2/scrape`, headers
`Authorization: Bearer ${config.firecrawlApiKey}`, body
`{"url": url, "formats": ["markdown"], "onlyMainContent": true}`, 60s timeout.
Markdown < 500 chars ⇒ `{ok:false, error:{code:"empty"}}`. Result shape:
verify against the running self-hosted instance (M5 stands it up; until then
develop against a recorded fixture in `server/test/fixtures/firecrawl.json`).

### 2.3 Pipeline worker (frozen behavior)

`server/src/pipeline/worker.ts` — a single `setTimeout` loop (tick = 2s):

```
tick():
  ep = claimNextPipelineEpisode()        // oldest episode with status IN
       (submitted, scraped, scripted) AND next_attempt_at <= now
  if none: reschedule tick; return
  stage = STAGE_BY_STATUS[ep.status]     // submitted→scrape, scraped→script, scripted→synthesize
  try:
    await stage.run(ep)                  // each stage does its work then
                                         // updateEpisodeStage(ep.id, expectedPrior, next, patch)
  catch e:
    attempts+1; attempts > 5 ? failEpisode(ep.id, stage.name, message)
                             : set next_attempt_at = now + 30s * 2^attempts
  finally: reschedule tick immediately (0ms) so a queue drains fast
```

- `synthesize.run`: set status `synthesizing`, call
  `POST ${config.speechUrl}/tts/episode` (no request timeout — episodes take
  minutes; rely on the speech service's own failure responses), then write
  `audio_path`, `duration_ms`, stamp `startMs` into `script_json` segments,
  status → `ready`.
- Concurrency is exactly 1 (the single loop *is* the guarantee — do not add
  workers, queues, or Promise.all here).
- On boot, episodes stuck in `synthesizing` (crash mid-render) are reset to
  `scripted` once (guard with an `attempts` bump).

**DONE-gate:** `bun test` green with: status-machine unit tests (no backwards
writes; unexpected prior status throws), worker integration test with all
three stages stubbed, fetcher test against the fixture.

---

## M3 — LLM stages: script generation + ask

Both use `@anthropic-ai/sdk` with `new Anthropic()` (key from env). Model:
`claude-opus-4-8`. No `temperature`/`top_p` (removed on this model — 400).
Omit `thinking` except where stated.

### 3.1 Script generation (`server/src/pipeline/script.ts`)

Use structured outputs — copy this shape exactly:

```ts
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

const ScriptSchema = z.object({
  title: z.string(),
  segments: z.array(z.object({
    speaker: z.enum(["HOST", "EXPERT"]),
    text: z.string().min(1),
  })).min(6).max(60),
});

const response = await client.messages.parse({
  model: "claude-opus-4-8",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  system: SCRIPT_SYSTEM_PROMPT,           // Appendix B, verbatim
  messages: [{ role: "user", content: articleMarkdown }],
  output_config: { format: zodOutputFormat(ScriptSchema) },
});
if (!response.parsed_output) throw new Error("script parse failed"); // worker retry covers it
```

Stamp `idx` (array order) onto segments before storing. Store as
`script_json`. Do not post-process the text (no markdown stripping — the
prompt forbids markdown).

### 3.2 Ask endpoints (`server/src/api/ask.ts`)

- `POST /api/episodes/:id/ask-text` `{question, positionMs}` →
  `{answerText}`.
- `POST /api/episodes/:id/ask` multipart `audio` + field `positionMs` →
  `audio/wav` stream, header `X-Answer-Text: <base64 of answerText>` (base64
  because header values can't hold arbitrary text).
  Flow: speech `/stt` → same answer path as ask-text → speech `/tts/answer`,
  piping the wav stream straight through (`return new Response(upstream.body)`
  — never buffer).

Answer LLM call (both endpoints), with prompt caching on the big stable block:

```ts
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 1024,
  system: [
    { type: "text", text: groundingBlock(episode),          // article markdown + FULL transcript with [mm:ss] stamps + Appendix B answer rules
      cache_control: { type: "ephemeral" } },               // stable per episode → cached across questions
    { type: "text", text: `The listener has heard up to ${mmss(positionMs)}. Do not spoil later parts unless asked.` },
  ],
  messages: [...lastNChatTurns(episodeId, 6), { role: "user", content: question }],
});
```

Persist both turns to `chats` (with `position_ms` on the user turn). Answer
must come back as plain spoken prose (the Appendix B rules say no markdown,
≤ 120 words) because it goes straight to TTS.

**DONE-gate:** integration test with a fixture article produces a valid script
(schema passes, 6–60 segments, both speakers present); `ask-text` against a
seeded episode returns a non-empty answer and writes 2 chat rows; second
ask-text call shows `usage.cache_read_input_tokens > 0` (log it).

---

## M4 — API surface + PWA

### 4.1 Frozen REST contract (all under the `learn` service)

| Method + path | Request | Response |
|---|---|---|
| `GET /api/healthz` | — | `{"ok":true}` |
| `POST /api/episodes` | JSON `{url}` **or** raw `text/plain` body that is a bare URL (iOS Shortcut) | `201 {id, status:"submitted"}`; invalid URL → `400 {error}` |
| `GET /api/episodes` | — | `[{id,title,status,durationMs,createdAt}]` newest first |
| `GET /api/episodes/:id` | — | full episode incl. `script.segments[].startMs`, `error` |
| `GET /api/episodes/:id/audio` | supports `Range` | `200`/`206 audio/mpeg`, `Accept-Ranges: bytes` |
| `GET /api/episodes/:id/chats` | — | `[{role,text,positionMs,createdAt}]` |
| `POST .../ask`, `POST .../ask-text` | see M3 | see M3 |

Range serving (do it manually; do not hope a helper does it):
parse `Range: bytes=<start>-<end?>`; respond `206` with
`Content-Range: bytes <start>-<end>/<size>`, `Content-Length`, and
`Bun.file(path).slice(start, end + 1)`; no Range header → `200` full file with
`Accept-Ranges: bytes`. Malformed/unsatisfiable → `416`.
**VERIFY:** `curl -sD- -o/dev/null -H "Range: bytes=0-99" .../audio` → `206`,
`Content-Length: 100`. This is the single most common thing to get wrong and
it breaks iOS scrubbing.

The `learn` service serves the built PWA: static from `app/dist` for any
non-`/api` path (SPA fallback to `index.html`).

### 4.2 PWA behaviors (one page, three zones: episode list, player, chat pane)

- **Manifest + icons** so it installs to the home screen; no service worker
  beyond the minimal one required for install (no offline caching of audio —
  YAGNI).
- **Player**: `<audio>` with `src=/api/episodes/:id/audio`. Media Session API:
  set title/artist and `setActionHandler` for play/pause/seekbackward(15)/
  seekforward(30). Highlight the current transcript segment via
  `timeupdate` vs `startMs`.
- **Hold-to-talk button** (frozen flow, reuse for wake word):
  ```
  interrupt():
    positionMs = audio.currentTime*1000; audio.pause(); beep()
    rec = MediaRecorder(getUserMedia({audio:{echoCancellation:true}}))
    ... stop on release (or 15s cap) ...
    resp = POST /ask (multipart)
    answerAudio = new Audio(URL.createObjectURL(await resp.blob()))
    show base64-decoded X-Answer-Text in chat pane
    answerAudio.onended = () => { audio.currentTime = positionMs/1000; audio.play() }
    answerAudio.play()
  ```
- **Wake word** (design.md §2.9, frozen guards): arm
  `new (window.SpeechRecognition || window.webkitSpeechRecognition)()` with
  `continuous=true, interimResults=true` only while
  `!audio.paused && document.visibilityState === "visible"` and the settings
  toggle is on; any result whose transcript matches `/\bquestion\b/i` calls
  `interrupt()`; `onend` → `start()` again (iOS auto-stops ~60s); disarm
  during the interrupt flow (or it hears the answer). Feature-detect: if
  SpeechRecognition is absent, hide the toggle — hold-to-talk still works.
  Persistent "listening" indicator whenever recognition is armed.
- **Mic requires HTTPS**: if `!window.isSecureContext`, hide mic UI and show
  "voice needs the Tailscale HTTPS address" hint. Do not try anyway.
- **Submit box**: paste URL → POST → optimistic list entry that polls
  `GET /api/episodes/:id` every 5s until `ready`/`failed`.

**DONE-gate:** `bun run build` in app/; serve via learn; on desktop browser:
submit → (stubbed pipeline ok locally) → play, scrub, ask-text in chat pane.
Range curl check passes. Real-iPhone voice testing lands in M6.

---

## M5 — Compose + Firecrawl + deploy

- `deploy/compose.yml`: services `learn`, `speech`, `firecrawl-api`,
  `firecrawl-worker`, `firecrawl-redis`, `firecrawl-playwright`.
  **Copy the service definitions from Firecrawl's own self-host
  `docker-compose.yaml` at a pinned release tag** (record the tag in a comment)
  — do not invent image names or env; then apply our deltas: remove ALL
  `ports:` from firecrawl services, `shm_size: "1gb"` on playwright,
  set the self-host auth key from `.env`.
- `learn`: build from `server/Dockerfile` (bun image + ffmpeg + `app/dist`
  copied in), `ports: ["7900:7900"]`, mounts `./data:/data`.
- `speech`: `devices: ["nvidia.com/gpu=all"]`, mounts `./data:/data` +
  models volume. No ports.
- Box flow (document in `deploy/README.md`): push over SSH
  (`git config receive.denyCurrentBranch updateInstead` on the box, clone at
  `~/Repos/podcast-learning`), then `podman compose up -d --build`.
- Tailscale: `sudo tailscale up`, then `sudo tailscale serve --bg 7900`.

**DONE-gate (on the box):** end-to-end with a real article URL:
`curl -X POST .../api/episodes -d '{"url":"<real article>"}'` → poll until
`ready` → download audio.mp3, listen. `curl http://<box>:3002` from another
LAN machine must FAIL (firecrawl not exposed). `https://<tailnet-name>/`
loads the PWA with a valid cert.

---

## M6 — iPhone verification pass (no new code, fix what fails)

On the actual iPhone over Tailscale HTTPS: install to home screen; lock-screen
controls work; scrubbing works; hold-to-talk round trip < ~6s to first answer
audio; wake word "question" triggers with headphones on; wake word survives
> 60s of playback (the auto-restart); backgrounding disarms cleanly. File and
fix; each fix re-verified on device.

---

## Appendix A — SQLite DDL (frozen)

```sql
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS episodes (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','scraped','scripted','synthesizing','ready','failed')),
  error_json      TEXT,
  article_json    TEXT,
  script_json     TEXT,
  audio_path      TEXT,
  duration_ms     INTEGER,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,   -- epoch ms
  created_at      INTEGER NOT NULL,             -- epoch ms
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_episodes_pipeline ON episodes(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS chats (
  id          TEXT PRIMARY KEY,
  episode_id  TEXT NOT NULL REFERENCES episodes(id),
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text        TEXT NOT NULL,
  position_ms INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_episode ON chats(episode_id, created_at);
```

## Appendix B — Prompts (verbatim; changes are spec changes)

`SCRIPT_SYSTEM_PROMPT`:

```
You write scripts for a two-host learning podcast. Rewrite the article the
user provides as a natural spoken dialogue between HOST and EXPERT.

HOST is curious and asks the questions a smart listener would ask; HOST also
reacts, summarizes, and keeps momentum. EXPERT explains clearly with concrete
examples and analogies, and corrects common misconceptions.

Requirements:
- 1,500 to 2,200 words of dialogue total (10-15 spoken minutes).
- First segment: HOST cold-opens with why this article matters — no
  greetings, no "welcome to the show".
- Last segment: HOST recaps exactly three takeaways.
- Alternate speakers naturally; no speaker twice in a row unless it reads
  better.
- Spoken-word style: contractions, short sentences. Spell out numbers,
  abbreviations, and symbols the way a person would say them.
- NO markdown, NO stage directions, NO sound-effect cues, NO segment titles.
  Text fields contain only words to be spoken aloud.
- Do not invent facts that are not in the article; attribute claims the
  article attributes.
```

Answer rules (appended inside `groundingBlock`):

```
You are EXPERT from this podcast answering a listener question mid-episode.
Answer from the article and transcript above. Spoken prose only — no
markdown, no lists, no headings. At most 120 words. If the answer is coming
later in the episode, say so briefly without spoiling detail. If the article
does not cover it, say so and answer from general knowledge, flagged as such.
```

## Appendix C — Environment variables (complete set; config.ts rejects unknowns it requires)

| Var | Required | Consumer | Example |
|---|---|---|---|
| `PORT` | no (7900) | learn | `7900` |
| `DATA_DIR` | no (`/data`) | learn | `/data` |
| `ANTHROPIC_API_KEY` | yes | learn | `sk-ant-...` |
| `FIRECRAWL_API_URL` | yes | learn | `http://firecrawl-api:3002` |
| `FIRECRAWL_API_KEY` | yes | learn + firecrawl | self-set token |
| `SPEECH_URL` | yes | learn | `http://speech:7910` |
| `SPEECH_PROVIDER` | no (`local`) | learn | `local` |
| `HF_HOME` | no (`/models`) | speech | `/models` |

ElevenLabs vars intentionally absent — they arrive only if the fallback
provider is ever built (design.md §2.6).

## Appendix D — Things a hurried implementer gets wrong (checklist)

- [ ] bf16 on Turing → must be fp16 (VibeVoice defaults to bf16; it will
      crash or silently produce garbage).
- [ ] FlashAttention 2 on Turing → must be SDPA.
- [ ] VibeVoice left resident after an episode → interactive VRAM gone (§1.2).
- [ ] Per-segment VibeVoice calls → voices drift; one pass only (design §2.11).
- [ ] Missing Range support → iOS scrubbing broken (M4 curl check).
- [ ] Mic on plain http → getUserMedia rejects; HTTPS via tailscale serve only.
- [ ] Wake-word recognition left armed during the answer → it hears itself.
- [ ] `temperature` on claude-opus-4-8 → 400.
- [ ] Buffering the answer TTS server-side → kills perceived latency; pipe.
- [ ] Publishing firecrawl/speech ports → forbidden (design §2.11).
- [ ] Reading `process.env` outside config.ts.
- [ ] Status written backwards or skipping a state → updateEpisodeStage throws;
      don't "fix" by removing the assert.
