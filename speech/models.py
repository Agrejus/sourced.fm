"""All audio models live here; main.py stays thin.

Residency policy: faster-whisper (STT + forced alignment) and Kokoro (answer
TTS) load once and stay resident. VibeVoice (episode TTS, ~7GB) loads inside
the episode call and is released in a finally block so it never evicts the
resident interactive set inside an 11GB VRAM budget.

Overrides applied at load for GPUs without bf16 (Turing and older):
torch_dtype=float16 and
attn_implementation="sdpa" (FlashAttention 2 has no Turing kernels). The fork's
CUDA default is bfloat16 + flash_attention_2, so we pass these explicitly.

Voice prompt wavs shipped in speech/voices/ were copied from the
vibevoice-community/VibeVoice fork demo voices:
  host.wav   <- demo/voices/en-Alice_woman.wav  (female, HOST)
  expert.wav <- demo/voices/en-Frank_man.wav    (male,   EXPERT)
  critic.wav <- demo/voices/in-Samuel_man.wav   (male,   CRITIC)

HOST/EXPERT/CRITIC is the canonical order, but the 'Speaker N' number each one
gets depends on who appears in the script — see _speaker_numbering.

CRITIC and EXPERT are both male, so their reference wavs must stay audibly
distinct. Measured on real renders (2026-08-03): Samuel sits about 19 Hz below
Frank in median pitch and, more importantly, as far away in timbre as Alice is
— so listeners hear a third person, not Frank in a different mood. The fork's
en-Carter_man.wav was tried first and rejected: it renders 2.6 Hz from Frank
with almost no timbre gap, and the two are indistinguishable. Re-measure before
swapping either wav; pitch alone is not enough.
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
    "CRITIC": os.path.join(_HERE, "voices", "critic.wav"),
}
# Canonical speaker order. Numbering is derived from this and from which
# speakers a script actually uses (see _speaker_numbering) rather than fixed per
# name, so it is never out of step with the voice list.
SPEAKER_ORDER = tuple(VOICE_BY_SPEAKER)

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


def _speaker_numbering(segments: Sequence[dict]) -> dict:
    """Dense 'Speaker N' numbers over the speakers this script actually uses, in
    SPEAKER_ORDER.

    The processor pairs voice_samples[i] with the 'Speaker i+1:' label, so the
    numbers must run 1..N with no gaps. Numbering each speaker by a fixed number
    breaks that as soon as one is absent: a HOST+CRITIC script would ask for
    Speaker 1 and Speaker 3 while supplying two voices, and the second voice
    would be read as Speaker 2 — leaving every CRITIC line unvoiced. Deriving
    both the labels and the voice list from this one mapping keeps them in
    lockstep however many speakers appear.
    """
    present = [name for name in SPEAKER_ORDER if any(seg["speaker"] == name for seg in segments)]
    return {name: i + 1 for i, name in enumerate(present)}


def to_vibevoice_script(segments: Sequence[dict]) -> str:
    """One 'Speaker N: text' line per segment, N per _speaker_numbering."""
    numbering = _speaker_numbering(segments)
    lines = []
    for seg in segments:
        number = numbering[seg["speaker"]]
        lines.append(f"Speaker {number}: {seg['text']}")
    return "\n".join(lines)


def _voice_samples_for(segments: Sequence[dict]) -> List[str]:
    """One reference wav per speaker present, ordered to match the labels
    to_vibevoice_script emits."""
    numbering = _speaker_numbering(segments)
    return [VOICE_BY_SPEAKER[name] for name in sorted(numbering, key=lambda n: numbering[n])]


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
