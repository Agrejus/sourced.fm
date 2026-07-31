"""One episode render, in a throwaway process.

Reads {"script", "voice_samples", "wav_path"} as JSON on stdin, renders the
whole dialogue in a single VibeVoice pass, writes the wav, and exits. Running
this as a subprocess (rather than loading VibeVoice in the service process) is
what actually frees the ~5.6GB footprint between episodes: process exit returns
all GPU memory to the driver unconditionally. In-process `del model` +
`empty_cache()` does NOT release it — the accelerate `device_map` dispatch
keeps the weights alive — which would evict the resident interactive set's VRAM
headroom (design.md §2.7 / §2.11).

Overrides for GPUs without bf16 (Turing and older): torch_dtype=float16 and
attn_implementation="sdpa" (no FlashAttention 2 kernels for Turing).
"""

import json
import sys

import torch

from vibevoice.modular.modeling_vibevoice_inference import (
    VibeVoiceForConditionalGenerationInference,
)
from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

VIBEVOICE_MODEL = "microsoft/VibeVoice-1.5B"


def main() -> int:
    req = json.load(sys.stdin)
    script = req["script"]
    voice_samples = req["voice_samples"]
    wav_path = req["wav_path"]

    processor = VibeVoiceProcessor.from_pretrained(VIBEVOICE_MODEL)
    model = VibeVoiceForConditionalGenerationInference.from_pretrained(
        VIBEVOICE_MODEL,
        torch_dtype=torch.float16,
        device_map="cuda",
        attn_implementation="sdpa",
    )
    model.eval()
    model.set_ddpm_inference_steps(num_steps=10)

    inputs = processor(
        text=[script],
        voice_samples=[voice_samples],
        padding=True,
        return_tensors="pt",
        return_attention_mask=True,
    )
    for key, value in inputs.items():
        if torch.is_tensor(value):
            inputs[key] = value.to("cuda")

    outputs = model.generate(
        **inputs,
        max_new_tokens=None,
        cfg_scale=1.3,
        tokenizer=processor.tokenizer,
        generation_config={"do_sample": False},
        is_prefill=True,
    )
    processor.save_audio(outputs.speech_outputs[0], output_path=wav_path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
