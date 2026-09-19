from __future__ import annotations

import logging
import multiprocessing as mp
import os
import re
from importlib import import_module
from queue import Empty
from pathlib import Path

import librosa
import numpy as np
from mutagen import File as MutagenFile
from sqlalchemy.orm import Session
from typing import Any

from djit.database.models import Track
from djit.schemas.analysis import AnalysisEvent

logger = logging.getLogger(__name__)

ANALYSIS_SAMPLE_RATE = int(os.getenv("DJIT_ANALYSIS_SAMPLE_RATE", "22050"))
ANALYSIS_MAX_DURATION_SECONDS = float(
    os.getenv("DJIT_ANALYSIS_MAX_DURATION_SECONDS", "0")
)
ANALYSIS_KEY_PROFILE = os.getenv("DJIT_ANALYSIS_KEY_PROFILE", "auto")
ANALYSIS_TEMPO_METHOD = os.getenv("DJIT_ANALYSIS_TEMPO_METHOD", "multifeature")
ANALYSIS_ENGINE = os.getenv("DJIT_ANALYSIS_ENGINE", "auto").strip().lower()
ANALYSIS_DEBUG_KEYS = os.getenv("DJIT_ANALYSIS_DEBUG_KEYS", "0").strip().lower() in {"1", "true", "yes", "on"}
ANALYSIS_HOP_LENGTH = int(os.getenv("DJIT_ANALYSIS_HOP_LENGTH", "2048"))
ANALYSIS_TEMPO_HOP_LENGTH = int(os.getenv("DJIT_ANALYSIS_TEMPO_HOP_LENGTH", "128"))
ANALYSIS_KEY_REFINEMENT_ENABLED = os.getenv("DJIT_ANALYSIS_KEY_REFINEMENT_ENABLED", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ANALYSIS_KEY_HPSS_ENABLED = os.getenv("DJIT_ANALYSIS_KEY_HPSS_ENABLED", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ANALYSIS_KEY_REFINEMENT_CONFIDENCE_THRESHOLD = float(
    os.getenv("DJIT_ANALYSIS_KEY_REFINEMENT_CONFIDENCE_THRESHOLD", "0.58")
)
ANALYSIS_KEY_REFINEMENT_MARGIN_THRESHOLD = float(
    os.getenv("DJIT_ANALYSIS_KEY_REFINEMENT_MARGIN_THRESHOLD", "0.22")
)
ANALYSIS_ENGINE_DJ_KEY_COMPAT = os.getenv("DJIT_ANALYSIS_ENGINE_DJ_KEY_COMPAT", "1").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ANALYSIS_ENGINE_DJ_EDMM_PRIMARY = os.getenv("DJIT_ANALYSIS_ENGINE_DJ_EDMM_PRIMARY", "0").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH = float(
    os.getenv("DJIT_ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH", "0.62")
)
ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST = float(
    os.getenv("DJIT_ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST", "1.6")
)
ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_ON_LOW_CONF = os.getenv(
    "DJIT_ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_ON_LOW_CONF", "0"
).strip().lower() in {"1", "true", "yes", "on"}
ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_CONFIDENCE_THRESHOLD = float(
    os.getenv("DJIT_ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_CONFIDENCE_THRESHOLD", "0.56")
)
ANALYSIS_KEY_CORE_START_RATIO = float(os.getenv("DJIT_ANALYSIS_KEY_CORE_START_RATIO", "0.20"))
ANALYSIS_KEY_CORE_END_RATIO = float(os.getenv("DJIT_ANALYSIS_KEY_CORE_END_RATIO", "0.85"))
SUPPORTED_KEY_PROFILES = (
    "diatonic",
    "krumhansl",
    "temperley",
    "weichai",
    "tonictriad",
    "temperley2005",
    "thpcp",
    "shaath",
    "gomez",
    "noland",
    "edmm",
    "edma",
    "bgate",
    "braw",
)
DEFAULT_KEY_PROFILES = ("krumhansl",)
REFINEMENT_KEY_PROFILES = ("bgate", "braw", "temperley", "krumhansl", "shaath")
FAST_ANALYSIS_WINDOW_SECONDS = 20.0
FAST_ANALYSIS_WINDOW_RATIOS = (0.12, 0.45, 0.75)

NOTE_PITCH_CLASS = {
    "C": 0,
    "D": 2,
    "E": 4,
    "F": 5,
    "G": 7,
    "A": 9,
    "B": 11,
}

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Krumhansl-Schmuckler key profiles.
# These are relative pitch-class weights for major/minor keys.
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
    dtype=np.float64,
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
    dtype=np.float64,
)


def _load_essentia_standard() -> Any | None:
    """Load Essentia lazily to avoid hard dependency in environments without it."""
    try:
        return import_module("essentia.standard")
    except Exception:
        return None


def _duration_limited_audio(y: np.ndarray, sr: int) -> np.ndarray:
    if ANALYSIS_MAX_DURATION_SECONDS <= 0:
        return y
    max_samples = int(ANALYSIS_MAX_DURATION_SECONDS * sr)
    if max_samples <= 0:
        return y
    return y[:max_samples]


def _key_core_audio(y: np.ndarray) -> np.ndarray:
    """Focus key detection on the core section to reduce intro/outro bias."""
    if y.size == 0:
        return y

    start_ratio = float(np.clip(ANALYSIS_KEY_CORE_START_RATIO, 0.0, 0.95))
    end_ratio = float(np.clip(ANALYSIS_KEY_CORE_END_RATIO, start_ratio + 0.02, 1.0))
    start = int(y.size * start_ratio)
    end = int(y.size * end_ratio)

    core = y[start:end] if end > start else y
    # Guard against very short signals after trimming.
    if core.size < int(ANALYSIS_SAMPLE_RATE * 8):
        return y
    return core


def _pitch_class_from_key_name(key: str) -> int | None:
    raw = key.strip()
    if not raw:
        return None

    tonic = raw[0].upper()
    if tonic not in NOTE_PITCH_CLASS:
        return None

    accidentals = raw[1:].replace("♯", "#").replace("♭", "b")
    offset = 0
    for char in accidentals:
        if char == "#":
            offset += 1
            continue
        if char in {"b", "B"}:
            offset -= 1
            continue
        if char in {"x", "X"}:
            offset += 2
            continue
        if char == "♮":
            continue
        return None

    return (NOTE_PITCH_CLASS[tonic] + offset) % 12


def _camelot_from_key_scale(key: str, scale: str) -> str:
    pitch_class = _pitch_class_from_key_name(key)
    if pitch_class is None:
        return "0A"

    scale_name = scale.strip().lower()
    if scale_name.startswith("maj"):
        number = ((7 * pitch_class) + 7) % 12 + 1
        return f"{number}B"
    if scale_name.startswith("min"):
        number = ((7 * pitch_class) + 4) % 12 + 1
        return f"{number}A"
    return "0A"


def _camelot_from_pitch_class_scale(pitch_class: int, scale: str) -> str:
    return _camelot_from_key_scale(NOTES[pitch_class % 12], scale)


def _parse_embedded_key_text(raw_value: str) -> tuple[str, str] | None:
    value = raw_value.strip()
    if not value:
        return None

    # Direct Camelot notation, e.g. 11A / 4B.
    camelot_match = re.fullmatch(r"([1-9]|1[0-2])\s*([AaBb])", value)
    if camelot_match:
        number = int(camelot_match.group(1))
        letter = camelot_match.group(2).upper()
        return f"Camelot {number}{letter}", f"{number}{letter}"

    # Open Key notation, e.g. 4m/4d -> 11A/11B in Camelot.
    open_key_match = re.fullmatch(r"([1-9]|1[0-2])\s*([mMdD])", value)
    if open_key_match:
        open_number = int(open_key_match.group(1))
        open_mode = open_key_match.group(2).lower()
        camelot_number = ((open_number + 6) % 12) + 1
        camelot_letter = "A" if open_mode == "m" else "B"
        return f"OpenKey {open_number}{open_mode}", f"{camelot_number}{camelot_letter}"

    normalized = value.replace(" ", "")
    note_match = re.fullmatch(r"([A-Ga-g][#b♯♭]?)(maj(?:or)?|min(?:or)?|m)", normalized)
    if note_match:
        note = note_match.group(1)
        mode_token = note_match.group(2).lower()
        scale = "major" if mode_token.startswith("maj") else "minor"
        camelot = _camelot_from_key_scale(note, scale)
        if camelot != "0A":
            return f"{note} {scale}", camelot

    return None


def _extract_embedded_key(track_path: str) -> tuple[str, str] | None:
    try:
        audio = MutagenFile(track_path)
    except Exception:
        return None

    if audio is None:
        return None

    tags = getattr(audio, "tags", None)
    if not tags:
        return None

    tag_values: list[str] = []
    for key, value in tags.items():
        key_lower = str(key).lower()
        if "key" not in key_lower and key_lower not in {"tkey", "initialkey"}:
            continue

        if isinstance(value, list):
            tag_values.extend(str(item) for item in value)
        else:
            text_value = getattr(value, "text", None)
            if isinstance(text_value, list):
                tag_values.extend(str(item) for item in text_value)
            else:
                tag_values.append(str(value))

    for candidate in tag_values:
        parsed = _parse_embedded_key_text(candidate)
        if parsed is not None:
            return parsed

    return None


def _extract_embedded_bpm(track_path: str) -> float | None:
    try:
        audio = MutagenFile(track_path)
    except Exception:
        return None

    tags = getattr(audio, "tags", None) if audio is not None else None
    if not tags:
        return None

    for key, value in tags.items():
        if "bpm" not in str(key).lower():
            continue
        values = getattr(value, "text", value if isinstance(value, list) else [value])
        for item in values:
            match = re.search(r"\d+(?:\.\d+)?", str(item))
            if match:
                bpm = float(match.group())
                if 40.0 <= bpm <= 240.0:
                    return bpm
    return None


def _apply_relative_minor_fallback(key_raw: str, key_camelot: str) -> tuple[str, str]:
    match = re.fullmatch(r"([1-9]|1[0-2])B", key_camelot.strip(), re.IGNORECASE)
    if not match:
        return key_raw, key_camelot

    major_note = key_raw.strip().split(" ")[0]
    pitch_class = _pitch_class_from_key_name(major_note)
    if pitch_class is None:
        return key_raw, key_camelot

    rel_minor_pitch_class = (pitch_class + 9) % 12
    rel_minor_note = NOTES[rel_minor_pitch_class]
    camelot_number = int(match.group(1))
    return f"{rel_minor_note} minor", f"{camelot_number}A"


def _normalize_bpm_confidence(
    bpm: float,
    estimates: np.ndarray | list[float],
    tracker_confidence: float,
) -> float:
    base_conf = float(np.clip(tracker_confidence / 5.32, 0.0, 1.0))
    if estimates is None:
        return base_conf

    est = np.asarray(estimates, dtype=np.float64)
    if est.size == 0:
        return base_conf

    valid = est[(est >= 60.0) & (est <= 220.0)]
    if valid.size == 0:
        valid = est

    bins = np.arange(60.0, 221.0, 0.5)
    hist, edges = np.histogram(valid, bins=bins)
    if hist.sum() <= 0:
        concentration = 0.0
    else:
        mode_idx = int(np.argmax(hist))
        mode_center = float((edges[mode_idx] + edges[mode_idx + 1]) * 0.5)
        local = valid[np.abs(valid - mode_center) <= 1.5]
        concentration = float(np.clip(local.size / valid.size, 0.0, 1.0))

    half_double_penalty = 0.0
    if bpm > 0:
        half_or_double = np.logical_or(np.abs(valid - (bpm * 0.5)) <= 1.0, np.abs(valid - (bpm * 2.0)) <= 2.0)
        ambiguity = float(np.clip(np.mean(half_or_double), 0.0, 1.0))
        half_double_penalty = 0.25 * ambiguity

    confidence = float(np.clip((0.65 * base_conf) + (0.35 * concentration) - half_double_penalty, 0.0, 1.0))
    return confidence


def _resolve_key_profiles() -> tuple[str, ...]:
    profile_spec = ANALYSIS_KEY_PROFILE.strip().lower()
    raw_profiles = DEFAULT_KEY_PROFILES if not profile_spec or profile_spec == "auto" else tuple(
        part.strip() for part in profile_spec.split(",") if part.strip()
    )

    profiles = tuple(profile for profile in raw_profiles if profile in SUPPORTED_KEY_PROFILES)
    invalid_profiles = [profile for profile in raw_profiles if profile not in SUPPORTED_KEY_PROFILES]
    if invalid_profiles:
        logger.warning("Ignoring unsupported Essentia key profiles: %s", ", ".join(invalid_profiles))

    return profiles or DEFAULT_KEY_PROFILES


def _harmonic_chroma_profile(y: np.ndarray, sr: float, *, y_harmonic: np.ndarray | None = None) -> np.ndarray:
    h = y_harmonic if y_harmonic is not None else librosa.effects.hpss(y)[0]
    chroma = librosa.feature.chroma_stft(
        y=h,
        sr=sr,
        hop_length=ANALYSIS_HOP_LENGTH,
        tuning=0.0,
    )
    chroma_mean = np.mean(chroma, axis=1)
    if float(np.sum(chroma_mean)) <= 1e-9:
        return np.array([], dtype=np.float64)

    return chroma_mean / float(np.sum(chroma_mean))


def _harmonic_chroma_frames(y: np.ndarray, sr: float, *, y_harmonic: np.ndarray | None = None) -> np.ndarray:
    h = y_harmonic if y_harmonic is not None else librosa.effects.hpss(y)[0]
    chroma = librosa.feature.chroma_stft(
        y=h,
        sr=sr,
        hop_length=ANALYSIS_HOP_LENGTH,
        tuning=0.0,
    )
    if chroma.size == 0:
        return np.empty((12, 0), dtype=np.float64)

    frame_sums = np.sum(chroma, axis=0, keepdims=True)
    valid = frame_sums > 1e-9
    normalized = np.zeros_like(chroma, dtype=np.float64)
    np.divide(chroma, frame_sums, out=normalized, where=valid)
    return normalized


def _same_tonic_mode_evidence(chroma_norm: np.ndarray, tonic_pitch_class: int) -> tuple[str | None, float]:
    if chroma_norm.size != 12:
        return None, 0.0

    tonic = tonic_pitch_class % 12
    major_third = float(chroma_norm[(tonic + 4) % 12])
    minor_third = float(chroma_norm[(tonic + 3) % 12])
    major_sixth = float(chroma_norm[(tonic + 9) % 12])
    minor_sixth = float(chroma_norm[(tonic + 8) % 12])
    major_seventh = float(chroma_norm[(tonic + 11) % 12])
    minor_seventh = float(chroma_norm[(tonic + 10) % 12])

    # The third carries most of the major/minor information; sixth/seventh help
    # distinguish natural/harmonic minor from major material.
    evidence = (
        (1.35 * (minor_third - major_third))
        + (0.45 * (minor_sixth - major_sixth))
        + (0.20 * (minor_seventh - major_seventh))
    )

    if evidence >= 0.01:
        return "minor", evidence
    if evidence <= -0.01:
        return "major", evidence
    return None, evidence


def _framewise_same_tonic_mode_evidence(chroma_frames: np.ndarray, tonic_pitch_class: int) -> tuple[str | None, float]:
    if chroma_frames.shape[0] != 12 or chroma_frames.shape[1] == 0:
        return None, 0.0

    tonic = tonic_pitch_class % 12
    tonic_energy = chroma_frames[tonic]
    fifth_energy = chroma_frames[(tonic + 7) % 12]
    third_energy = np.maximum(chroma_frames[(tonic + 3) % 12], chroma_frames[(tonic + 4) % 12])
    frame_weights = tonic_energy + (0.7 * fifth_energy) + (0.8 * third_energy)
    valid = frame_weights > 1e-4
    if not np.any(valid):
        return None, 0.0

    frame_scores = np.array(
        [_same_tonic_mode_evidence(chroma_frames[:, idx], tonic)[1] for idx in range(chroma_frames.shape[1])],
        dtype=np.float64,
    )
    frame_scores = frame_scores[valid]
    frame_weights = frame_weights[valid]
    if frame_scores.size == 0:
        return None, 0.0

    weighted_evidence = float(np.average(frame_scores, weights=frame_weights))
    if weighted_evidence >= 0.008:
        return "minor", weighted_evidence
    if weighted_evidence <= -0.008:
        return "major", weighted_evidence
    return None, weighted_evidence


def _resolve_same_tonic_mode(
    tonic_pitch_class: int,
    major_total: float,
    minor_total: float,
    librosa_major: float,
    librosa_minor: float,
    chroma_norm: np.ndarray,
    chroma_frames: np.ndarray,
) -> tuple[str | None, float, dict[str, float | str | None]]:
    whole_track_mode, whole_track_evidence = _same_tonic_mode_evidence(chroma_norm, tonic_pitch_class)
    framewise_mode, framewise_evidence = _framewise_same_tonic_mode_evidence(chroma_frames, tonic_pitch_class)

    mode_major_score = major_total + (0.35 * librosa_major)
    mode_minor_score = minor_total + (0.35 * librosa_minor)

    if whole_track_mode == "major":
        mode_major_score += min(0.7, abs(whole_track_evidence) * 6.0)
    elif whole_track_mode == "minor":
        mode_minor_score += min(0.7, abs(whole_track_evidence) * 6.0)

    if framewise_mode == "major":
        mode_major_score += min(0.9, abs(framewise_evidence) * 8.0)
    elif framewise_mode == "minor":
        mode_minor_score += min(0.9, abs(framewise_evidence) * 8.0)

    score_gap = mode_minor_score - mode_major_score
    if score_gap >= 0.05:
        preferred = "minor"
    elif score_gap <= -0.05:
        preferred = "major"
    else:
        preferred = None

    debug_payload: dict[str, float | str | None] = {
        "whole_track_mode": whole_track_mode,
        "whole_track_evidence": round(whole_track_evidence, 4),
        "framewise_mode": framewise_mode,
        "framewise_evidence": round(framewise_evidence, 4),
        "mode_major_score": round(mode_major_score, 4),
        "mode_minor_score": round(mode_minor_score, 4),
        "score_gap": round(score_gap, 4),
    }
    return preferred, abs(score_gap), debug_payload


def _resolve_edm_mode_override(
    tonic_pitch_class: int,
    major_total: float,
    minor_total: float,
    mode_debug: dict[str, float | str | None],
    profile_predictions: dict[str, tuple[int, str, float]],
) -> tuple[str | None, float, dict[str, float | str | None]]:
    edmm = profile_predictions.get("edmm")
    edma = profile_predictions.get("edma")
    if edmm is None or edma is None:
        return None, 0.0, {}

    edmm_tonic, edmm_scale, edmm_strength = edmm
    edma_tonic, edma_scale, edma_strength = edma
    whole_track_evidence = abs(float(mode_debug.get("whole_track_evidence") or 0.0))
    framewise_evidence = abs(float(mode_debug.get("framewise_evidence") or 0.0))

    weak_generic_mode_evidence = whole_track_evidence < 0.015 and framewise_evidence < 0.02
    same_tonic_split = (
        edmm_tonic == tonic_pitch_class
        and edma_tonic == tonic_pitch_class
        and edmm_scale == "minor"
        and edma_scale == "major"
    )
    close_strengths = edmm_strength >= (edma_strength - 0.1)

    compat_prefer_minor = ANALYSIS_ENGINE_DJ_KEY_COMPAT and same_tonic_split

    if not ((weak_generic_mode_evidence and same_tonic_split and close_strengths) or compat_prefer_minor):
        return None, 0.0, {}

    extra_score = max(0.35, (major_total - minor_total) + 0.2)
    if compat_prefer_minor:
        # Engine DJ alignment mode: when edmm/edma disagree only on mode for the
        # same tonic, prefer the minor interpretation decisively.
        extra_score = max(extra_score, major_total + 0.5)
    debug_payload: dict[str, float | str | None] = {
        "override": "edmm_minor_same_tonic_compat" if compat_prefer_minor else "edmm_minor_same_tonic",
        "edmm_strength": round(edmm_strength, 4),
        "edma_strength": round(edma_strength, 4),
        "whole_track_evidence": round(whole_track_evidence, 4),
        "framewise_evidence": round(framewise_evidence, 4),
        "extra_score": round(extra_score, 4),
    }
    return "minor", extra_score, debug_payload


def _key_profile_correlation_scores(y: np.ndarray, sr: float, *, y_harmonic: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    chroma_norm = _harmonic_chroma_profile(y, sr, y_harmonic=y_harmonic)
    if chroma_norm.size == 0:
        return np.array([], dtype=np.float64), np.array([], dtype=np.float64), chroma_norm

    chroma_z = _zscore(chroma_norm)
    major_profile_z = _zscore(MAJOR_PROFILE)
    minor_profile_z = _zscore(MINOR_PROFILE)

    major_scores = np.array(
        [float(np.dot(chroma_z, np.roll(major_profile_z, shift))) for shift in range(12)],
        dtype=np.float64,
    )
    minor_scores = np.array(
        [float(np.dot(chroma_z, np.roll(minor_profile_z, shift))) for shift in range(12)],
        dtype=np.float64,
    )
    return major_scores, minor_scores, chroma_norm


def _detect_key_with_essentia(
    es: Any,
    y: np.ndarray,
    *,
    y_harmonic: np.ndarray | None = None,
    profiles_override: tuple[str, ...] | None = None,
) -> tuple[str, str, float, float]:
    profiles = profiles_override if profiles_override is not None else _resolve_key_profiles()
    candidate_scores: dict[tuple[int, str], dict[str, float | str | int]] = {}
    profile_predictions: dict[str, tuple[int, str, float]] = {}
    profile_bonus = {
        "edmm": 0.20,
        "bgate": 0.12,
        "braw": 0.10,
        "edma": 0.06,
        "shaath": 0.04,
        "temperley": 0.04,
    }
    profile_votes: list[dict[str, str | float | int]] = []

    for profile in profiles:
        key_extractor = es.KeyExtractor(
            sampleRate=ANALYSIS_SAMPLE_RATE,
            frameSize=4096,
            hopSize=4096,
            hpcpSize=36,
            profileType=profile,
            averageDetuningCorrection=True,
            minFrequency=25,
            maxFrequency=3500,
            pcpThreshold=0.2,
            weightType="cosine",
            maximumSpectralPeaks=60,
        )
        key, scale, strength = key_extractor(y)
        pitch_class = _pitch_class_from_key_name(key)
        if pitch_class is None:
            continue

        scale_name = "major" if scale.strip().lower().startswith("maj") else "minor"
        key_raw = f"{key} {scale}"
        key_camelot = _camelot_from_pitch_class_scale(pitch_class, scale_name)
        strength_score = float(np.clip(strength, 0.0, 1.0))
        score = strength_score + profile_bonus.get(profile, 0.0)
        profile_predictions[profile] = (pitch_class, scale_name, strength_score)
        profile_votes.append(
            {
                "profile": profile,
                "key": key,
                "scale": scale_name,
                "camelot": key_camelot,
                "pitch_class": pitch_class,
                "strength": round(strength_score, 4),
                "score": round(score, 4),
            }
        )

        current = candidate_scores.get((pitch_class, scale_name))
        if current is None:
            candidate_scores[(pitch_class, scale_name)] = {
                "score": score,
                "best_score": score,
                "key_raw": key_raw,
                "pitch_class": pitch_class,
                "scale": scale_name,
                "votes": 1.0,
            }
            continue

        current["score"] = float(current["score"]) + score
        current["votes"] = float(current["votes"]) + 1.0
        if score > float(current["best_score"]):
            current["best_score"] = score
            current["key_raw"] = key_raw

    # Engine DJ compatibility: when edmm is confident, bias the final vote
    # toward edmm's tonic/mode prediction.
    if ANALYSIS_ENGINE_DJ_KEY_COMPAT and ANALYSIS_ENGINE_DJ_EDMM_PRIMARY:
        edmm_prediction = profile_predictions.get("edmm")
        if edmm_prediction is not None:
            edmm_pitch_class, edmm_scale, edmm_strength = edmm_prediction
            if edmm_strength >= ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_STRENGTH:
                edmm_key_raw = f"{NOTES[edmm_pitch_class]} {edmm_scale}"
                edmm_payload = candidate_scores.get((edmm_pitch_class, edmm_scale))
                if edmm_payload is None:
                    candidate_scores[(edmm_pitch_class, edmm_scale)] = {
                        "score": ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST,
                        "best_score": ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST,
                        "key_raw": edmm_key_raw,
                        "pitch_class": edmm_pitch_class,
                        "scale": edmm_scale,
                        "votes": 1.0,
                    }
                else:
                    edmm_payload["score"] = float(edmm_payload["score"]) + ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST
                    edmm_payload["votes"] = float(edmm_payload["votes"]) + 1.0
                if ANALYSIS_DEBUG_KEYS:
                    logger.info(
                        "Key compat edmm-primary: tonic=%s scale=%s strength=%.4f boost=%.3f",
                        NOTES[edmm_pitch_class],
                        edmm_scale,
                        edmm_strength,
                        ANALYSIS_ENGINE_DJ_EDMM_PRIMARY_BOOST,
                    )

    major_scores, minor_scores, chroma_norm = _key_profile_correlation_scores(y, ANALYSIS_SAMPLE_RATE, y_harmonic=y_harmonic)
    chroma_frames = _harmonic_chroma_frames(y, ANALYSIS_SAMPLE_RATE, y_harmonic=y_harmonic)
    if major_scores.size and minor_scores.size:
        best_major_idx = int(np.argmax(major_scores))
        best_minor_idx = int(np.argmax(minor_scores))
        best_major = float(major_scores[best_major_idx])
        best_minor = float(minor_scores[best_minor_idx])
        if best_major >= best_minor:
            librosa_pitch_class = best_major_idx
            librosa_scale = "major"
            librosa_key_raw = f"{NOTES[best_major_idx]} major"
        else:
            librosa_pitch_class = best_minor_idx
            librosa_scale = "minor"
            librosa_key_raw = f"{NOTES[best_minor_idx]} minor"

        current = candidate_scores.get((librosa_pitch_class, librosa_scale))
        if current is None:
            candidate_scores[(librosa_pitch_class, librosa_scale)] = {
                "score": 0.2,
                "best_score": 0.2,
                "key_raw": librosa_key_raw,
                "pitch_class": librosa_pitch_class,
                "scale": librosa_scale,
                "votes": 0.5,
            }
        else:
            current["score"] = float(current["score"]) + 0.2
            current["votes"] = float(current["votes"]) + 0.5

        tonic_scores: dict[int, float] = {}
        for (pitch_class, _scale_name), payload in candidate_scores.items():
            tonic_scores[pitch_class] = tonic_scores.get(pitch_class, 0.0) + float(payload["score"])

        best_tonic: int | None = (
            max(tonic_scores, key=lambda pitch_class: tonic_scores[pitch_class])
            if tonic_scores
            else None
        )
        if best_tonic is not None:
            major_payload = candidate_scores.get((best_tonic, "major"))
            minor_payload = candidate_scores.get((best_tonic, "minor"))
            major_total = float(major_payload["score"]) if major_payload else 0.0
            minor_total = float(minor_payload["score"]) if minor_payload else 0.0
            librosa_major = float(major_scores[best_tonic])
            librosa_minor = float(minor_scores[best_tonic])
            preferred_scale, confidence_boost, mode_debug = _resolve_same_tonic_mode(
                tonic_pitch_class=best_tonic,
                major_total=major_total,
                minor_total=minor_total,
                librosa_major=librosa_major,
                librosa_minor=librosa_minor,
                chroma_norm=chroma_norm,
                chroma_frames=chroma_frames,
            )

            edm_override_scale, edm_override_boost, edm_override_debug = _resolve_edm_mode_override(
                tonic_pitch_class=best_tonic,
                major_total=major_total,
                minor_total=minor_total,
                mode_debug=mode_debug,
                profile_predictions=profile_predictions,
            )
            if edm_override_scale is not None:
                preferred_scale = edm_override_scale
                confidence_boost = max(confidence_boost, edm_override_boost)
                mode_debug = {**mode_debug, **edm_override_debug}

            if preferred_scale is not None:
                override_mode = str(mode_debug.get("override") or "")
                if override_mode.startswith("edmm_minor_same_tonic"):
                    # This override is intentionally decisive for same-tonic EDM profile splits.
                    extra_score = max(0.3, confidence_boost)
                else:
                    extra_score = min(1.1, max(0.3, confidence_boost))
                preferred_payload = candidate_scores.get((best_tonic, preferred_scale))
                if preferred_payload is None:
                    candidate_scores[(best_tonic, preferred_scale)] = {
                        "score": extra_score,
                        "best_score": extra_score,
                        "key_raw": f"{NOTES[best_tonic]} {preferred_scale}",
                        "pitch_class": best_tonic,
                        "scale": preferred_scale,
                        "votes": 1.0,
                    }
                else:
                    preferred_payload["score"] = float(preferred_payload["score"]) + extra_score
                    preferred_payload["votes"] = float(preferred_payload["votes"]) + 1.0

            if ANALYSIS_DEBUG_KEYS:
                logger.info(
                    "Key mode resolution: tonic=%s major_total=%.4f minor_total=%.4f librosa_major=%.4f librosa_minor=%.4f preferred=%s debug=%s",
                    NOTES[best_tonic],
                    major_total,
                    minor_total,
                    librosa_major,
                    librosa_minor,
                    preferred_scale,
                    mode_debug,
                )

    if not candidate_scores:
        raise RuntimeError("No key candidates produced")

    ranked = sorted(
        candidate_scores.items(),
        key=lambda item: (float(item[1]["score"]), float(item[1]["votes"]), float(item[1]["best_score"])),
        reverse=True,
    )
    best_key, best_payload = ranked[0]
    score_margin = 0.0
    if len(ranked) > 1:
        score_margin = float(ranked[0][1]["score"]) - float(ranked[1][1]["score"])

    best_pitch_class, best_scale = best_key
    best_camelot = _camelot_from_pitch_class_scale(best_pitch_class, str(best_scale))

    if ANALYSIS_DEBUG_KEYS:
        summary = [
            {
                "tonic": NOTES[pitch_class],
                "scale": scale_name,
                "camelot": _camelot_from_pitch_class_scale(pitch_class, scale_name),
                "score": round(float(payload["score"]), 4),
                "votes": round(float(payload["votes"]), 4),
                "best_score": round(float(payload["best_score"]), 4),
                "key_raw": str(payload["key_raw"]),
            }
            for (pitch_class, scale_name), payload in ranked
        ]
        logger.info("Key profile votes: %s", profile_votes)
        logger.info("Key candidate summary: %s", summary)

    confidence = float(np.clip(float(best_payload["score"]) / (len(profiles) * 1.6), 0.0, 1.0))
    return str(best_payload["key_raw"]), best_camelot, confidence, score_margin


def _detect_with_essentia(track_path: str) -> tuple[np.ndarray, int, float, float, str, str, float]:
    es = _load_essentia_standard()
    if es is None:
        raise RuntimeError("Essentia not available")

    loader = es.MonoLoader(filename=track_path, sampleRate=ANALYSIS_SAMPLE_RATE)
    y = loader()
    if y.size == 0:
        raise RuntimeError("Essentia loaded empty audio")

    y = _duration_limited_audio(y, ANALYSIS_SAMPLE_RATE)

    rhythm = es.RhythmExtractor2013(
        method=ANALYSIS_TEMPO_METHOD,
        minTempo=60,
        maxTempo=220,
    )
    bpm, _, tracker_confidence, estimates, _ = rhythm(y)
    bpm = float(np.clip(float(bpm), 60.0, 220.0))
    bpm_confidence = _normalize_bpm_confidence(bpm, estimates, float(tracker_confidence))

    y_key = _key_core_audio(y)
    y_harmonic = librosa.effects.hpss(y_key)[0] if ANALYSIS_KEY_HPSS_ENABLED else y_key
    key_raw, key_camelot, key_strength, key_margin = _detect_key_with_essentia(
        es,
        y_key,
        y_harmonic=y_harmonic,
    )

    needs_refinement = (
        ANALYSIS_KEY_REFINEMENT_ENABLED
        and (
            key_strength < ANALYSIS_KEY_REFINEMENT_CONFIDENCE_THRESHOLD
            or key_margin < ANALYSIS_KEY_REFINEMENT_MARGIN_THRESHOLD
        )
    )
    if needs_refinement:
        refined_key_raw, refined_key_camelot, refined_strength, refined_margin = _detect_key_with_essentia(
            es,
            y_key,
            y_harmonic=y_harmonic,
            profiles_override=REFINEMENT_KEY_PROFILES,
        )
        if (refined_strength > key_strength + 0.03) or (refined_strength >= key_strength and refined_margin > key_margin):
            key_raw = refined_key_raw
            key_camelot = refined_key_camelot
            key_strength = refined_strength
            key_margin = refined_margin

    # Last-chance retry at 44.1kHz for hard ambiguous tracks; only runs on
    # unresolved low-confidence outcomes to limit runtime impact.
    if ANALYSIS_KEY_REFINEMENT_ENABLED and key_strength < 0.50:
        loader_hi = es.MonoLoader(filename=track_path, sampleRate=44100)
        y_hi = loader_hi()
        if y_hi.size > 0:
            y_hi = _duration_limited_audio(y_hi, 44100)
            y_hi_harmonic = librosa.effects.hpss(y_hi)[0] if ANALYSIS_KEY_HPSS_ENABLED else y_hi
            hi_key_raw, hi_key_camelot, hi_strength, hi_margin = _detect_key_with_essentia(
                es,
                y_hi,
                y_harmonic=y_hi_harmonic,
                profiles_override=REFINEMENT_KEY_PROFILES,
            )
            if (hi_strength > key_strength + 0.04) or (hi_strength >= key_strength and hi_margin > key_margin + 0.05):
                key_raw = hi_key_raw
                key_camelot = hi_key_camelot
                key_strength = hi_strength

    return y, ANALYSIS_SAMPLE_RATE, bpm, bpm_confidence, key_raw, key_camelot, float(key_strength)


def _zscore(v: np.ndarray) -> np.ndarray:
    mean = float(np.mean(v))
    std = float(np.std(v))
    if std <= 1e-9:
        return np.zeros_like(v)
    return (v - mean) / std


def _robust_tempo_bpm(onset_env: np.ndarray, sr: float, hop_length: int = 512) -> float:
    """Estimate BPM with reduced half/double-time instability."""
    frame_tempi = librosa.feature.tempo(
        onset_envelope=onset_env,
        sr=sr,
        hop_length=hop_length,
        aggregate=None,
    )
    if frame_tempi.size == 0:
        return 0.0

    # Focus on practical dance tempo bands and prefer the densest mode.
    valid = frame_tempi[(frame_tempi >= 70.0) & (frame_tempi <= 200.0)]
    if valid.size == 0:
        valid = frame_tempi

    median = float(np.median(valid))
    mad = float(np.median(np.abs(valid - median)))
    if mad > 1e-9:
        inliers = valid[np.abs(valid - median) <= (2.5 * mad)]
        if inliers.size > 0:
            valid = inliers

    # Histogram-mode then local weighted average around mode center.
    bins = np.arange(60.0, 220.0, 0.5)
    hist, edges = np.histogram(valid, bins=bins)
    mode_idx = int(np.argmax(hist))
    mode_center = float((edges[mode_idx] + edges[mode_idx + 1]) * 0.5)
    near_mode = valid[np.abs(valid - mode_center) <= 2.0]

    bpm = float(np.mean(near_mode)) if near_mode.size > 0 else mode_center
    return float(np.clip(bpm, 60.0, 220.0))


def _detect_tempo(y: np.ndarray, sr: float, *, y_percussive: np.ndarray | None = None, onset_env: np.ndarray | None = None) -> tuple[float, float]:
    """Detect BPM from loaded waveform and return (bpm, confidence)."""
    try:
        # Separate percussive content to improve beat/onset precision.
        if y_percussive is None:
            _, y_percussive = librosa.effects.hpss(y)
        if onset_env is None:
            onset_env = librosa.onset.onset_strength(y=y_percussive, sr=sr, hop_length=ANALYSIS_TEMPO_HOP_LENGTH)
        if onset_env.size == 0:
            return 0.0, 0.0

        tempogram = librosa.feature.tempogram(onset_envelope=onset_env, sr=sr, hop_length=ANALYSIS_TEMPO_HOP_LENGTH)

        # Robust dominant BPM from framewise tempo candidates.
        tempo = _robust_tempo_bpm(onset_env, sr, hop_length=ANALYSIS_TEMPO_HOP_LENGTH)

        # 1) Onset dynamics: stronger rhythmic transients usually mean
        # more reliable tempo estimation.
        onset_max = float(np.max(onset_env))
        onset_p95 = float(np.percentile(onset_env, 95))
        onset_p50 = float(np.percentile(onset_env, 50))
        onset_dynamic = 0.0 if onset_max <= 1e-9 else np.clip((onset_p95 - onset_p50) / onset_max, 0.0, 1.0)

        # 2) Tempogram peak contrast: clear dominant tempo versus alternatives.
        tempo_profile = np.mean(tempogram, axis=1)
        sorted_profile = np.sort(tempo_profile)
        top1 = float(sorted_profile[-1]) if sorted_profile.size > 0 else 0.0
        top2 = float(sorted_profile[-2]) if sorted_profile.size > 1 else 0.0
        peak_contrast = 0.0 if top1 <= 1e-9 else np.clip((top1 - top2) / top1, 0.0, 1.0)

        # 3) Beat interval regularity: stable beat spacing boosts confidence.
        _, beat_frames = librosa.beat.beat_track(
            onset_envelope=onset_env,
            sr=sr,
            units="frames",
            hop_length=ANALYSIS_TEMPO_HOP_LENGTH,
        )
        if beat_frames.size >= 4:
            intervals = np.diff(beat_frames)
            mean_interval = float(np.mean(intervals))
            if mean_interval > 1e-9:
                cv = float(np.std(intervals) / mean_interval)
                beat_regularity = float(np.clip(1.0 - cv, 0.0, 1.0))
            else:
                beat_regularity = 0.0
        else:
            beat_regularity = 0.0

        # Weighted composite in [0, 1].
        confidence = float(
            np.clip(
                (0.45 * onset_dynamic) + (0.35 * peak_contrast) + (0.20 * beat_regularity),
                0.0,
                1.0,
            )
        )

        return float(tempo), confidence
    except Exception as e:
        logger.warning(f"Failed to detect tempo: {e}")
        return 0.0, 0.0


def _detect_key(y: np.ndarray, sr: float, *, y_harmonic: np.ndarray | None = None) -> tuple[str, str]:
    """Detect key from loaded waveform and return (key_raw, key_camelot)."""
    try:
        major_scores, minor_scores, _ = _key_profile_correlation_scores(y, sr, y_harmonic=y_harmonic)
        if major_scores.size == 0 or minor_scores.size == 0:
            return "Unknown", "0A"

        best_major_idx = int(np.argmax(major_scores))
        best_minor_idx = int(np.argmax(minor_scores))
        best_major = float(major_scores[best_major_idx])
        best_minor = float(minor_scores[best_minor_idx])

        if best_major >= best_minor:
            key_raw = f"{NOTES[best_major_idx]} major"
        else:
            key_raw = f"{NOTES[best_minor_idx]} minor"

        key_camelot = _camelot_from_key_scale(NOTES[best_major_idx] if best_major >= best_minor else NOTES[best_minor_idx], "major" if best_major >= best_minor else "minor")
        return key_raw, key_camelot
    except Exception as e:
        logger.warning(f"Failed to detect key: {e}")
        return "Unknown", "0A"


def _intensity_from_descriptors(
    *,
    danceability: float,
    dynamic_complexity: float,
    loudness_db: float,
    onset_strength: float,
    spectral_centroid: float,
) -> int:
    """Map rhythm and dynamics descriptors to a DJ-oriented intensity estimate."""
    dance_norm = float(np.clip((danceability - 0.8) / 1.2, 0.0, 1.0))
    onset_norm = float(np.clip((onset_strength - 2.0) / 4.0, 0.0, 1.0))
    loudness_norm = float(np.clip((loudness_db + 22.0) / 12.0, 0.0, 1.0))
    density_norm = float(np.clip(1.0 - (dynamic_complexity / 10.0), 0.0, 1.0))
    brightness_norm = float(np.clip((spectral_centroid - 1000.0) / 3000.0, 0.0, 1.0))
    composite = (
        (0.25 * dance_norm)
        + (0.25 * onset_norm)
        + (0.20 * loudness_norm)
        + (0.20 * density_norm)
        + (0.10 * brightness_norm)
    )
    spread = float(np.clip((composite - 0.25) / 0.55, 0.0, 1.0))
    return int(np.clip(round(1 + (spread * 9)), 1, 10))


def _derive_energy(y: np.ndarray, sr: float, *, onset_env: np.ndarray | None = None) -> int:
    """Estimate audio intensity in [1, 10] from rhythm and dynamics."""
    try:
        # Tempo uses a much smaller hop; recompute here because onset-strength
        # magnitude is hop-dependent and must stay calibrated for intensity.
        onset_env = librosa.onset.onset_strength(
            y=y,
            sr=sr,
            hop_length=ANALYSIS_HOP_LENGTH,
        )
        centroid = librosa.feature.spectral_centroid(y=y, sr=sr, hop_length=ANALYSIS_HOP_LENGTH)[0]
        es = _load_essentia_standard()
        if es is None:
            raise RuntimeError("Essentia intensity descriptors unavailable")
        danceability, _ = es.Danceability(sampleRate=sr)(y)
        dynamic_complexity, loudness_db = es.DynamicComplexity(sampleRate=sr)(y)
        return _intensity_from_descriptors(
            danceability=float(danceability),
            dynamic_complexity=float(dynamic_complexity),
            loudness_db=float(loudness_db),
            onset_strength=float(np.mean(onset_env)),
            spectral_centroid=float(np.mean(centroid)),
        )
    except Exception as e:
        logger.warning(f"Failed to derive energy: {e}")
        return 5


def _load_fast_audio(track_path: str) -> tuple[np.ndarray, int]:
    """Load three representative windows instead of decoding the whole track."""
    duration = float(librosa.get_duration(path=track_path))
    if duration <= FAST_ANALYSIS_WINDOW_SECONDS * len(FAST_ANALYSIS_WINDOW_RATIOS):
        return librosa.load(track_path, sr=ANALYSIS_SAMPLE_RATE, mono=True)

    windows: list[np.ndarray] = []
    for ratio in FAST_ANALYSIS_WINDOW_RATIOS:
        offset = min(
            max(0.0, duration * ratio),
            max(0.0, duration - FAST_ANALYSIS_WINDOW_SECONDS),
        )
        audio, _ = librosa.load(
            track_path,
            sr=ANALYSIS_SAMPLE_RATE,
            mono=True,
            offset=offset,
            duration=FAST_ANALYSIS_WINDOW_SECONDS,
        )
        if audio.size > 0:
            windows.append(audio)

    if not windows:
        raise RuntimeError("Fast analysis loaded empty audio")
    return np.concatenate(windows), ANALYSIS_SAMPLE_RATE


def warm_analysis_runtime() -> None:
    """Pay native/JIT initialization costs before the first real track."""
    audio = librosa.clicks(
        times=np.arange(0, 8, 0.5),
        sr=ANALYSIS_SAMPLE_RATE,
        length=ANALYSIS_SAMPLE_RATE * 8,
    )
    _detect_tempo(audio, ANALYSIS_SAMPLE_RATE, y_percussive=audio)
    es = _load_essentia_standard()
    if es is not None:
        _detect_key_with_essentia(
            es,
            audio,
            y_harmonic=audio,
            profiles_override=("krumhansl",),
        )
    _derive_energy(audio, ANALYSIS_SAMPLE_RATE)


def analyze_track_path(
    track_id: int,
    track_path: str,
    mode: str = "deep",
) -> AnalysisEvent:
    """Analyze BPM and key from a known track path using Essentia-first pipeline."""
    try:
        if not Path(track_path).exists():
            return AnalysisEvent(
                track_id=track_id,
                status="failed",
                bpm=None,
                bpm_confidence=None,
                key_raw="Unknown",
                key_camelot="0A",
            )

        key_strength = 0.0
        embedded_bpm = _extract_embedded_bpm(track_path)
        embedded_key = _extract_embedded_key(track_path)
        onset_env: np.ndarray | None = None
        if ANALYSIS_ENGINE not in {"auto", "essentia", "librosa"}:
            logger.warning("Unknown DJIT_ANALYSIS_ENGINE=%s; expected auto|essentia|librosa", ANALYSIS_ENGINE)

        engine = ANALYSIS_ENGINE if ANALYSIS_ENGINE in {"essentia", "librosa"} else "auto"
        if mode == "fast":
            y, sr = _load_fast_audio(track_path)
            onset_env = librosa.onset.onset_strength(
                y=y,
                sr=sr,
                hop_length=ANALYSIS_TEMPO_HOP_LENGTH,
            )
            bpm, bpm_confidence = _detect_tempo(
                y,
                sr,
                y_percussive=y,
                onset_env=onset_env,
            )
            es = _load_essentia_standard()
            if es is None:
                key_raw, key_camelot = _detect_key(y, sr, y_harmonic=y)
            else:
                try:
                    key_raw, key_camelot, key_strength, _ = _detect_key_with_essentia(
                        es,
                        y,
                        y_harmonic=y,
                        profiles_override=("krumhansl",),
                    )
                except Exception as error:
                    logger.warning("Essentia key analysis failed, falling back to librosa: %s", error)
                    key_raw, key_camelot = _detect_key(y, sr, y_harmonic=y)
        elif engine in {"auto", "essentia"}:
            try:
                y, sr, bpm, bpm_confidence, key_raw, key_camelot, key_strength = _detect_with_essentia(track_path)
                # Blend key certainty into BPM confidence slightly; ambiguous tonality often
                # co-occurs with weak rhythmic structure on intros/outros.
                bpm_confidence = float(np.clip((0.9 * bpm_confidence) + (0.1 * key_strength), 0.0, 1.0))
            except Exception as e:
                if engine == "essentia":
                    logger.error("Essentia-only mode failed: %s", e)
                    raise
                logger.warning("Essentia analysis failed, falling back to librosa: %s", e)
                y, sr = librosa.load(
                    track_path,
                    sr=22050,
                    mono=True,
                    duration=(ANALYSIS_MAX_DURATION_SECONDS if ANALYSIS_MAX_DURATION_SECONDS > 0 else None),
                )
                y_harmonic, y_percussive = librosa.effects.hpss(y)
                onset_env = librosa.onset.onset_strength(y=y_percussive, sr=sr, hop_length=ANALYSIS_TEMPO_HOP_LENGTH)
                bpm, bpm_confidence = _detect_tempo(y, sr, y_percussive=y_percussive, onset_env=onset_env)
                key_raw, key_camelot = _detect_key(y, sr, y_harmonic=y_harmonic)
        else:
            logger.info("Using librosa analysis engine")
            y, sr = librosa.load(
                track_path,
                sr=22050,
                mono=True,
                duration=(ANALYSIS_MAX_DURATION_SECONDS if ANALYSIS_MAX_DURATION_SECONDS > 0 else None),
            )
            y_harmonic, y_percussive = librosa.effects.hpss(y)
            onset_env = librosa.onset.onset_strength(y=y_percussive, sr=sr, hop_length=ANALYSIS_TEMPO_HOP_LENGTH)
            bpm, bpm_confidence = _detect_tempo(y, sr, y_percussive=y_percussive, onset_env=onset_env)
            key_raw, key_camelot = _detect_key(y, sr, y_harmonic=y_harmonic)

        if embedded_bpm is not None:
            bpm = embedded_bpm
            bpm_confidence = 1.0

        if embedded_key is not None:
            key_raw, key_camelot = embedded_key
            key_strength = max(key_strength, 0.95)
        elif (
            ANALYSIS_ENGINE_DJ_KEY_COMPAT
            and ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_ON_LOW_CONF
            and key_strength < ANALYSIS_ENGINE_DJ_RELATIVE_MINOR_CONFIDENCE_THRESHOLD
        ):
            key_raw, key_camelot = _apply_relative_minor_fallback(key_raw, key_camelot)

        energy = _derive_energy(y, sr, onset_env=onset_env)

        return AnalysisEvent(
            track_id=track_id,
            status="done",
            bpm=bpm,
            bpm_confidence=bpm_confidence,
            key_raw=key_raw,
            key_camelot=key_camelot,
            mood=None,
            energy=energy,
        )
    except Exception as e:
        logger.error(f"Analysis failed for track {track_id}: {e}")
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )


def _analyze_track_path_child(
    track_id: int,
    track_path: str,
    result_queue: mp.Queue,
) -> None:
    result = analyze_track_path(track_id=track_id, track_path=track_path)
    result_queue.put(result.model_dump())


def analyze_track_path_isolated(
    track_id: int,
    track_path: str,
    timeout_seconds: int,
) -> AnalysisEvent:
    """Run analysis in a spawned subprocess so native crashes don't kill the API process."""
    ctx = mp.get_context("spawn")
    result_queue: mp.Queue = ctx.Queue(maxsize=1)
    process = ctx.Process(
        target=_analyze_track_path_child,
        args=(track_id, track_path, result_queue),
        name=f"analysis-track-{track_id}",
    )
    process.start()
    process.join(timeout_seconds)

    if process.is_alive():
        process.terminate()
        process.join(timeout=5)
        logger.warning("analysis subprocess timeout track_id=%s", track_id)
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )

    if process.exitcode not in (0, None):
        logger.error(
            "analysis subprocess crashed track_id=%s exitcode=%s",
            track_id,
            process.exitcode,
        )
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )

    try:
        payload = result_queue.get_nowait()
    except Empty:
        logger.error("analysis subprocess produced no payload track_id=%s", track_id)
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )

    return AnalysisEvent.model_validate(payload)


def analyze_track(track_id: int, db: Session | None = None) -> AnalysisEvent:
    """Analyze a track for BPM and key.
    
    If db is provided and the track already has analysis_status='overridden',
    skip re-analysis and return the existing values.
    """
    track = None
    if db:
        track = db.query(Track).filter(Track.id == track_id).first()
        if track and track.analysis_status == "overridden":
            # Don't re-analyze overridden tracks
            return AnalysisEvent(
                track_id=track_id,
                status="done",
                bpm=track.bpm,
                bpm_confidence=track.bpm_confidence,
                key_raw=f"{track.key_camelot}",
                key_camelot=track.key_camelot,
                mood=track.mood,
                energy=track.energy,
            )
    
    # Get track path for analysis
    track_path = None
    if track:
        track_path = track.path
    else:
        # Fallback: query without db session
        # This shouldn't happen in normal flows but included for robustness
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )
    
    try:
        return analyze_track_path(track_id=track_id, track_path=track_path)
    except Exception as e:
        logger.error(f"Analysis failed for track {track_id}: {e}")
        return AnalysisEvent(
            track_id=track_id,
            status="failed",
            bpm=None,
            bpm_confidence=None,
            key_raw="Unknown",
            key_camelot="0A",
        )
