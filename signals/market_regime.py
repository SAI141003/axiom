"""
Market Regime Detector & Logit-Space Price Smoother

Two components, both inspired by Fincept Terminal's Renaissance Technologies
agent (mean-reversion / momentum) and Polymarket quant bot (logit-space SMC):

1. HurstRegime — classifies a market's price history as:
     TRENDING     (H > 0.55) — follow momentum
     RANDOM       (0.45 ≤ H ≤ 0.55) — no edge from history
     MEAN_REVERTING (H < 0.45) — fade extremes

   Hurst exponent via log-log R/S analysis (Hurst 1951).
   Used in ensemble.py to gate signals:
     - TRENDING: boost signal confidence for momentum direction
     - MEAN_REVERTING: fade signals that push price further from mean

2. LogitPriceSmoother — tracks the "true" binary probability in logit space.
   Inspired by Fincept's polymarket_quant_bot.py particle filter (3000 particles).
   Simpler but faster: exponential smoothing in logit space with a Kalman-like
   observation variance model.

   The key insight: Polymarket prices are noisy (bid-ask bounce, thin liquidity).
   Raw yes_price can swing ±2% on a single trade. By smoothing in logit space
   we preserve the [0,1] constraint while reducing noise.
"""
from __future__ import annotations

import math
import logging
from dataclasses import dataclass
from enum import Enum

import numpy as np

log = logging.getLogger(__name__)


# ── 1. Hurst Exponent & Regime ─────────────────────────────────────────────────

class Regime(str, Enum):
    TRENDING       = "trending"
    MEAN_REVERTING = "mean_reverting"
    RANDOM         = "random"


@dataclass
class RegimeOutput:
    hurst: float
    half_life_bars: float   # Ornstein-Uhlenbeck half-life in bars (if mean-reverting)
    regime: Regime
    trend_direction: float  # +1 up, -1 down, 0 no trend (for TRENDING regime only)
    confidence: float       # quality of regime estimate (0–1)


def _rs_analysis(series: np.ndarray) -> list[tuple[float, float]]:
    """
    Compute (log lag, log R/S) pairs for the rescaled range analysis.
    Uses lags: [4, 8, 16, 32, 64] or fewer if series is short.
    """
    n = len(series)
    max_lag_exp = int(math.log2(n // 2)) if n >= 8 else 1
    lags = [2 ** k for k in range(2, max_lag_exp + 1)]

    results = []
    for lag in lags:
        rs_vals = []
        for start in range(0, n - lag, lag):
            sub = series[start: start + lag]
            mean_sub = np.mean(sub)
            dev = np.cumsum(sub - mean_sub)
            r = float(np.max(dev) - np.min(dev))
            s = float(np.std(sub, ddof=1))
            if s > 1e-12:
                rs_vals.append(r / s)
        if rs_vals:
            results.append((math.log(lag), math.log(np.mean(rs_vals))))

    return results


def hurst_exponent(prices: list[float]) -> float:
    """
    Estimate Hurst exponent from price series using R/S analysis.
    Returns 0.5 (random walk) if insufficient data.
    """
    if len(prices) < 16:
        return 0.5

    arr = np.array(prices, dtype=float)
    log_returns = np.diff(np.log(arr))
    if len(log_returns) < 8:
        return 0.5

    points = _rs_analysis(log_returns)
    if len(points) < 2:
        return 0.5

    x = np.array([p[0] for p in points])
    y = np.array([p[1] for p in points])
    # OLS slope = Hurst exponent
    slope = float(np.polyfit(x, y, 1)[0])
    return float(np.clip(slope, 0.01, 0.99))


def _ou_half_life(prices: list[float]) -> float:
    """
    Estimate Ornstein-Uhlenbeck half-life from price series.
    Regression: Δp_t = α + β·p_{t-1} + ε  → half_life = -ln(2)/β
    """
    if len(prices) < 8:
        return float("inf")

    arr = np.array(prices, dtype=float)
    y = np.diff(arr)
    x = arr[:-1]
    if len(x) < 4:
        return float("inf")

    try:
        coeffs = np.polyfit(x, y, 1)
        beta = coeffs[0]
        if beta >= 0:
            return float("inf")    # not mean-reverting
        return float(-math.log(2.0) / beta)
    except Exception:
        return float("inf")


def detect_regime(prices: list[float]) -> RegimeOutput:
    """
    Classify a Polymarket market's price history into a trading regime.
    prices: list of recent yes_price values (oldest first).
    """
    if len(prices) < 16:
        return RegimeOutput(
            hurst=0.5, half_life_bars=float("inf"),
            regime=Regime.RANDOM, trend_direction=0.0, confidence=0.0,
        )

    H = hurst_exponent(prices)
    half_life = _ou_half_life(prices) if H < 0.5 else float("inf")

    if H > 0.55:
        regime = Regime.TRENDING
        # Trend direction: recent momentum
        recent = np.array(prices[-8:])
        slope = float(np.polyfit(range(len(recent)), recent, 1)[0])
        trend_dir = 1.0 if slope > 0 else -1.0
        confidence = min(1.0, (H - 0.5) * 4)
    elif H < 0.45:
        regime = Regime.MEAN_REVERTING
        trend_dir = 0.0
        confidence = min(1.0, (0.5 - H) * 4)
    else:
        regime = Regime.RANDOM
        trend_dir = 0.0
        confidence = 0.0

    return RegimeOutput(
        hurst=round(H, 3),
        half_life_bars=round(half_life, 1),
        regime=regime,
        trend_direction=trend_dir,
        confidence=round(confidence, 3),
    )


# ── 2. Logit-Space Price Smoother ─────────────────────────────────────────────

_LOGIT_ALPHA  = 0.25    # EMA decay (higher = more reactive to new prices)
_OBS_NOISE    = 0.015   # observation noise std in probability space


def _logit(p: float) -> float:
    p = max(1e-6, min(1.0 - 1e-6, p))
    return math.log(p / (1.0 - p))


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


class LogitPriceSmoother:
    """
    Tracks the smoothed "true" binary probability for a single market in logit space.

    Maintains:
      - logit_est: current smoothed logit estimate
      - variance:  uncertainty in logit space (proxy for observation noise)

    All operations are O(1) — just EMA update on each tick.
    """

    def __init__(self, initial_price: float = 0.5) -> None:
        self._logit_est = _logit(initial_price)
        self._variance = 0.5    # prior uncertainty in logit space

    def update(self, yes_price: float) -> float:
        """
        Accept a new yes_price tick and update estimate.
        Returns smoothed probability (0–1).
        """
        logit_obs = _logit(yes_price)
        # EMA update in logit space: smoothed estimate → more stable than raw price
        self._logit_est = (1.0 - _LOGIT_ALPHA) * self._logit_est + _LOGIT_ALPHA * logit_obs
        # Variance tracks observation noise (useful for uncertainty estimation)
        residual = logit_obs - self._logit_est
        self._variance = (1.0 - _LOGIT_ALPHA) * self._variance + _LOGIT_ALPHA * residual ** 2
        return self.smoothed_prob

    @property
    def smoothed_prob(self) -> float:
        return _sigmoid(self._logit_est)

    @property
    def logit_variance(self) -> float:
        return self._variance

    @property
    def prob_uncertainty(self) -> float:
        """Approximate uncertainty in probability space via delta method."""
        p = self.smoothed_prob
        return math.sqrt(self._variance) * p * (1.0 - p)


# Per-market smoother singletons
_smoothers: dict[str, LogitPriceSmoother] = {}


def get_smoother(market_id: str, current_price: float = 0.5) -> LogitPriceSmoother:
    """Return (or create) the per-market logit smoother."""
    if market_id not in _smoothers:
        _smoothers[market_id] = LogitPriceSmoother(current_price)
    return _smoothers[market_id]
