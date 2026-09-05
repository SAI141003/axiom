"""
Probability Calibration — Isotonic Regression on resolved p_model estimates.

Problem: LLM + Heston ensemble may be systematically overconfident.
Example: model says p=0.80 but market resolves YES only 65% of the time.
Without correction every Kelly bet is oversized by (0.80-0.65)/0.80 = 19%.

Fix: isotonic regression (PAVA algorithm) fits a monotone step function:
  calibrated_p = f(raw_p)
where f is learned from resolved (p_model, outcome) pairs.

Properties:
  - Monotone: higher raw_p always → higher calibrated_p (no rank inversion)
  - Non-parametric: makes no distributional assumption
  - Safe with small samples: identity function when n < MIN_SAMPLES
  - Per-category: crypto over/underconfidence is different from politics

Usage:
  from compound.calibration import calibrator
  p_corrected = calibrator.calibrate(raw_p, category="crypto")

The calibrator is updated hourly in BrierTracker._compute_and_report().
It reads from PostgreSQL (resolved outcomes joined with signal p_model).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)

_MIN_SAMPLES   = 30    # minimum resolved trades before calibration is applied
_MAX_SAMPLES   = 1000  # keep the most recent N per category
_UPDATE_EVERY  = 3600  # seconds between recalibration fits


@dataclass
class IsotonicModel:
    """
    Fitted isotonic regression model (PAVA).
    Stores a sorted list of (raw_p, calibrated_p) breakpoints.
    """
    breakpoints: list[tuple[float, float]] = field(default_factory=list)
    n_samples:   int   = 0
    fitted_at:   float = 0.0

    def predict(self, raw_p: float) -> float:
        """
        Interpolate calibrated probability from breakpoints.
        Returns raw_p unchanged if model has no breakpoints (not yet fitted).
        """
        if not self.breakpoints:
            return raw_p
        xs = [b[0] for b in self.breakpoints]
        ys = [b[1] for b in self.breakpoints]
        if raw_p <= xs[0]:
            return ys[0]
        if raw_p >= xs[-1]:
            return ys[-1]
        # Linear interpolation between neighbouring breakpoints
        for i in range(len(xs) - 1):
            if xs[i] <= raw_p <= xs[i + 1]:
                t = (raw_p - xs[i]) / (xs[i + 1] - xs[i])
                return ys[i] + t * (ys[i + 1] - ys[i])
        return raw_p


def _pava(raw_probs: list[float], outcomes: list[float]) -> list[tuple[float, float]]:
    """
    Pool Adjacent Violators Algorithm — fits isotonic regression.
    Guarantees monotone non-decreasing mapping.
    Returns a list of (raw_p_breakpoint, calibrated_p) pairs.
    """
    n = len(raw_probs)
    if n == 0:
        return []

    # Sort by raw probability
    pairs = sorted(zip(raw_probs, outcomes), key=lambda x: x[0])
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]

    # PAVA: pool adjacent violators
    blocks: list[list[float]] = [[y] for y in ys]
    x_blocks: list[list[float]] = [[x] for x in xs]

    i = 0
    while i < len(blocks) - 1:
        if len(blocks[i]) > 0 and len(blocks[i + 1]) > 0:
            mean_i   = sum(blocks[i])   / len(blocks[i])
            mean_i1  = sum(blocks[i+1]) / len(blocks[i+1])
            if mean_i > mean_i1:
                # Violates monotonicity — merge
                blocks[i].extend(blocks[i + 1])
                x_blocks[i].extend(x_blocks[i + 1])
                del blocks[i + 1]
                del x_blocks[i + 1]
                if i > 0:
                    i -= 1
                continue
        i += 1

    # Build breakpoints: use mean x and mean y of each block
    breakpoints: list[tuple[float, float]] = []
    for xb, yb in zip(x_blocks, blocks):
        bx = sum(xb) / len(xb)
        by = sum(yb) / len(yb)
        breakpoints.append((round(bx, 4), round(by, 4)))

    return breakpoints


class ProbabilityCalibrator:
    """
    Per-category isotonic regression calibrator.
    Thread-safe for asyncio (single event loop, no shared mutation).
    """

    def __init__(self) -> None:
        self._models: dict[str, IsotonicModel] = {}
        self._last_update: float = 0.0

    def calibrate(self, raw_p: float, category: str = "other") -> float:
        """
        Return calibrated probability for the given raw_p and market category.
        Falls back to raw_p when the model has fewer than MIN_SAMPLES.
        Always clamps output to [0.05, 0.95].
        """
        model = self._models.get(category) or self._models.get("all")
        if model is None or model.n_samples < _MIN_SAMPLES:
            return raw_p
        result = model.predict(raw_p)
        return max(0.05, min(0.95, result))

    def fit(self, raw_probs: list[float], outcomes: list[float], category: str = "all") -> None:
        """
        Fit (or refit) the isotonic model for the given category.
        outcomes must be binary: 1.0 if YES resolved, 0.0 if NO resolved.
        """
        if len(raw_probs) < _MIN_SAMPLES:
            log.debug("Calibration: insufficient samples (%d < %d) for %s", len(raw_probs), _MIN_SAMPLES, category)
            return

        bps = _pava(raw_probs, outcomes)
        self._models[category] = IsotonicModel(
            breakpoints=bps,
            n_samples=len(raw_probs),
            fitted_at=time.time(),
        )
        log.info(
            "Calibration: fitted isotonic model for %s — %d samples, %d breakpoints",
            category, len(raw_probs), len(bps),
        )

    async def update_from_db(self) -> None:
        """
        Reload calibration data from PostgreSQL resolved outcomes.
        Called hourly by BrierTracker.
        Fetches (p_model, outcome, category) for all resolved signals.
        """
        try:
            from persist import db
            rows = await db.get_resolved_signal_outcomes(limit=_MAX_SAMPLES * 5)
        except Exception as exc:
            log.debug("Calibration: DB fetch failed: %s", exc)
            return

        if not rows:
            return

        # Group by category
        from collections import defaultdict
        by_cat: dict[str, tuple[list[float], list[float]]] = defaultdict(lambda: ([], []))

        all_ps: list[float]  = []
        all_ys: list[float]  = []

        for row in rows:
            p    = float(row.get("p_model", 0.5))
            y    = float(row.get("resolved_yes", 0))
            cat  = str(row.get("category", "other"))
            by_cat[cat][0].append(p)
            by_cat[cat][1].append(y)
            all_ps.append(p)
            all_ys.append(y)

        # Fit global model first (used as fallback)
        if len(all_ps) >= _MIN_SAMPLES:
            self.fit(all_ps[-_MAX_SAMPLES:], all_ys[-_MAX_SAMPLES:], category="all")

        # Per-category models
        for cat, (ps, ys) in by_cat.items():
            if len(ps) >= _MIN_SAMPLES:
                self.fit(ps[-_MAX_SAMPLES:], ys[-_MAX_SAMPLES:], category=cat)

        self._last_update = time.time()

    def status(self) -> dict:
        return {
            cat: {
                "n_samples":    m.n_samples,
                "n_breakpoints": len(m.breakpoints),
                "fitted_ago_s": round(time.time() - m.fitted_at),
            }
            for cat, m in self._models.items()
        }


# Module-level singleton
calibrator = ProbabilityCalibrator()
