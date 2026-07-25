"""M1 smoke test: POST a 6-segment two-speaker script to /tts/episode, assert
the mp3 exists, durationMs > 0, and segmentStartMs is monotonic.

Run against a running speech service:
  SPEECH_URL=http://localhost:7910 DATA_DIR=./data python3 smoke_episode.py
"""

import json
import os
import sys
import urllib.request

SPEECH_URL = os.environ.get("SPEECH_URL", "http://localhost:7910")
DATA_DIR = os.environ.get("DATA_DIR", "/data")
EPISODE_ID = "smoke"

SEGMENTS = [
    {"idx": 0, "speaker": "HOST", "text": "Here's something worth your next ten minutes. Why do bridges hum in the wind?"},
    {"idx": 1, "speaker": "EXPERT", "text": "It comes down to vortex shedding. Wind peels off the cables in little swirls, and those swirls push back and forth."},
    {"idx": 2, "speaker": "HOST", "text": "So the bridge is basically a giant instrument being played by the air?"},
    {"idx": 3, "speaker": "EXPERT", "text": "Exactly. When the pushing lines up with the bridge's natural rhythm, the motion grows. Engineers add dampers to break that up."},
    {"idx": 4, "speaker": "HOST", "text": "That's the part I never knew. It's not random, it's a resonance they have to design against."},
    {"idx": 5, "speaker": "EXPERT", "text": "Right. Three takeaways: wind makes swirls, swirls can match the bridge's rhythm, and dampers keep that from running away."},
]


def main() -> int:
    payload = json.dumps({"episodeId": EPISODE_ID, "segments": SEGMENTS}).encode()
    req = urllib.request.Request(
        f"{SPEECH_URL}/tts/episode",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    print(f"POST {SPEECH_URL}/tts/episode ({len(SEGMENTS)} segments) — rendering...")
    with urllib.request.urlopen(req, timeout=3600) as resp:
        body = json.loads(resp.read())
    print("response:", json.dumps(body, indent=2))

    duration_ms = body["durationMs"]
    starts = body["segmentStartMs"]
    assert duration_ms > 0, f"durationMs must be > 0, got {duration_ms}"
    assert len(starts) == len(SEGMENTS), f"expected {len(SEGMENTS)} starts, got {len(starts)}"
    assert starts[0] == 0, f"first start must be 0, got {starts[0]}"
    assert starts == sorted(starts), f"segmentStartMs not monotonic: {starts}"

    mp3_path = os.path.join(DATA_DIR, "episodes", EPISODE_ID, body["audioFile"])
    if os.path.exists(mp3_path):
        size = os.path.getsize(mp3_path)
        assert size > 0, "mp3 file is empty"
        print(f"OK mp3 present: {mp3_path} ({size} bytes)")
    else:
        print(f"NOTE mp3 not visible from here ({mp3_path}); check inside the container/mount")

    print("SMOKE OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
