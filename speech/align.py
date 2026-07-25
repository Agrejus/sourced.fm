"""Force-align script segments to whisper word timestamps.

Pure, GPU-free logic so it can be unit-tested on CPU with synthetic word
lists. The frozen algorithm: greedily walk the whisper words for each segment
in order, matching >=80% of the segment's words allowing skips; the first
matched word's time is the segment start. If any segment matches <50% of its
words the whole alignment is discarded for a proportional-by-character-count
fallback. Never fails an episode over alignment.
"""

from __future__ import annotations

import re
from typing import List, Sequence, Tuple


def _norm_tokens(text: str) -> List[str]:
    cleaned = re.sub(r"[^a-z0-9 ]", "", text.lower())
    return [tok for tok in cleaned.split() if tok]


def _norm_word(word: str) -> str:
    return re.sub(r"[^a-z0-9]", "", word.lower())


def proportional(segment_texts: Sequence[str], duration_ms: int) -> List[int]:
    """Fallback: distribute starts by cumulative character count."""
    lengths = [len(text) for text in segment_texts]
    total = sum(lengths)
    if total == 0 or duration_ms <= 0:
        return [0 for _ in segment_texts]
    starts: List[int] = []
    prefix = 0
    for length in lengths:
        starts.append(int(round(prefix / total * duration_ms)))
        prefix += length
    if starts:
        starts[0] = 0
    return starts


def align(
    words: Sequence[Tuple[str, float]],
    segment_texts: Sequence[str],
    duration_ms: int,
) -> List[int]:
    """Return one start-ms per segment (same order).

    `words` is the whisper word list as (word_text, start_seconds).
    """
    if not segment_texts:
        return []

    wlist: List[Tuple[str, int]] = []
    for raw, start_s in words:
        norm = _norm_word(raw)
        if norm:
            wlist.append((norm, int(round(start_s * 1000))))

    if not wlist:
        return proportional(segment_texts, duration_ms)

    pointer = 0
    raw_starts: List[int | None] = []
    ratios: List[float] = []

    for text in segment_texts:
        seg_words = _norm_tokens(text)
        if not seg_words:
            # Empty segment carries no words; inherit the running position.
            raw_starts.append(None)
            ratios.append(1.0)
            continue

        cursor = pointer
        matched = 0
        first_idx: int | None = None
        for token in seg_words:
            probe = cursor
            while probe < len(wlist) and wlist[probe][0] != token:
                probe += 1
            if probe < len(wlist):
                if first_idx is None:
                    first_idx = probe
                matched += 1
                cursor = probe + 1

        ratios.append(matched / len(seg_words))
        if first_idx is not None:
            raw_starts.append(wlist[first_idx][1])
            pointer = cursor
        else:
            raw_starts.append(None)

    if any(ratio < 0.5 for ratio in ratios):
        return proportional(segment_texts, duration_ms)

    # Fill gaps (empty segments), clamp non-decreasing, force first to 0,
    # clamp to duration.
    result: List[int] = []
    prev = 0
    for value in raw_starts:
        current = prev if value is None else value
        current = max(current, prev)
        if duration_ms > 0:
            current = min(current, duration_ms)
        result.append(current)
        prev = current
    result[0] = 0
    return result
