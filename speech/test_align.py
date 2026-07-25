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
