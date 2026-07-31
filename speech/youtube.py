"""YouTube transcript extraction.

Captions cannot be scraped from the watch page any more: the timedtext endpoint
now answers 200 with an empty body unless the request carries a proof-of-origin
token, so the signed `baseUrl` in `ytInitialPlayerResponse` is useless to us.
yt-dlp tracks that plumbing, so extraction lives here rather than in the Bun
service, which also puts it next to the GPU for the fallback path.

Two paths, in order:
  1. Published or automatic captions, fetched by yt-dlp. Cheap, no GPU.
  2. No captions at all: download the audio and transcribe with the resident
     faster-whisper model. Slower, and the result is better punctuated.
"""

from __future__ import annotations

import json
import os
import tempfile
from typing import List, Optional, Tuple

import yt_dlp

import models

# A caption file below this is a stub (a few placeholder cues), not a transcript.
MIN_TRANSCRIPT_CHARS = 400
# Whisper on a long video is minutes of GPU. Beyond this, refuse rather than
# tie up the renderer for an hour.
MAX_WHISPER_SECONDS = 90 * 60
# Auto-captions arrive a word or two at a time; group them into paragraphs.
SEGMENTS_PER_PARAGRAPH = 14

_QUIET = {"quiet": True, "no_warnings": True, "noprogress": True}


def _text_from_json3(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as fh:
        data = json.load(fh)
    pieces: List[str] = []
    for event in data.get("events") or []:
        text = "".join(seg.get("utf8", "") for seg in (event.get("segs") or []))
        text = " ".join(text.split())
        if text:
            pieces.append(text)
    return "\n\n".join(
        " ".join(pieces[i : i + SEGMENTS_PER_PARAGRAPH])
        for i in range(0, len(pieces), SEGMENTS_PER_PARAGRAPH)
    ).strip()


def _text_from_vtt(path: str) -> str:
    """Fallback parser: strip WebVTT cue headers, tags and repeated lines."""
    out: List[str] = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for raw in fh:
            line = raw.strip()
            if (
                not line
                or line.startswith("WEBVTT")
                or line.startswith(("NOTE", "Kind:", "Language:", "STYLE"))
                or "-->" in line
                or line.isdigit()
            ):
                continue
            line = " ".join(line.replace("&nbsp;", " ").split())
            # rolling auto-captions repeat the previous line as context
            if line and (not out or out[-1] != line):
                out.append(line)
    return "\n\n".join(
        " ".join(out[i : i + SEGMENTS_PER_PARAGRAPH])
        for i in range(0, len(out), SEGMENTS_PER_PARAGRAPH)
    ).strip()


def _pick_caption_file(directory: str) -> Optional[str]:
    """Prefer a published track over an automatic one, and json3 over vtt."""
    files = os.listdir(directory)

    def rank(name: str) -> Tuple[int, int, int]:
        auto = 1 if ".en-orig." in name or "-en." in name else 0
        fmt = 0 if name.endswith(".json3") else 1
        return (auto, fmt, -os.path.getsize(os.path.join(directory, name)))

    candidates = [f for f in files if f.endswith((".json3", ".vtt"))]
    return os.path.join(directory, sorted(candidates, key=rank)[0]) if candidates else None


def _captions(url: str, directory: str) -> str:
    opts = {
        **_QUIET,
        "skip_download": True,
        "writesubtitles": True,
        "writeautomaticsub": True,
        "subtitleslangs": ["en", "en-orig", "en-US", "en.*"],
        "subtitlesformat": "json3/vtt/best",
        "outtmpl": os.path.join(directory, "%(id)s.%(ext)s"),
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    path = _pick_caption_file(directory)
    if not path:
        return ""
    return _text_from_json3(path) if path.endswith(".json3") else _text_from_vtt(path)


def _whisper(url: str, directory: str) -> str:
    """Last resort: pull the audio and transcribe it on the GPU."""
    target = os.path.join(directory, "audio.%(ext)s")
    opts = {
        **_QUIET,
        "format": "bestaudio/best",
        "outtmpl": target,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "wav", "preferredquality": "0"}
        ],
        "postprocessor_args": {"extractaudio": ["-ar", "16000", "-ac", "1"]},
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        ydl.download([url])
    wav = next(
        (os.path.join(directory, f) for f in os.listdir(directory) if f.startswith("audio.")), None
    )
    if not wav:
        return ""
    segments, _info = models.get_whisper().transcribe(wav, language="en")
    return " ".join(seg.text.strip() for seg in segments).strip()


def transcript(url: str) -> dict:
    """Returns {title, author, durationSec, source, transcript}."""
    with yt_dlp.YoutubeDL({**_QUIET, "skip_download": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        raise ValueError("that link is a playlist or channel, not a single video")

    title = info.get("title") or url
    author = info.get("uploader") or info.get("channel") or ""
    duration = int(info.get("duration") or 0)
    description = (info.get("description") or "")[:1500]

    with tempfile.TemporaryDirectory() as directory:
        text = ""
        source = "captions"
        try:
            text = _captions(url, directory)
        except Exception:
            text = ""
        if len(text) < MIN_TRANSCRIPT_CHARS:
            if duration and duration > MAX_WHISPER_SECONDS:
                raise ValueError(
                    f"no captions, and the video is {duration // 60} minutes, "
                    f"over the {MAX_WHISPER_SECONDS // 60} minute transcription limit"
                )
            source = "whisper"
            text = _whisper(url, directory)

    if len(text) < MIN_TRANSCRIPT_CHARS:
        raise ValueError("could not get a usable transcript for this video")

    return {
        "title": title,
        "author": author,
        "durationSec": duration,
        "description": description,
        "source": source,
        "transcript": text,
    }
