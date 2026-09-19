"""Harmonic playlist ordering using the Camelot Wheel.

Algorithm:
1. All 24 Camelot keys are nodes (1A–12A, 1B–12B).
2. Cost between two keys = harmonic_distance (0–3) * key_weight + bpm_distance_cost * (1-key_weight).
3. Nearest-neighbour greedy traversal starting from the first (or best-scoring) track.
4. lock_first / lock_last pins those positions; the NN search is seeded / terminated accordingly.

Harmonic distances (Camelot wheel):
  Same key          → 0
  +1 / -1 same mode → 1  (e.g. 1A → 2A)
  A ↔ B same number  → 1  (e.g. 1A → 1B, relative major/minor)
  Two steps away     → 2
  Everything else    → 3  (capped)
"""
from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal


# ---------------------------------------------------------------------------
# Camelot wheel helpers
# ---------------------------------------------------------------------------

def _parse_camelot(key: str | None) -> tuple[int, str] | None:
    """Parse '4A' -> (4, 'A').  Returns None if unparseable."""
    if not key:
        return None
    key = key.strip().upper()
    if len(key) < 2:
        return None
    mode = key[-1]
    if mode not in ("A", "B"):
        return None
    try:
        num = int(key[:-1])
    except ValueError:
        return None
    if not 1 <= num <= 12:
        return None
    return (num, mode)


def _harmonic_distance(a: str | None, b: str | None) -> int:
    """Return harmonic distance 0–3 between two Camelot key strings."""
    pa = _parse_camelot(a)
    pb = _parse_camelot(b)
    if pa is None or pb is None:
        return 3  # treat unknown as far
    na, ma = pa
    nb, mb = pb
    if na == nb and ma == mb:
        return 0
    # Same number, different mode (relative major/minor)
    if na == nb:
        return 1
    # Same mode, ±1 on the wheel
    diff = min(abs(na - nb), 12 - abs(na - nb))
    if ma == mb:
        return min(diff, 3)
    # Different mode and different number
    return min(diff + 1, 3)


TransitionCategory = Literal[
    "perfect_match",
    "energy_boost_plus",
    "energy_boost_plus_plus",
    "energy_boost_plus_plus_plus",
    "energy_drop_minus",
    "energy_drop_minus_minus",
    "energy_drop_minus_minus_minus",
    "mood_change",
    "unscored",
]

HarmonizeProfile = Literal["build_up", "cruise", "cooldown"]


def _transition_category(a: str | None, b: str | None) -> TransitionCategory:
    """Classify a Camelot jump according to extended DJ transition categories."""
    pa = _parse_camelot(a)
    pb = _parse_camelot(b)
    if pa is None or pb is None:
        return "unscored"

    na, ma = pa
    nb, mb = pb
    if na == nb and ma == mb:
        return "perfect_match"
    if na == nb and ma != mb:
        return "mood_change"

    # Signed wheel movement from source -> target in [0, 11]
    delta = (nb - na) % 12
    if delta == 1:
        return "energy_boost_plus"
    if delta == 2:
        return "energy_boost_plus_plus"
    if delta == 3:
        return "energy_boost_plus_plus_plus"
    if delta == 11:
        return "energy_drop_minus"
    if delta == 10:
        return "energy_drop_minus_minus"
    if delta == 9:
        return "energy_drop_minus_minus_minus"
    return "unscored"


def _category_label(category: TransitionCategory) -> str:
    return {
        "perfect_match": "Perfect",
        "energy_boost_plus": "+",
        "energy_boost_plus_plus": "++",
        "energy_boost_plus_plus_plus": "+++",
        "energy_drop_minus": "-",
        "energy_drop_minus_minus": "--",
        "energy_drop_minus_minus_minus": "---",
        "mood_change": "Mood",
        "unscored": "Unscored",
    }[category]


def _profile_transition_cost(
    category: TransitionCategory,
    profile: HarmonizeProfile,
) -> float:
    """Transition preference cost in [0, 1]; lower is better."""
    tables: dict[HarmonizeProfile, dict[TransitionCategory, float]] = {
        "build_up": {
            "perfect_match": 0.08,
            "energy_boost_plus": 0.10,
            "energy_boost_plus_plus": 0.18,
            "energy_boost_plus_plus_plus": 0.28,
            "energy_drop_minus": 0.60,
            "energy_drop_minus_minus": 0.78,
            "energy_drop_minus_minus_minus": 0.92,
            "mood_change": 0.45,
            "unscored": 1.0,
        },
        "cruise": {
            "perfect_match": 0.05,
            "energy_boost_plus": 0.20,
            "energy_boost_plus_plus": 0.40,
            "energy_boost_plus_plus_plus": 0.65,
            "energy_drop_minus": 0.20,
            "energy_drop_minus_minus": 0.40,
            "energy_drop_minus_minus_minus": 0.65,
            "mood_change": 0.42,
            "unscored": 1.0,
        },
        "cooldown": {
            "perfect_match": 0.08,
            "energy_boost_plus": 0.60,
            "energy_boost_plus_plus": 0.78,
            "energy_boost_plus_plus_plus": 0.92,
            "energy_drop_minus": 0.10,
            "energy_drop_minus_minus": 0.18,
            "energy_drop_minus_minus_minus": 0.28,
            "mood_change": 0.45,
            "unscored": 1.0,
        },
    }
    return tables[profile][category]


def _bpm_distance(a: float | None, b: float | None, tolerance: float = 4.0) -> float:
    """Normalised BPM distance [0, 1].  Accounts for 2x/0.5x relationships."""
    if a is None or b is None:
        return 0.5  # partial penalty for unknown BPM
    candidates = [abs(a - b), abs(a - b * 2), abs(a * 2 - b)]
    closest = min(candidates)
    return min(closest / max(tolerance, 1.0), 1.0)


# ---------------------------------------------------------------------------
# Public interface
# ---------------------------------------------------------------------------

@dataclass
class HarmonizeRequest:
    track_ids: Sequence[int]
    bpms: Sequence[float | None]
    keys: Sequence[str | None]
    lock_first: bool = False
    lock_last: bool = False
    bpm_weight: float = 0.5          # 0 = pure key, 1 = pure BPM
    bpm_tolerance: float = 4.0       # BPM difference before cost rises
    profile: HarmonizeProfile = "cruise"


@dataclass
class TransitionDiagnostic:
    from_track_id: int
    to_track_id: int
    from_key: str | None
    to_key: str | None
    category: TransitionCategory
    label: str
    compatibility: float


@dataclass
class HarmonizeDiagnostics:
    transitions: list[TransitionDiagnostic]
    compatibility_score: float
    risky_jumps: int
    energy_trend: Literal["rising", "falling", "flat", "mixed"]


def harmonize(req: HarmonizeRequest) -> list[int]:
    """Return a reordered copy of req.track_ids that minimises harmonic jumps.

    Rules:
    - lock_first: the first track in the input stays at position 0.
    - lock_last:  the last track stays at the final position.
    - The inner N-2 (or N-1, or N) tracks are greedy-reordered between the anchors.
    """
    n = len(req.track_ids)
    if n <= 1:
        return list(req.track_ids)

    ids = req.track_ids
    bpms = req.bpms
    keys = req.keys

    first_id = ids[0] if req.lock_first else None  # noqa: F841
    last_id = ids[-1] if req.lock_last else None  # noqa: F841

    # Build the pool of freely-movable tracks
    fixed_first = req.lock_first
    fixed_last = req.lock_last

    pool_indices: list[int]
    if fixed_first and fixed_last:
        pool_indices = list(range(1, n - 1))
        anchor_start = 0
        anchor_end = n - 1
    elif fixed_first:
        pool_indices = list(range(1, n))
        anchor_start = 0
        anchor_end = None
    elif fixed_last:
        pool_indices = list(range(0, n - 1))
        anchor_start = None
        anchor_end = n - 1
    else:
        pool_indices = list(range(0, n))
        anchor_start = None
        anchor_end = None

    def cost(i: int, j: int) -> float:
        kw = 1.0 - req.bpm_weight
        bw = req.bpm_weight
        category = _transition_category(keys[i], keys[j])
        hdist = _profile_transition_cost(category, req.profile)
        bdist = _bpm_distance(bpms[i], bpms[j], req.bpm_tolerance)
        return kw * hdist + bw * bdist

    # Nearest-neighbour greedy from the best starting candidate
    def nn_order(pool: list[int], start_anchor_idx: int | None) -> list[int]:
        remaining = list(pool)
        if not remaining:
            return []

        if start_anchor_idx is not None:
            current = start_anchor_idx
        else:
            # Pick starting track: lowest average cost to its nearest neighbour
            best_start = remaining[0]
            best_score = math.inf
            for candidate in remaining:
                others = [r for r in remaining if r != candidate]
                if not others:
                    break
                min_cost = min(cost(candidate, o) for o in others)
                if min_cost < best_score:
                    best_score = min_cost
                    best_start = candidate
            current = best_start
            remaining.remove(current)
            result = [current]

            while remaining:
                nearest = min(remaining, key=lambda j: cost(current, j))
                remaining.remove(nearest)
                result.append(nearest)
                current = nearest
            return result

        # start_anchor_idx is given – pick nearest from pool first
        result: list[int] = []
        current = start_anchor_idx
        while remaining:
            nearest = min(remaining, key=lambda j: cost(current, j))
            remaining.remove(nearest)
            result.append(nearest)
            current = nearest
        return result

    ordered_pool = nn_order(pool_indices, anchor_start)

    # Assemble final order
    result: list[int] = []
    if fixed_first:
        result.append(anchor_start)  # type: ignore[arg-type]
    result.extend(ordered_pool)
    if fixed_last:
        result.append(anchor_end)  # type: ignore[arg-type]

    return [ids[i] for i in result]


def build_harmonize_diagnostics(
    track_ids: Sequence[int],
    key_by_track_id: dict[int, str | None],
) -> HarmonizeDiagnostics:
    """Build transition diagnostics for an already ordered track list."""
    if len(track_ids) <= 1:
        return HarmonizeDiagnostics(
            transitions=[],
            compatibility_score=100.0,
            risky_jumps=0,
            energy_trend="flat",
        )

    transitions: list[TransitionDiagnostic] = []
    trend_score = 0
    risky = 0

    for i in range(len(track_ids) - 1):
        left_id = track_ids[i]
        right_id = track_ids[i + 1]
        left_key = key_by_track_id.get(left_id)
        right_key = key_by_track_id.get(right_id)
        category = _transition_category(left_key, right_key)
        compatibility = max(0.0, 1.0 - _profile_transition_cost(category, "cruise"))
        transitions.append(
            TransitionDiagnostic(
                from_track_id=left_id,
                to_track_id=right_id,
                from_key=left_key,
                to_key=right_key,
                category=category,
                label=_category_label(category),
                compatibility=round(compatibility, 3),
            )
        )
        if category in {
            "energy_boost_plus",
            "energy_boost_plus_plus",
            "energy_boost_plus_plus_plus",
        }:
            trend_score += 1
        elif category in {
            "energy_drop_minus",
            "energy_drop_minus_minus",
            "energy_drop_minus_minus_minus",
        }:
            trend_score -= 1

        if category in {
            "energy_boost_plus_plus_plus",
            "energy_drop_minus_minus_minus",
            "unscored",
        }:
            risky += 1

    avg_compatibility = (
        sum(t.compatibility for t in transitions) / len(transitions)
        if transitions
        else 1.0
    )
    if trend_score >= 2:
        trend = "rising"
    elif trend_score <= -2:
        trend = "falling"
    elif trend_score == 0:
        trend = "flat"
    else:
        trend = "mixed"

    return HarmonizeDiagnostics(
        transitions=transitions,
        compatibility_score=round(avg_compatibility * 100.0, 1),
        risky_jumps=risky,
        energy_trend=trend,
    )
