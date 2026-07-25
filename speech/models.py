"""All audio models live here; main.py stays thin.

Residency policy: faster-whisper (STT + forced alignment) and Kokoro (answer
TTS) load once and stay resident. VibeVoice (episode TTS, ~7GB) loads inside
the episode call and is released in a finally block so it never evicts the
resident interactive set from the 2080 Ti's 11GB.

Turing (2080 Ti) overrides applied at load: torch_dtype=float16 (no bf16) and
attn_implementation="sdpa" (FlashAttention 2 has no Turing kernels). The fork's
CUDA default is bfloat16 + flash_attention_2, so we pass these explicitly.

Voice prompt wavs shipped in speech/voices/ were copied from the
vibevoice-community/VibeVoice fork demo voices:
  host.wav   <- demo/voices/en-Alice_woman.wav  (female, HOST / Speaker 1)
  expert.wav <- demo/voices/en-Frank_man.wav    (male,   EXPERT / Speaker 2)
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
from typing import List, Sequence, Tuple

import soundfile as sf
import torch

from align import align

_HERE_RENDER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vibevoice_render.py")

SAMPLE_RATE = 24000
VIBEVOICE_MODEL = "microsoft/VibeVoice-1.5B"
WHISPER_MODEL = "distil-small.en"
KOKORO_VOICE = "am_michael"

_HERE = os.path.dirname(os.path.abspath(__file__))
VOICE_BY_SPEAKER = {
    "HOST": os.path.join(_HERE, "voices", "host.wav"),
    "EXPERT": os.path.join(_HERE, "voices", "expert.wav"),
}
SPEAKER_NUMBER = {"HOST": 1, "EXPERT": 2}

_whisper = None
_kokoro = None


def gpu_name() -> str:
    """Raises if CUDA is unavailable — the health check turns that into a 503."""
    if not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available")
    return torch.cuda.get_device_name(0)


def get_whisper():
    global _whisper
    if _whisper is None:
        from faster_whisper import WhisperModel

        _whisper = WhisperModel(WHISPER_MODEL, device="cuda", compute_type="float16")
    return _whisper


def get_kokoro():
    global _kokoro
    if _kokoro is None:
        from kokoro import KPipeline

        _kokoro = KPipeline(lang_code="a")  # 'a' = American English
    return _kokoro


def warmup() -> None:
    """Load the resident interactive models at boot."""
    get_whisper()
    get_kokoro()


def to_vibevoice_script(segments: Sequence[dict]) -> str:
    """HOST -> 'Speaker 1:', EXPERT -> 'Speaker 2:', one line per segment."""
    lines = []
    for seg in segments:
        number = SPEAKER_NUMBER[seg["speaker"]]
        lines.append(f"Speaker {number}: {seg['text']}")
    return "\n".join(lines)


def _voice_samples_for(segments: Sequence[dict]) -> List[str]:
    """One reference wav per speaker number present, in ascending number order
    (matches the 'Speaker N:' labels the processor pairs voices with)."""
    numbers = sorted({SPEAKER_NUMBER[seg["speaker"]] for seg in segments})
    number_to_voice = {SPEAKER_NUMBER[name]: path for name, path in VOICE_BY_SPEAKER.items()}
    return [number_to_voice[n] for n in numbers]


def _whisper_words(wav_path: str) -> List[Tuple[str, float]]:
    segments_gen, _info = get_whisper().transcribe(
        wav_path, language="en", word_timestamps=True
    )
    words: List[Tuple[str, float]] = []
    for seg in segments_gen:
        for word in seg.words or []:
            words.append((word.word, word.start))
    return words


def synthesize_episode(
    episode_id: str, segments: Sequence[dict], data_dir: str
) -> Tuple[str, int, List[int]]:
    """Render the whole dialogue in one VibeVoice pass, force-align, and write
    audio.mp3. Returns (audio_file_name, duration_ms, segment_start_ms)."""
    out_dir = os.path.join(data_dir, "episodes", episode_id)
    os.makedirs(out_dir, exist_ok=True)
    wav_path = os.path.join(out_dir, "audio.wav")
    mp3_path = os.path.join(out_dir, "audio.mp3")

    script = to_vibevoice_script(segments)
    voice_samples = _voice_samples_for(segments)

    # Render in a throwaway process so VibeVoice's ~5.6GB is fully reclaimed on
    # exit (in-process del + empty_cache does not release the accelerate
    # device_map dispatch). The parent keeps whisper + Kokoro resident.
    payload = json.dumps(
        {"script": script, "voice_samples": voice_samples, "wav_path": wav_path}
    ).encode()
    proc = subprocess.run(
        [sys.executable, _HERE_RENDER],
        input=payload,
        capture_output=True,
    )
    if proc.returncode != 0 or not os.path.exists(wav_path):
        raise RuntimeError(
            f"vibevoice render failed (exit {proc.returncode}): "
            f"{proc.stderr.decode(errors='replace')[-2000:]}"
        )

    info = sf.info(wav_path)
    duration_ms = int(round(info.frames / info.samplerate * 1000))

    segment_texts = [seg["text"] for seg in segments]
    words = _whisper_words(wav_path)
    segment_start_ms = align(words, segment_texts, duration_ms)

    subprocess.run(
        ["ffmpeg", "-y", "-i", wav_path, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3_path],
        check=True,
        capture_output=True,
    )
    os.remove(wav_path)

    return "audio.mp3", duration_ms, segment_start_ms


def transcribe(audio_bytes: bytes, suffix: str = ".webm") -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as tmp:
        tmp.write(audio_bytes)
        tmp.flush()
        segments_gen, _info = get_whisper().transcribe(tmp.name, language="en")
        return "".join(seg.text for seg in segments_gen).strip()


def synthesize_answer_wav(text: str) -> bytes:
    """Kokoro renders the answer to a complete WAV (24 kHz mono, PCM16). The
    answer is short (<=120 words); the Bun app streams these bytes onward
    without buffering the full response itself."""
    pipeline = get_kokoro()
    chunks: List["torch.Tensor"] = []
    for result in pipeline(text, voice=KOKORO_VOICE):
        audio = getattr(result, "audio", None)
        if audio is None and isinstance(result, tuple):
            audio = result[-1]
        if audio is None:
            continue
        if torch.is_tensor(audio):
            audio = audio.detach().cpu().numpy()
        chunks.append(audio)

    if not chunks:
        samples = _empty_audio()
    else:
        import numpy as np

        samples = np.concatenate(chunks).astype("float32")

    buffer = io.BytesIO()
    sf.write(buffer, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buffer.getvalue()


def _empty_audio():
    import numpy as np

    return np.zeros(0, dtype="float32")
