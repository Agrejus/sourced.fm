"""CPU tests for the alignment algorithm — synthetic word lists, no GPU."""

from align import align, proportional


def _words(pairs):
    return [(w, t) for w, t in pairs]


def test_perfect_match():
    words = _words([
        ("Hello", 0.0), ("there", 0.5),
        ("How", 1.0), ("are", 1.4), ("you", 1.8),
        ("Great", 2.5), ("thanks", 3.0),
    ])
    segments = ["Hello there", "How are you", "Great thanks"]
    starts = align(words, segments, duration_ms=3500)
    assert starts == [0, 1000, 2500]


def test_noisy_match_allows_skips():
    # Whisper dropped/altered a couple of words but >=80% still line up.
    words = _words([
        ("the", 0.0), ("quick", 0.4), ("brown", 0.8), ("fox", 1.2),
        ("jumps", 2.0), ("over", 2.4), ("umm", 2.7), ("lazy", 3.1), ("dog", 3.5),
    ])
    segments = ["the quick brown fox", "jumps over the lazy dog"]
    starts = align(words, segments, duration_ms=4000)
    assert starts[0] == 0
    assert starts[1] == 2000  # first matched word of segment 2 is "jumps"
    assert starts == sorted(starts)


def test_fallback_triggers_on_poor_match():
    # Whisper output shares almost nothing with the script -> proportional.
    words = _words([("zzz", 0.0), ("qqq", 1.0), ("xxx", 2.0)])
    segments = ["alpha beta gamma", "delta epsilon zeta"]
    starts = align(words, segments, duration_ms=6000)
    assert starts == proportional(segments, 6000)
    assert starts[0] == 0


def test_monotonic_non_decreasing_and_clamped():
    # Out-of-order timestamps must never produce a decreasing start.
    words = _words([
        ("one", 5.0), ("two", 1.0), ("three", 9.0),
    ])
    segments = ["one", "two", "three"]
    starts = align(words, segments, duration_ms=10000)
    assert starts[0] == 0
    assert starts == sorted(starts)
    assert all(0 <= s <= 10000 for s in starts)


def test_proportional_by_character_count():
    segments = ["ab", "abcdef"]  # 2 and 6 chars -> total 8
    starts = proportional(segments, duration_ms=8000)
    assert starts[0] == 0
    assert starts[1] == 2000


# --- per-segment fallback (the bug that silently disabled alignment) ---

def test_one_bad_segment_does_not_discard_the_good_anchors():
    """The original all-or-nothing rule made this whole episode proportional.
    With 200+ segments at least one poor match is near-certain, so real
    episodes never got word-level timestamps at all."""
    words = _words([
        ("alpha", 0.0), ("beta", 0.5),
        ("zzz", 1.0), ("qqq", 1.5),            # segment 2 is unrecognisable
        ("gamma", 2.0), ("delta", 2.5),
        ("epsilon", 3.0), ("zeta", 3.5),
    ])
    segments = ["alpha beta", "totally absent words here", "gamma delta", "epsilon zeta"]
    starts = align(words, segments, duration_ms=4000)
    assert starts != proportional(segments, 4000)
    assert starts[0] == 0
    assert starts[2] == 2000    # real anchor survives
    assert starts[3] == 3000    # real anchor survives
    assert starts[1] > 0 and starts[1] < starts[2]   # interpolated into the gap
    assert starts == sorted(starts)


def test_a_word_recurring_far_later_cannot_drag_the_cursor_past_everything():
    """The original unbounded per-token search would find segment 2's missing
    word at its spurious occurrence 40 words later, leaving the cursor past
    segments 3 and 4 so neither could match. Bounding the within-segment reach
    keeps the cursor local: segment 2 simply loses one token."""
    words = _words(
        [("a1", 0.0), ("a2", 0.5), ("b1", 1.0), ("noise", 1.5),
         ("c1", 2.0), ("c2", 2.5), ("d1", 3.0), ("d2", 3.5)]
        + [(f"filler{i}", 5.0 + i * 0.1) for i in range(35)]
        + [("b2", 50.0)]
    )
    segments = ["a1 a2", "b1 b2", "c1 c2", "d1 d2"]
    starts = align(words, segments, duration_ms=55000)
    assert starts == [0, 1000, 2000, 3000]
    # b2's far occurrence must not have been used as segment 2's evidence
    assert starts[1] < 50000


def test_total_garbage_still_falls_back_globally():
    words = _words([("zzz", 0.0), ("qqq", 1.0), ("xxx", 2.0), ("www", 3.0)])
    segments = ["alpha beta", "gamma delta", "epsilon zeta", "eta theta"]
    starts = align(words, segments, duration_ms=8000)
    assert starts == proportional(segments, 8000)


def test_trailing_unmatched_segments_spread_to_the_duration():
    words = _words([("alpha", 0.0), ("beta", 0.5), ("gamma", 1.0)])
    segments = ["alpha beta gamma", "nothing here at all", "nor here either"]
    starts = align(words, segments, duration_ms=9000)
    assert starts[0] == 0
    assert starts[1] > 0
    assert starts[2] > starts[1]
    assert all(s <= 9000 for s in starts)


def test_leading_unmatched_segment_starts_at_zero():
    words = _words([("gamma", 4.0), ("delta", 4.5)])
    segments = ["unmatched opener", "gamma delta"]
    starts = align(words, segments, duration_ms=8000)
    assert starts[0] == 0
    assert starts[1] == 4000


def test_empty_segment_inherits_position_without_breaking_order():
    words = _words([("alpha", 0.0), ("beta", 1.0), ("gamma", 2.0)])
    segments = ["alpha", "", "beta gamma"]
    starts = align(words, segments, duration_ms=3000)
    assert starts[0] == 0
    assert starts == sorted(starts)
    assert starts[2] == 1000


def test_realistic_long_episode_keeps_word_level_anchors():
    """200 segments where a tenth match poorly: the result must stay anchored,
    not collapse to character-proportional."""
    words = []
    segments = []
    t = 0.0
    for i in range(200):
        if i % 10 == 3:
            segments.append(f"unmatchable segment number {i} xyzzy")
            for _ in range(5):
                words.append((f"noise{i}", t)); t += 0.4
        else:
            segments.append(f"segment {i} alpha bravo charlie")
            for tok in ("segment", str(i), "alpha", "bravo", "charlie"):
                words.append((tok, t)); t += 0.4
    starts = align(words, segments, duration_ms=int(t * 1000))
    assert starts != proportional(segments, int(t * 1000))
    assert starts == sorted(starts)
    # a matched segment late in the episode should land on its own first word
    assert abs(starts[199] - 199 * 5 * 400) < 2000
