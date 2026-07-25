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
| SQLite file | `${DATA_DIR}/learn.db` (default `/data/learn.db`) |
| Episode audio | `${DATA_DIR}/episodes/<episodeId>/audio.mp3` — every path in this doc written as `/data/...` means `${DATA_DIR}/...`; both services must receive the same `DATA_DIR` |
| Speaker enum | `"HOST"` \| `"EXPERT"` (exactly, uppercase) |
| Episode statuses | `submitted → sourced → scripted → verified → synthesizing → ready`, terminal `failed` |
| Source kinds | `"article"` \| `"tweet"` \| `"topic"` |
| LLM model id | `claude-opus-4-8` |
| Web search tool (topic research + topic fact-check) | `{ type: "web_search_20260209", name: "web_search" }` |
| Tweet resolver | `https://api.fxtwitter.com` (**VERIFY**, §2.2) |
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
- It conditions on **voice prompt wav files** — ship two voices from the
  upstream demo voices into `speech/voices/host.wav` (pick a female demo
  voice) and `speech/voices/expert.wav` (pick a male demo voice); these files
  are part of the repo, not env config. Record WHICH upstream files you chose
  in a comment in `speech/models.py` and get the M1 mp3 quality check
  approved before proceeding. Kokoro answer voice: a male voice matching
  EXPERT's register (start with `am_michael`; **VERIFY** the id against the
  installed Kokoro voice list) — the answer must sound like the same person
  as EXPERT.
- Audio params: treat each model's native output as authoritative (both are
  ~24 kHz mono); never resample between VibeVoice and whisper alignment. The
  ffmpeg mp3 conversion is the only format change, and it happens last.
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

### 2.2 SourceFetcher trio (design.md §2.3, frozen interfaces)

`server/src/fetchers/types.ts`:

```ts
export type SourceInput =
  | { kind: "article"; url: string }
  | { kind: "tweet"; url: string }
  | { kind: "topic"; topic: string };
export type Dossier = { markdown: string; title: string; sources: { title: string; url: string }[] };
export type FetchError = { code: "http" | "empty" | "timeout" | "no_sources"; message: string };
export type FetchResult = { ok: true; value: Dossier } | { ok: false; error: FetchError };
export interface SourceFetcher { kind: SourceInput["kind"]; fetch(input: SourceInput): Promise<FetchResult>; }
```

**Input classification** (frozen, `classifyInput(text: string): SourceInput`;
lives in one function with unit tests):

1. Trim. It is a URL **iff** it starts with `http://` or `https://`
   (case-insensitive), OR it starts with `www.` and contains no whitespace
   (prepend `https://`). **Nothing else is ever a URL** — "AI", "Node.js",
   "kubernetes.io the website" are topics; a scheme-less deep link the user
   really meant as a URL must be pasted with its scheme. This rule is
   deliberately dumb so it is deterministic.
2. If URL: hostname (lowercased) equal to or ending in `.x.com`,
   `twitter.com`, `mobile.twitter.com`, `vxtwitter.com`, `fxtwitter.com` —
   plus bare `x.com` — → `tweet`; any other URL → `article`.
3. Otherwise → `topic`. Reject only: empty, > 500 chars.
4. Required unit cases: `"AI"`→topic, `"Node.js"`→topic,
   `"https://x.com/u/status/123"`→tweet, `"www.example.com/post"`→article,
   `"check out https://foo.com"`→topic (leading text = not a URL).

**`firecrawl.ts` (article):** `POST ${config.firecrawlApiUrl}/v2/scrape`,
headers `Authorization: Bearer ${config.firecrawlApiKey}`, body
`{"url": url, "formats": ["markdown"], "onlyMainContent": true}`, 60s timeout.
Markdown < 500 chars ⇒ `{code:"empty"}`. `sources = [{title, url}]`.
Verify the response shape against the running self-hosted instance (M5);
until then use the recorded fixture `server/test/fixtures/firecrawl.json`.

**`tweet.ts`:** never fetch `x.com` pages (blocked; also forbidden via
firecrawl). Use the fxtwitter resolver:
`GET https://api.fxtwitter.com/status/<tweetId>` (id = last numeric path
segment of the input URL). **VERIFY the JSON shape against a live call before
coding** and pin what you found in a comment + fixture
(`server/test/fixtures/fxtwitter.json`); the frozen *output* is the Dossier:

```
# <author name> (@handle) on X
<tweet text>
<subsequent same-author thread tweets, in order, blank-line separated>
## Quoted tweet            (only if present)
<quoted author + text>
## Linked article          (only if the tweet body contains a non-twitter URL)
<that URL passed through the firecrawl fetcher; skip silently on FetchError>
```

`sources` = tweet URL (+ linked-article URL if fetched). If the resolver
lacks thread expansion, fetch each `replying_to`-chained same-author tweet by
id (bounded: max 25). No API key. Resolver down ⇒ `{code:"http"}` (retry via
pipeline backoff).

**`research.ts` (topic):** one Anthropic call — copy this shape:

```ts
const response = await client.messages.create({
  model: "claude-opus-4-8",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  system: RESEARCH_SYSTEM_PROMPT,                       // Appendix B, verbatim
  tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 8 }],
  messages: [{ role: "user", content: input.topic }],
});
```

Handle `stop_reason === "pause_turn"` by appending the assistant turn and
re-calling (max 5 continuations). Dossier markdown = concatenated text blocks;
`sources` = unique `{title, url}` pairs from the `web_search_tool_result`
blocks' results **plus** any the brief cites inline. Fewer than 2 sources ⇒
`{code:"no_sources"}` — never fabricate an episode from model memory
(design.md §2.11). Note: a `web_search_tool_result` whose `content` is an
object (not a list) is a tool error — treat as `{code:"http"}`.

### 2.3 Pipeline worker (frozen behavior)

`server/src/pipeline/worker.ts` — a single `setTimeout` loop (tick = 2s):

```
tick():
  ep = claimNextPipelineEpisode()        // oldest episode with status IN
       (submitted, sourced, scripted, verified) AND next_attempt_at <= now
  if none: reschedule tick; return
  stage = STAGE_BY_STATUS[ep.status]     // submitted→source, sourced→script,
                                         // scripted→factcheck, verified→synthesize
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
  `verified` once (guard with an `attempts` bump).

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
  messages: [{ role: "user", content: dossier.markdown }],
  output_config: { format: zodOutputFormat(ScriptSchema) },
});
if (!response.parsed_output) throw new Error("script parse failed"); // worker retry covers it
```

The user content is `dossier.markdown` and nothing else — the script stage
never gets tools, web access, or extra context (design.md §2.11). Stamp `idx`
(array order) onto segments before storing. Store as `script_json`. Do not
post-process the text (no markdown stripping — the prompt forbids markdown).

**Title rule (frozen):** the `source` stage writes `episodes.title` from
`dossier.title`; the `script` stage overwrites it with the script's `title`.
The script title wins — it's written for listeners.

**M3 pre-flight (do before writing the stages):** create
`server/scripts/anthropic-smoke.ts` making ONE `messages.parse` call with a
trivial 2-field zod schema and `thinking: {type: "adaptive"}`, run it, and
keep it checked in. The SDK snippets in this file are believed-current but
are upstream-volatile — if the smoke call fails on any surface detail
(import path, `output_config`, `parsed_output`), rule 2 applies: fix the
spec's snippets first, then implement.

### 3.1b Fact-check stage (`server/src/pipeline/factcheck.ts`)

One structured-output call; for `topic` episodes it ALSO gets the web search
tool (structured outputs + tools work together — keep the same
`output_config`):

```ts
const FactcheckSchema = z.object({
  claims: z.array(z.object({
    segmentIdx: z.number().int(),
    claim: z.string(),
    verdict: z.enum(["supported", "unsupported", "distorted"]),
    note: z.string(),
    sourceUrl: z.string().optional(),
  })).min(1),
  revisedSegments: z.array(z.object({
    speaker: z.enum(["HOST", "EXPERT"]),
    text: z.string().min(1),
  })).min(6).max(60).optional(),        // REQUIRED iff any verdict !== "supported"
});

const response = await client.messages.parse({
  model: "claude-opus-4-8",
  max_tokens: 16000,
  thinking: { type: "adaptive" },
  system: FACTCHECK_SYSTEM_PROMPT,      // Appendix B, verbatim
  tools: episode.source.kind === "topic"
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }]
    : undefined,
  messages: [{ role: "user", content:
    `## Sources dossier\n${dossier.markdown}\n\n## Script\n` +
    segments.map(s => `[${s.idx}] ${s.speaker}: ${s.text}`).join("\n") }],
  output_config: { format: zodOutputFormat(FactcheckSchema) },
});
```

Stage logic (frozen — this stage NEVER moves an episode to `failed` on its
own; only the worker's attempts-exhausted path does):
1. All verdicts `supported` → status `verified`, script unchanged. If the
   model returned `revisedSegments` anyway, IGNORE them.
2. Any verdict not `supported` → `revisedSegments` must be present (missing
   ⇒ throw = stage error → worker retry/backoff); replace `script_json`
   segments with the revision (re-stamp `idx`), status `verified`.
   **The revision is trusted — do not fact-check it again.** One round.
3. `factcheck_json` (the claim table) is stored in BOTH cases — the
   all-supported table is the positive audit trail.

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
    { type: "text", text: groundingBlock(episode),          // dossier markdown + sources list + FULL transcript with [mm:ss] stamps + Appendix B answer rules
      cache_control: { type: "ephemeral" } },               // stable per episode → cached across questions
    { type: "text", text: `The listener has heard up to ${mmss(positionMs)}. Do not spoil later parts unless asked.` },
  ],
  messages: [...lastNChatTurns(episodeId, 6), { role: "user", content: question }],
});
```

Persist both turns to `chats` (with `position_ms` on the user turn). Answer
must come back as plain spoken prose (the Appendix B rules say no markdown,
≤ 120 words) because it goes straight to TTS.

Helper contracts (frozen; all live in `server/src/api/ask.ts` except noted):

- `mmss(positionMs: number): string` — zero-padded `m:ss` (`754000` →
  `"12:34"`; hours roll into minutes, `"75:10"` is fine).
- `groundingBlock(episode): string` — exactly this template:
  ```
  ## Sources
  <one "- <title>: <url>" line per dossier.sources entry>

  ## Source dossier
  <dossier.markdown>

  ## Episode transcript
  <one "[m:ss] SPEAKER: text" line per script segment, using startMs>

  ## Answer rules
  <Appendix B answer rules, verbatim>
  ```
- `lastNChatTurns(episodeId, n): MessageParam[]` — the last `n` chats rows
  ordered oldest→newest mapped 1:1 to `{role, content: text}`; if the oldest
  included row is an `assistant` turn, drop it (history must start with
  `user`).
- `beep()` (PWA, `app/src/audio.ts`) — a 150 ms 880 Hz sine via WebAudio
  `OscillatorNode`; no audio asset file.

**DONE-gate:** integration test with a fixture article produces a valid script
(schema passes, 6–60 segments, both speakers present); fact-check on that
script returns ≥ 1 claim and reaches `verified`; a poisoned-script test (a
fixture script with one planted false claim not in the dossier) comes back
non-supported with a revision; `classifyInput` unit tests (article/tweet/topic
+ rejects); `ask-text` against a seeded episode returns a non-empty answer and
writes 2 chat rows; second ask-text call shows
`usage.cache_read_input_tokens > 0` (log it).

---

## M4 — API surface + PWA

### 4.1 Frozen REST contract (all under the `learn` service)

| Method + path | Request | Response |
|---|---|---|
| `GET /api/healthz` | — | `{"ok":true}` |
| `POST /api/episodes` | JSON `{input: "<url or topic text>"}` **or** raw `text/plain` body (iOS Shortcut); server runs `classifyInput` (§2.2) | `201 {id, status:"submitted", source:{kind,...}}`; rejected input → `400 {error}` |
| `GET /api/episodes` | — | `[{id,title,status,sourceKind,durationMs,createdAt}]` newest first |
| `GET /api/episodes/:id` | — | full episode incl. `source`, `dossier.sources`, `factcheck.claims`, `script.segments[].startMs`, `error`. **`dossier.markdown` is NEVER returned by any route** — it is server-side grounding material only; clients get `dossier.sources` |
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
- **Submit box**: one text input, placeholder "Article URL, X link, or a
  topic…" → POST → optimistic list entry that polls `GET /api/episodes/:id`
  every 5s until `ready`/`failed`.
- **Episode detail**: sources list (tappable links) and, when present, the
  fact-check claim table (claim / verdict / note) — collapsed by default.

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

**DONE-gate (on the box):** end-to-end for ALL THREE input kinds — a real
article URL, a real X thread link, and a topic (e.g. "what changed in
Postgres 18") — each via `curl -X POST .../api/episodes -d '{"input":"..."}'`
→ poll until `ready` → download audio.mp3, listen; for the topic episode
confirm `dossier.sources` ≥ 2 and `factcheck.claims` is populated. `curl http://<box>:3002` from another
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
  source_json     TEXT NOT NULL,                -- SourceInput {kind, url?|topic?}
  title           TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'submitted'
                  CHECK (status IN ('submitted','sourced','scripted','verified','synthesizing','ready','failed')),
  error_json      TEXT,
  dossier_json    TEXT,                          -- Dossier {markdown, title, sources[]}
  script_json     TEXT,
  factcheck_json  TEXT,                          -- {claims:[...]} audit trail
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

`RESEARCH_SYSTEM_PROMPT`:

```
You are a research assistant preparing a source dossier for a factual
podcast. Research the topic the user provides using web search. Prefer
primary sources and reporting from the last year where recency matters.

Write a structured brief in markdown:
- Open with a two-sentence framing of why the topic matters now.
- Cover the key facts, the state of the art or debate, and at least one
  common misconception.
- EVERY factual claim must name its source inline, like: "... (Source:
  <publication>, <url>)". A claim you cannot source does not go in the brief.
- End with a "## Sources" section listing every source as "- <title>: <url>".
- 800 to 1,500 words. No filler.
```

`SCRIPT_SYSTEM_PROMPT`:

```
You write scripts for a two-host learning podcast. Rewrite the source
dossier the user provides as a natural spoken dialogue between HOST and
EXPERT.

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
- Use ONLY facts present in the dossier. Do not add facts, numbers, names,
  or dates from your own knowledge, even correct ones.
- Preserve attribution: if the dossier attributes a claim to a source or a
  person (including a single tweet), the dialogue attributes it the same way
  — "she argues that...", "the paper claims...", never as established fact.
```

`FACTCHECK_SYSTEM_PROMPT`:

```
You are a fact-checker for a podcast. You receive a source dossier and a
script. Your job: no factual statement survives that the dossier does not
support.

1. List every checkable factual claim in the script (numbers, dates, names,
   causal statements, attributions). Give each the segment index it appears
   in.
2. Verdict per claim:
   - supported: the dossier states it, with the same meaning and strength.
   - distorted: the dossier says something related but the script changed
     the number, strength, or attribution.
   - unsupported: the dossier does not contain it.
   If you have a web search tool, use it to re-check time-sensitive claims;
   a claim confirmed by search counts as supported (set sourceUrl).
3. If ANY claim is distorted or unsupported, return revisedSegments: the
   complete corrected script (same style rules as the original), with
   distorted claims fixed, unsupported claims removed or rewritten as
   explicitly attributed uncertainty ("the thread claims, though this isn't
   confirmed..."). Keep the dialogue natural — repair, don't amputate.
Opinions, rhetorical questions, and the hosts' own framing are not claims.
Be strict about numbers and attribution; do not pass a claim as supported
because it is plausible.
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
- [ ] Fetching x.com/twitter.com through Firecrawl → blocked/garbage; tweets
      go through the resolver only.
- [ ] Giving the script stage web search "to be helpful" → forbidden; only
      research and topic-fact-check calls get tools.
- [ ] Skipping or looping the fact-check stage → exactly one pass, one
      revision round, always stored; no bypass flag exists.
- [ ] Topic with < 2 sources turned into an episode anyway → must fail with
      no_sources; never script from model memory.
- [ ] Forgetting `pause_turn` handling on web-search calls → silently
      truncated research briefs.
