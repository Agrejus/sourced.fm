"""CPU tests for the speaker/voice mapping — no GPU, no model load.

Importing models pulls in torch and soundfile, so run these inside the speech
image (they are not part of the host-python test set):

  podman run --rm -v $PWD/speech:/test:z -w /test learn-speech:latest \
    sh -c 'python3.11 -m pip -q install pytest && python3.11 -m pytest -q'
"""

from models import (
    SPEAKER_ORDER,
    VOICE_BY_SPEAKER,
    _speaker_numbering,
    _voice_samples_for,
    to_vibevoice_script,
)


def _segs(*speakers):
    return [{"idx": i, "speaker": s, "text": f"line {i}"} for i, s in enumerate(speakers)]


def _labels(script):
    return [int(line.split(":", 1)[0].split()[1]) for line in script.splitlines()]


def test_speaker_order_covers_every_voice():
    assert set(SPEAKER_ORDER) == set(VOICE_BY_SPEAKER)
    assert SPEAKER_ORDER == ("HOST", "EXPERT", "CRITIC")


def test_three_speakers_number_in_canonical_order():
    segments = _segs("HOST", "EXPERT", "CRITIC")
    assert _speaker_numbering(segments) == {"HOST": 1, "EXPERT": 2, "CRITIC": 3}
    assert _labels(to_vibevoice_script(segments)) == [1, 2, 3]
    assert _voice_samples_for(segments) == [
        VOICE_BY_SPEAKER["HOST"],
        VOICE_BY_SPEAKER["EXPERT"],
        VOICE_BY_SPEAKER["CRITIC"],
    ]


def test_two_speaker_script_is_unchanged():
    """The pre-CRITIC numbering must still hold for a HOST/EXPERT episode."""
    segments = _segs("HOST", "EXPERT", "HOST", "EXPERT")
    assert _labels(to_vibevoice_script(segments)) == [1, 2, 1, 2]
    assert _voice_samples_for(segments) == [
        VOICE_BY_SPEAKER["HOST"],
        VOICE_BY_SPEAKER["EXPERT"],
    ]


def test_absent_speaker_leaves_no_gap():
    """Regression: fixed per-name numbers emitted 'Speaker 1' and 'Speaker 3'
    while supplying two voices, so the processor read critic.wav as Speaker 2
    and every CRITIC line came out unvoiced."""
    segments = _segs("HOST", "CRITIC", "HOST", "CRITIC")
    assert _labels(to_vibevoice_script(segments)) == [1, 2, 1, 2]
    assert _voice_samples_for(segments) == [
        VOICE_BY_SPEAKER["HOST"],
        VOICE_BY_SPEAKER["CRITIC"],
    ]


def test_every_label_indexes_its_own_voice():
    """The invariant the processor relies on: voice_samples[N-1] is the wav for
    whoever is labelled 'Speaker N', for every subset of speakers."""
    subsets = [
        ("HOST",), ("EXPERT",), ("CRITIC",),
        ("HOST", "EXPERT"), ("HOST", "CRITIC"), ("EXPERT", "CRITIC"),
        ("HOST", "EXPERT", "CRITIC"),
    ]
    for speakers in subsets:
        segments = _segs(*speakers)
        numbering = _speaker_numbering(segments)
        voices = _voice_samples_for(segments)
        assert len(voices) == len(set(speakers)), speakers
        for name, number in numbering.items():
            assert voices[number - 1] == VOICE_BY_SPEAKER[name], (speakers, name)


def test_speaker_order_is_independent_of_appearance_order():
    """CRITIC opening the episode must not renumber the cast."""
    numbering = _speaker_numbering(_segs("CRITIC", "HOST", "EXPERT"))
    assert numbering == {"HOST": 1, "EXPERT": 2, "CRITIC": 3}


def test_segment_text_is_passed_through_verbatim():
    segments = [{"idx": 0, "speaker": "CRITIC", "text": "Spell it out: what does that mean?"}]
    assert to_vibevoice_script(segments) == "Speaker 1: Spell it out: what does that mean?"
