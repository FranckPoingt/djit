from __future__ import annotations

import numpy as np

from djit.services import analyzer


def test_fast_analysis_loads_three_representative_windows(monkeypatch):
    calls: list[float] = []
    monkeypatch.setattr(analyzer.librosa, "get_duration", lambda **_kwargs: 300.0)

    def fake_load(_path, *, sr, mono, offset=0.0, duration=None):
        assert sr == analyzer.ANALYSIS_SAMPLE_RATE
        assert mono is True
        assert duration == analyzer.FAST_ANALYSIS_WINDOW_SECONDS
        calls.append(offset)
        return np.ones(10, dtype=np.float32), sr

    monkeypatch.setattr(analyzer.librosa, "load", fake_load)

    audio, sample_rate = analyzer._load_fast_audio("demo.mp3")

    assert calls == [36.0, 135.0, 225.0]
    assert audio.size == 30
    assert sample_rate == analyzer.ANALYSIS_SAMPLE_RATE


def test_fast_analysis_skips_harmonic_percussive_separation(tmp_path, monkeypatch):
    audio_file = tmp_path / "demo.mp3"
    audio_file.write_bytes(b"audio")
    audio = np.ones(10, dtype=np.float32)
    monkeypatch.setattr(analyzer, "_load_fast_audio", lambda _path: (audio, 22050))
    monkeypatch.setattr(
        analyzer.librosa.effects,
        "hpss",
        lambda _audio: (_ for _ in ()).throw(AssertionError("HPSS must not run in fast mode")),
    )
    monkeypatch.setattr(analyzer.librosa.onset, "onset_strength", lambda **_kwargs: audio)
    monkeypatch.setattr(analyzer, "_detect_tempo", lambda *_args, **_kwargs: (128.0, 0.8))
    essentia = object()
    monkeypatch.setattr(analyzer, "_load_essentia_standard", lambda: essentia)

    def fake_detect_key(es, _audio, **kwargs):
        assert es is essentia
        assert kwargs["profiles_override"] == ("krumhansl",)
        return "A major", "11B", 0.8, 0.4

    monkeypatch.setattr(analyzer, "_detect_key_with_essentia", fake_detect_key)
    monkeypatch.setattr(analyzer, "_extract_embedded_bpm", lambda _path: 122.0)
    monkeypatch.setattr(analyzer, "_derive_energy", lambda *_args, **_kwargs: 7)

    result = analyzer.analyze_track_path(1, str(audio_file), "fast")

    assert result.status == "done"
    assert (result.bpm, result.bpm_confidence, result.key_camelot, result.energy) == (122.0, 1.0, "11B", 7)
    assert result.mood is None


def test_intensity_descriptors_produce_a_useful_range():
    calm = analyzer._intensity_from_descriptors(
        danceability=0.8,
        dynamic_complexity=8.0,
        loudness_db=-22.0,
        onset_strength=2.0,
        spectral_centroid=1000.0,
    )
    driving = analyzer._intensity_from_descriptors(
        danceability=1.7,
        dynamic_complexity=3.0,
        loudness_db=-12.0,
        onset_strength=4.6,
        spectral_centroid=3000.0,
    )

    assert calm <= 2
    assert driving >= 8


def test_tempo_analysis_has_enough_resolution_for_dance_music():
    sample_rate = 22050
    audio = analyzer.librosa.clicks(
        times=np.arange(0, 30, 60 / 122),
        sr=sample_rate,
        length=sample_rate * 30,
    )

    bpm, _ = analyzer._detect_tempo(audio, sample_rate, y_percussive=audio)

    assert round(bpm) == 122
