"""Force-align script segments to whisper word timestamps.

Pure, GPU-free logic so it can be unit-tested on CPU with synthetic word lists.

The algorithm walks the whisper words once, in order, anchoring each segment to
the time of its first matched word. Two properties matter, and the first version
of this file got both wrong in a way that silently disabled alignment for every
real episode:

- **A per-token search window.** Looking ahead an unbounded distance for a token
  means one word whisper misheard can teleport the cursor thousands of words
  into the future, after which nothing matches. The lookahead is capped, so a
  local mishear costs one token instead of the rest of the episode.
- **Per-segment fallback, not all-or-nothing.** Discarding the whole alignment
  because one segment matched poorly throws away every good anchor — and with
  200+ segments, at least one poor match is close to certain, so the fallback
  fired every time. A segment that cannot be matched is now interpolated between
  its neighbouring anchors by character count, and only a genuinely unmatchable
  transcript (fewer than MIN_ANCHOR_SHARE of segments anchored) discards
  everything for the proportional fallback.

Never fails an episode over alignment.
"""

from __future__ import annotations

import re
from typing import List, Optional, Sequence, Tuple

# How far past the cursor a token *inside* a segment may be sought. Whisper
# drops and mishears words; this tolerates that locally without letting one bad
# token carry the cursor away to a spurious later occurrence.
TOKEN_LOOKAHEAD = 30
# Finding where a segment *begins* needs a longer reach, because the preceding
# segment may have failed to match and its words still stand in the way. Kept
# well above the longest plausible turn. A spurious hit here is self-correcting:
# the rest of the segment is matched under the tight window above, so the ratio
# check rejects the segment and the cursor is left alone.
FIRST_TOKEN_LOOKAHEAD = 400
# A segment matching at least this share of its words is trusted as an anchor.
MIN_SEG_RATIO = 0.5
# Below this share of anchored segments the transcript bears no usable relation
# to the script, so proportional is the honest answer.
MIN_ANCHOR_SHARE = 0.3


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


def _interpolate(
    anchors: Sequence[Optional[int]],
    segment_texts: Sequence[str],
    duration_ms: int,
) -> List[int]:
    """Fill unanchored segments between anchors, spreading by character count.

    Segment k's start sits between the surrounding anchors in proportion to how
    much text precedes it, which is the same assumption `proportional` makes —
    but applied over a gap of a few segments instead of the whole episode.
    """
    n = len(anchors)
    weights = [max(len(text), 1) for text in segment_texts]

    # Fixed points as (segment index, time). Segment 0 always starts at 0, and a
    # virtual point at n closes the final gap against the episode duration.
    fixed: List[Tuple[int, int]] = []
    if anchors[0] is None:
        fixed.append((0, 0))
    for i, value in enumerate(anchors):
        if value is not None:
            fixed.append((i, value))
    end = duration_ms if duration_ms > 0 else (fixed[-1][1] if fixed else 0)
    fixed.append((n, end))

    out: List[Optional[int]] = list(anchors)
    if anchors[0] is None:
        out[0] = 0

    for (a_i, a_t), (b_i, b_t) in zip(fixed, fixed[1:]):
        if b_i - a_i <= 1:
            continue  # adjacent anchors leave no gap to fill
        span = sum(weights[a_i:b_i])
        if span <= 0:
            continue
        prefix = 0
        for k in range(a_i, b_i):
            if out[k] is None:
                out[k] = a_t + int(round((b_t - a_t) * prefix / span))
            prefix += weights[k]

    return [0 if value is None else value for value in out]


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
    anchors: List[Optional[int]] = []
    anchored = 0
    scorable = 0

    for text in segment_texts:
        seg_words = _norm_tokens(text)
        if not seg_words:
            anchors.append(None)  # no words to match; interpolated later
            continue

        scorable += 1
        cursor = pointer
        matched = 0
        first_idx: Optional[int] = None
        for token in seg_words:
            reach = FIRST_TOKEN_LOOKAHEAD if first_idx is None else TOKEN_LOOKAHEAD
            limit = min(len(wlist), cursor + reach)
            probe = cursor
            while probe < limit and wlist[probe][0] != token:
                probe += 1
            if probe < limit:
                if first_idx is None:
                    first_idx = probe
                matched += 1
                cursor = probe + 1

        if first_idx is not None and matched / len(seg_words) >= MIN_SEG_RATIO:
            anchors.append(wlist[first_idx][1])
            anchored += 1
            pointer = cursor
        else:
            # Unmatched: leave a hole for interpolation and leave the pointer
            # alone. Advancing it by a guess would consume words belonging to
            # the segments that follow, so one failure would cascade into all
            # of them; the generous first-token reach handles stepping over
            # whatever this segment's audio actually was.
            anchors.append(None)

    if scorable == 0 or anchored / scorable < MIN_ANCHOR_SHARE:
        return proportional(segment_texts, duration_ms)

    result: List[int] = []
    prev = 0
    for value in _interpolate(anchors, segment_texts, duration_ms):
        current = max(value, prev)
        if duration_ms > 0:
            current = min(current, duration_ms)
        result.append(current)
        prev = current
    result[0] = 0
    return result
