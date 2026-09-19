from __future__ import annotations

import numpy as np
import djit.services.analyzer as analyzer

from djit.services.analyzer import (
    REFINEMENT_KEY_PROFILES,
    _apply_relative_minor_fallback,
    _camelot_from_key_scale,
    _detect_key_with_essentia,
    _parse_embedded_key_text,
    _framewise_same_tonic_mode_evidence,
    _key_core_audio,
    _pitch_class_from_key_name,
    _resolve_edm_mode_override,
    _resolve_same_tonic_mode,
    _same_tonic_mode_evidence,
)


def test_camelot_mapping_major_keys() -> None:
    assert _camelot_from_key_scale("C", "major") == "8B"
    assert _camelot_from_key_scale("F", "major") == "7B"
    assert _camelot_from_key_scale("G", "major") == "9B"
    assert _camelot_from_key_scale("B", "major") == "1B"
    assert _camelot_from_key_scale("C#", "major") == "3B"


def test_camelot_mapping_minor_keys() -> None:
    assert _camelot_from_key_scale("A", "minor") == "8A"
    assert _camelot_from_key_scale("C", "minor") == "5A"
    assert _camelot_from_key_scale("F", "minor") == "4A"
    assert _camelot_from_key_scale("B", "minor") == "10A"
    assert _camelot_from_key_scale("C#", "minor") == "12A"


def test_camelot_mapping_enharmonic_flats() -> None:
    assert _camelot_from_key_scale("Db", "major") == "3B"
    assert _camelot_from_key_scale("Eb", "minor") == "2A"
    assert _camelot_from_key_scale("Ab", "minor") == "1A"
    assert _camelot_from_key_scale("Bb", "major") == "6B"


def test_camelot_mapping_theoretical_and_unicode_keys() -> None:
    assert _camelot_from_key_scale("Cb", "major") == "1B"
    assert _camelot_from_key_scale("Fb", "major") == "12B"
    assert _camelot_from_key_scale("E#", "minor") == "4A"
    assert _camelot_from_key_scale("A♭", "minor") == "1A"
    assert _camelot_from_key_scale("C♯", "major") == "3B"


def test_pitch_class_parser_handles_accidentals() -> None:
    assert _pitch_class_from_key_name("C") == 0
    assert _pitch_class_from_key_name("B#") == 0
    assert _pitch_class_from_key_name("Cb") == 11
    assert _pitch_class_from_key_name("Fx") == 7
    assert _pitch_class_from_key_name("G♭") == 6


def test_invalid_keys_fall_back_to_unknown_camelot() -> None:
    assert _camelot_from_key_scale("", "major") == "0A"
    assert _camelot_from_key_scale("H", "minor") == "0A"
    assert _camelot_from_key_scale("C", "dorian") == "0A"


def test_same_tonic_mode_evidence_prefers_minor_when_minor_third_dominates() -> None:
    chroma = np.zeros(12, dtype=np.float64)
    chroma[5] = 0.25  # F
    chroma[8] = 0.22  # Ab
    chroma[0] = 0.18  # C
    chroma[3] = 0.12  # Eb
    chroma[4] = 0.04  # E
    chroma /= chroma.sum()

    preferred_scale, evidence = _same_tonic_mode_evidence(chroma, 5)
    assert preferred_scale == "minor"
    assert evidence > 0


def test_same_tonic_mode_evidence_prefers_major_when_major_third_dominates() -> None:
    chroma = np.zeros(12, dtype=np.float64)
    chroma[5] = 0.25  # F
    chroma[9] = 0.22  # A
    chroma[0] = 0.18  # C
    chroma[4] = 0.12  # E
    chroma[8] = 0.03  # Ab
    chroma /= chroma.sum()

    preferred_scale, evidence = _same_tonic_mode_evidence(chroma, 5)
    assert preferred_scale == "major"
    assert evidence < 0


def test_framewise_same_tonic_mode_evidence_prefers_minor() -> None:
    frame_a = np.zeros(12, dtype=np.float64)
    frame_a[5] = 0.28
    frame_a[8] = 0.24
    frame_a[0] = 0.16
    frame_a[3] = 0.11
    frame_a[4] = 0.03
    frame_a /= frame_a.sum()

    frame_b = np.zeros(12, dtype=np.float64)
    frame_b[5] = 0.24
    frame_b[8] = 0.20
    frame_b[0] = 0.18
    frame_b[3] = 0.13
    frame_b[4] = 0.05
    frame_b /= frame_b.sum()

    chroma_frames = np.column_stack([frame_a, frame_b])
    preferred_scale, evidence = _framewise_same_tonic_mode_evidence(chroma_frames, 5)
    assert preferred_scale == "minor"
    assert evidence > 0


def test_resolve_same_tonic_mode_can_override_narrow_major_lead() -> None:
    chroma = np.zeros(12, dtype=np.float64)
    chroma[5] = 0.25
    chroma[8] = 0.21
    chroma[0] = 0.18
    chroma[3] = 0.12
    chroma[4] = 0.06
    chroma[9] = 0.05
    chroma /= chroma.sum()

    chroma_frames = np.column_stack([chroma, chroma])
    preferred_scale, confidence_boost, debug_payload = _resolve_same_tonic_mode(
        tonic_pitch_class=5,
        major_total=1.22,
        minor_total=1.16,
        librosa_major=0.31,
        librosa_minor=0.36,
        chroma_norm=chroma,
        chroma_frames=chroma_frames,
    )

    assert preferred_scale == "minor"
    assert confidence_boost > 0
    assert debug_payload["mode_minor_score"] > debug_payload["mode_major_score"]


def test_resolve_edm_mode_override_prefers_minor_for_same_tonic_split() -> None:
    previous = analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT
    analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = False
    try:
        preferred_scale, confidence_boost, debug_payload = _resolve_edm_mode_override(
            tonic_pitch_class=5,
            major_total=3.41,
            minor_total=0.78,
            mode_debug={
                "whole_track_evidence": -0.007,
                "framewise_evidence": -0.0119,
            },
            profile_predictions={
                "edmm": (5, "minor", 0.6575),
                "edma": (5, "major", 0.7325),
            },
        )
    finally:
        analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = previous

    assert preferred_scale == "minor"
    assert confidence_boost > (3.41 - 0.78)
    assert debug_payload["override"] == "edmm_minor_same_tonic"


def test_resolve_edm_mode_override_prefers_minor_in_engine_dj_compat_mode() -> None:
    previous = analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT
    analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = True
    try:
        preferred_scale, confidence_boost, debug_payload = _resolve_edm_mode_override(
            tonic_pitch_class=5,
            major_total=3.41,
            minor_total=0.78,
            mode_debug={
                "whole_track_evidence": -0.020,
                "framewise_evidence": -0.030,
            },
            profile_predictions={
                "edmm": (5, "minor", 0.5764),
                "edma": (5, "major", 0.7156),
            },
        )
    finally:
        analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = previous

    assert preferred_scale == "minor"
    assert confidence_boost > 3.0
    assert debug_payload["override"] == "edmm_minor_same_tonic_compat"


def test_detect_key_with_essentia_returns_confidence_and_margin() -> None:
    class _FakeKeyExtractor:
        def __init__(self, profile_type: str):
            self.profile_type = profile_type

        def __call__(self, _y):
            mapping = {
                "bgate": ("F", "major", 0.72),
                "braw": ("F", "major", 0.67),
                "edmm": ("F", "minor", 0.69),
                "edma": ("F", "major", 0.65),
                "shaath": ("F", "minor", 0.62),
                "temperley": ("F", "minor", 0.66),
                "krumhansl": ("F", "minor", 0.64),
            }
            return mapping.get(self.profile_type, ("F", "major", 0.6))

    class _FakeEssentia:
        def KeyExtractor(self, **kwargs):
            return _FakeKeyExtractor(kwargs["profileType"])

    y = np.ones(4096, dtype=np.float64)
    key_raw, key_camelot, confidence, margin = _detect_key_with_essentia(
        _FakeEssentia(),
        y,
        profiles_override=REFINEMENT_KEY_PROFILES,
    )

    assert isinstance(key_raw, str)
    assert key_camelot.endswith("A") or key_camelot.endswith("B")
    assert 0.0 <= confidence <= 1.0
    assert margin >= 0.0


def test_detect_key_with_essentia_prefers_edmm_when_compat_primary_enabled() -> None:
    class _FakeKeyExtractor:
        def __init__(self, profile_type: str):
            self.profile_type = profile_type

        def __call__(self, _y):
            mapping = {
                "edmm": ("F", "minor", 0.68),
                "bgate": ("F", "major", 0.83),
                "braw": ("F", "major", 0.82),
                "edma": ("F", "major", 0.84),
                "shaath": ("F", "major", 0.81),
                "temperley": ("F", "major", 0.76),
            }
            return mapping.get(self.profile_type, ("F", "major", 0.7))

    class _FakeEssentia:
        def KeyExtractor(self, **kwargs):
            return _FakeKeyExtractor(kwargs["profileType"])

    previous_compat = analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT
    previous_primary = analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY
    previous_strength = analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH
    previous_boost = analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST
    analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = True
    analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY = True
    analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH = 0.62
    analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST = 2.0
    try:
        y = np.ones(4096, dtype=np.float64)
        key_raw, key_camelot, _, _ = _detect_key_with_essentia(
            _FakeEssentia(),
            y,
            profiles_override=("edmm", "bgate", "braw", "edma", "shaath", "temperley"),
        )
    finally:
        analyzer.ANALYSIS_ENGINE_DJ_KEY_COMPAT = previous_compat
        analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY = previous_primary
        analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH = previous_strength
        analyzer.ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST = previous_boost

    assert key_raw == "F minor"
    assert key_camelot == "4A"


def test_key_core_audio_trims_long_signal() -> None:
    y = np.arange(22050 * 20, dtype=np.float64)
    core = _key_core_audio(y)

    assert core.size < y.size
    assert core.size > 0


def test_key_core_audio_preserves_short_signal() -> None:
    y = np.arange(22050 * 4, dtype=np.float64)
    core = _key_core_audio(y)

    assert core.size == y.size


def test_parse_embedded_key_text_notation_variants() -> None:
    assert _parse_embedded_key_text("Amaj") == ("A major", "11B")
    assert _parse_embedded_key_text("11A") == ("Camelot 11A", "11A")
    assert _parse_embedded_key_text("4m") == ("OpenKey 4m", "11A")
    assert _parse_embedded_key_text("www.DJLIST.org") is None


def test_apply_relative_minor_fallback_from_major() -> None:
    key_raw, key_camelot = _apply_relative_minor_fallback("G major", "9B")
    assert key_raw == "E minor"
    assert key_camelot == "9A"
