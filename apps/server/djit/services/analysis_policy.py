from __future__ import annotations

import os


ANALYSIS_SKIP_OVER_DURATION_SECONDS = float(
    os.getenv("DJIT_ANALYSIS_SKIP_OVER_DURATION_SECONDS", "720")
)


def should_skip_analysis_duration(duration_seconds: float | None) -> bool:
    if ANALYSIS_SKIP_OVER_DURATION_SECONDS <= 0:
        return False
    if duration_seconds is None:
        return False
    return duration_seconds > ANALYSIS_SKIP_OVER_DURATION_SECONDS
