"""Regenerate speech/voices/critic.wav (Ray's reference voice) with Kokoro.

Ray's reference is generated rather than borrowed, which keeps it reproducible
and free of third-party attribution — Kokoro is Apache-2.0 and the audio is
rendered here. host.wav and expert.wav are still the fork's demo clips.

Run inside the speech container, which already has Kokoro:

  podman exec learn-speech-1 python3.11 /app/make_critic_voice.py
  podman cp learn-speech-1:/app/voices/critic.wav speech/voices/critic.wav

Choosing a voice: pitch separation from expert.wav is the measure that holds up.
Ray and Sam are both male, so if their rendered pitches converge the listener
hears one person arguing with himself. am_onyx renders about 19 Hz below Frank,
roughly twice the gap of the next candidate. Do NOT use am_michael — that is
KOKORO_VOICE, the voice that answers listener questions, and it must stay
recognisable as Sam.

Verify a replacement by rendering a real multi-minute excerpt and listening. A
60-second smoke test overstates separation badly, and reference-clip timbre does
not predict the rendered result at all (measured 2026-08-04: two references
3.4x apart in timbre rendered indistinguishably).
"""

from __future__ import annotations

import os

import numpy as np
import soundfile as sf
import torch
from kokoro import KPipeline

VOICE = "am_onyx"  # deep American male; ~19 Hz below Frank in the render
LANG = "a"  # 'a' = American English, and must match the voice prefix
SAMPLE_RATE = 24000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "voices", "critic.wav")

# Ray's register — short, probing, a little impatient. Matching the manner in the
# reference helps the clone carry it into the episode.
TEXT = (
    "Hold on. That's the label, not the mechanism. Walk me through what actually happens, "
    "step by step. And compared to what? If you don't do it that way, what breaks? "
    "You just used a four-letter acronym and kept going. Spell it out, and tell me what it "
    "actually does in practice. I'm not looking for the textbook phrase. I want the part "
    "that would change how someone builds this. Give me a number, or an example."
)


def main() -> None:
    pipeline = KPipeline(lang_code=LANG)
    chunks: list[np.ndarray] = []
    for result in pipeline(TEXT, voice=VOICE):
        audio = getattr(result, "audio", None)
        if audio is None and isinstance(result, tuple):
            audio = result[-1]
        if audio is None:
            continue
        if torch.is_tensor(audio):
            audio = audio.detach().cpu().numpy()
        chunks.append(audio)
    if not chunks:
        raise RuntimeError(f"kokoro produced no audio for voice {VOICE}")

    samples = np.concatenate(chunks).astype("float32")
    sf.write(OUT, samples, SAMPLE_RATE, subtype="PCM_16")
    print(f"wrote {OUT}: {len(samples) / SAMPLE_RATE:.1f}s mono {SAMPLE_RATE} Hz ({VOICE})")


if __name__ == "__main__":
    main()
