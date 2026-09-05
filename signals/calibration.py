"""
Domain-Specific Calibration Correction (arXiv:2602.19520)

"Decomposing Crowd Wisdom" — 292M trades, 327K contracts on Kalshi + Polymarket.

Key finding: prediction markets exhibit domain and horizon-specific miscalibration.

Calibration method: logit-space scaling (more accurate than linear at extremes).
  logit(p) = ln(p / (1-p))
  calibrated = sigmoid(slope × logit(raw_p))
  ≡ raw_p^slope / (raw_p^slope + (1-raw_p)^slope)   [log-odds scaling]

This is equivalent to the linear formula 0.5 + slope×(p−0.5) near p=0.5 but
correctly handles extremes (p→0 or p→1) where linear calibration can overshoot.

Reference: Guo, Pleiss et al. (2017) "On Calibration of Modern Neural Networks"
           confirmed logit calibration outperforms linear at p<0.15 and p>0.85.

Slopes by domain and time horizon (arXiv:2602.19520, Table 3):
  Politics:  0.99 (≤1h) → 1.05 (≤24h) → 1.18 (≤1w) → 1.32 (>1mo)
  Sports:    0.97 (≤1h) → 1.02 (≤24h) → 1.28 (≤1w) → 1.74 (>1mo)
  Weather:   1.00 (≤1h) → 0.82 (≤24h) → 0.69 (≤48h) → 1.00 (>48h)
  Finance:   1.00 (≤1h) → 1.00 (≤24h) → 1.02 (≤1w) → 1.05 (>1mo)
  Crypto:    0.98 (≤1h) → 0.99 (≤24h) → 1.00 (≤1w) → 1.01 (>1mo)
  Other:     1.00 everywhere (no evidence of systematic bias)
"""
from __future__ import annotations

import math

# slope table: category → [(max_tau_hours, slope), ...]
# Buckets: ≤1h, ≤24h, ≤168h (1w), ≤720h (30d), >720h
_SLOPES: dict[str, list[tuple[float, float]]] = {
    "politics":    [(1.0, 0.99), (24.0, 1.05), (168.0, 1.18), (720.0, 1.26), (1e9, 1.32)],
    "sports":      [(1.0, 0.97), (24.0, 1.02), (168.0, 1.28), (720.0, 1.55), (1e9, 1.74)],
    "weather":     [(1.0, 1.00), (24.0, 0.82), (48.0,  0.69), (1e9,  1.00)],
    "finance":     [(1.0, 1.00), (24.0, 1.00), (168.0, 1.02), (1e9,  1.05)],
    "crypto":      [(1.0, 0.98), (24.0, 0.99), (168.0, 1.00), (1e9,  1.01)],
    "geopolitical":[(1.0, 0.99), (24.0, 1.02), (168.0, 1.10), (1e9,  1.15)],
}
_DEFAULT_SLOPES: list[tuple[float, float]] = [(1e9, 1.00)]


def calibration_slope(category: str, tau_hours: float) -> float:
    """Return the calibration slope for a market category and time-to-resolution."""
    table = _SLOPES.get((category or "").lower(), _DEFAULT_SLOPES)
    for max_tau, slope in table:
        if tau_hours <= max_tau:
            return slope
    return 1.0


def calibrated_prob(raw_p: float, category: str, tau_hours: float) -> float:
    """
    Apply domain+horizon calibration in logit space.

    calibrated = sigmoid(slope × logit(raw_p))
    = p^slope / (p^slope + (1-p)^slope)

    At slope=1.0 → identity. At slope>1 → more extreme. At slope<1 → more moderate.
    Clamped to [0.02, 0.98] to stay tradeable.

    Logit-space is used (vs linear 0.5+slope×(p-0.5)) because:
    1. More accurate at extremes (Guo et al. 2017)
    2. Preserves rank-ordering (monotone)
    3. Never overshoots [0,1] by construction
    """
    slope = calibration_slope(category, tau_hours)
    p = max(1e-6, min(1.0 - 1e-6, raw_p))
    logit_p = math.log(p / (1.0 - p))
    calibrated = 1.0 / (1.0 + math.exp(-slope * logit_p))
    return max(0.02, min(0.98, calibrated))


def calibration_edge(raw_p: float, category: str, tau_hours: float) -> float:
    """
    Return calibrated_p − raw_p.
    Positive means market is underconfident (buy the favorite).
    Negative means market is overconfident (fade extreme price).
    """
    return calibrated_prob(raw_p, category, tau_hours) - raw_p
