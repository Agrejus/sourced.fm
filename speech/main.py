"""Speech service HTTP surface. Endpoints stay thin; models.py does the work.

Frozen contract:
  GET  /healthz        -> {"ok": true, "gpu": "<name>"}  (503 if CUDA is down)
  POST /stt            multipart field `audio` -> {"text": "..."}
  POST /tts/answer     JSON {"text": "..."}    -> streamed audio/wav
  POST /tts/episode    JSON {episodeId, segments:[{idx,speaker,text}]}
                       -> {audioFile, durationMs, segmentStartMs}
Any failure -> 500 {"error": "<message>"}; the caller retries via the pipeline.
"""

from __future__ import annotations

import asyncio
import os
from typing import List

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import models

DATA_DIR = os.environ.get("DATA_DIR", "/data")

app = FastAPI()
_episode_lock = asyncio.Lock()  # one VibeVoice render at a time


@app.on_event("startup")
def _startup() -> None:
    models.warmup()


class Segment(BaseModel):
    idx: int
    speaker: str
    text: str


class EpisodeRequest(BaseModel):
    episodeId: str
    segments: List[Segment]


class AnswerRequest(BaseModel):
    text: str


@app.get("/healthz")
def healthz():
    try:
        return {"ok": True, "gpu": models.gpu_name()}
    except Exception as exc:  # noqa: BLE001 — surface any CUDA failure as 503
        return JSONResponse(status_code=503, content={"ok": False, "error": str(exc)})


@app.post("/stt")
async def stt(audio: UploadFile = File(...)):
    try:
        raw = await audio.read()
        suffix = os.path.splitext(audio.filename or "")[1] or ".webm"
        text = await asyncio.to_thread(models.transcribe, raw, suffix)
        return {"text": text}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/tts/answer")
async def tts_answer(body: AnswerRequest):
    try:
        wav = await asyncio.to_thread(models.synthesize_answer_wav, body.text)

        def chunks():
            step = 64 * 1024
            for start in range(0, len(wav), step):
                yield wav[start : start + step]

        return StreamingResponse(chunks(), media_type="audio/wav")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(exc)})


@app.post("/tts/episode")
async def tts_episode(body: EpisodeRequest):
    segments = [seg.model_dump() for seg in body.segments]
    try:
        async with _episode_lock:
            audio_file, duration_ms, segment_start_ms = await asyncio.to_thread(
                models.synthesize_episode, body.episodeId, segments, DATA_DIR
            )
        return {
            "audioFile": audio_file,
            "durationMs": duration_ms,
            "segmentStartMs": segment_start_ms,
        }
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=500, content={"error": str(exc)})
