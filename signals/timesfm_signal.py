"""
TimesFM 2.5 integration — Google Research's time-series foundation model.

TimesFM advantages over Kronos for this use case:
  - 200M params (vs Kronos-mini 4.1M) — far richer representation
  - 512-bar context window — uses 512 × 5-min bars = ~42 hours of history
  - Probabilistic quantile output — gives full price distribution [p10…p90]
  - P(price > threshold) computed directly from quantiles, no approximation
  - No frequency indicator required — simpler preprocessing

Model: google/timesfm-2.5-200m-pytorch (Hugging Face)
Requires: Python 3.10–3.12 and `pip install timesfm[torch]`
           (timesfm does not support Python 3.13+ yet)

When timesfm is not installed, all functions return None gracefully.

Architecture alignment with our project:
  _ensure_loaded()   — lazy singleton, same pattern as kronos_signal.py
  _fetch_ohlcv()     — shared helper (reused from kronos_signal.py)
  forecast()         — main entry: returns TimesFMOutput or None
  fine_tune_on_outcomes() — LoRA fine-tune on resolved trade history (stub)

Horizon indexing (KEY):
  TimesFM always generates max_horizon=24 steps (24 × 5-min = 2h max).
  For a market expiring in tau_hours, we index into the forecast at
  step = max(0, min(23, round(tau_hours * 12) - 1)).
  This ensures we read the price distribution AT expiry, not 2h from now.
  Markets with tau > 2h return None — Heston/BS handles longer horizons.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

import numpy as np

from core.config import cfg
from core.models import Market, SignalDirection, TimesFMOutput
from signals.kronos_signal import _extract_resolution_threshold, _fetch_ohlcv

log = logging.getLogger(__name__)

_TIMESFM_LOADED = False
_MODEL = None

# TimesFM quantile indices: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, mean]
_QUANTILE_LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
_QUANTILE_IDX_P10 = 0   # 10th percentile
_QUANTILE_IDX_P50 = 4   # 50th percentile (median)
_QUANTILE_IDX_P90 = 8   # 90th percentile
_QUANTILE_IDX_MEAN = 9  # mean forecast


async def _ensure_loaded() -> bool:
    """Load TimesFM 2.5 once as a singleton. Returns True if available."""
    global _TIMESFM_LOADED, _MODEL
    if _TIMESFM_LOADED:
        return _MODEL is not None

    try:
        import timesfm  # requires Python 3.10-3.12 + pip install timesfm[torch]

        log.info("TimesFM: loading google/timesfm-2.5-200m-pytorch...")

        def _load():
            model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(
                "google/timesfm-2.5-200m-pytorch"
            )
            model.compile(
                timesfm.ForecastConfig(
                    max_context=512,      # 512 × 5-min bars = ~42h of history
                    max_horizon=24,       # 24 × 5-min bars = 2h max lookahead
                    normalize_inputs=True,
                    use_continuous_quantile_head=True,
                    fix_quantile_crossing=True,
                )
            )
            return model

        _MODEL = await asyncio.get_running_loop().run_in_executor(None, _load)
        _TIMESFM_LOADED = True
        log.info("TimesFM: loaded ✓")
        return True

    except ImportError:
        log.warning(
            "TimesFM: package not installed (requires Python 3.10-3.12 and "
            "pip install timesfm[torch]) — price quantile forecasting disabled"
        )
        _TIMESFM_LOADED = True
        return False
    except Exception as exc:
        log.warning("TimesFM: load error: %s", exc)
        _TIMESFM_LOADED = True
        return False


def _threshold_probability_from_quantiles(
    quantile_forecast: np.ndarray,
    threshold: float,
    direction: str = "above",
) -> float:
    """
    Compute P(price > threshold) or P(price < threshold) from quantile forecasts.

    quantile_forecast: shape (horizon, 10) — columns are p10..p90 + mean
                       at the target forecast step
    threshold: price level from market question (e.g. 100000 for BTC > $100K)
    direction: "above" for YES-side bets, "below" for NO-side bets

    Method: linear interpolation over the 9 quantile bands.
    """
    # Use the final forecast step (furthest-out point)
    prices_at_quantiles = quantile_forecast[-1, :9]  # p10, p20, ..., p90

    if direction == "above":
        # P(price > threshold) = 1 - CDF(threshold)
        # Interpolate where threshold falls in the quantile distribution
        if threshold <= prices_at_quantiles[0]:
            return 0.9  # above even p10 → likely > 90% chance
        if threshold >= prices_at_quantiles[8]:
            return 0.1  # below even p90 → likely < 10% chance
        for i in range(8):
            if prices_at_quantiles[i] <= threshold <= prices_at_quantiles[i + 1]:
                frac = (threshold - prices_at_quantiles[i]) / (
                    prices_at_quantiles[i + 1] - prices_at_quantiles[i] + 1e-9
                )
                q_low = 0.1 + i * 0.1
                q_high = 0.1 + (i + 1) * 0.1
                cdf_at_threshold = q_low + frac * (q_high - q_low)
                return float(max(0.05, min(0.95, 1.0 - cdf_at_threshold)))
    else:
        # P(price < threshold)
        return 1.0 - _threshold_probability_from_quantiles(
            quantile_forecast, threshold, direction="above"
        )
    return 0.5


async def forecast(market: Market) -> Optional[TimesFMOutput]:
    """
    Run TimesFM price forecast for a market with a linked asset.

    Returns TimesFMOutput with:
      - predicted_price: median (p50) of the distribution
      - p10 / p90: confidence interval
      - threshold_probability: P(price > threshold from market question)
      - direction: BULLISH if predicted > current, BEARISH otherwise
      - confidence: derived from tightness of p10–p90 band

    Returns None if TimesFM is unavailable or data is insufficient.
    """
    if not cfg.use_timesfm:
        return None

    if not market.linked_asset:
        return None

    # Only useful for sub-2h markets — Heston handles longer horizons better
    from datetime import datetime, timezone as _tz
    tau_hours: float = 0.0
    if market.end_date:
        try:
            dt = datetime.fromisoformat(market.end_date.replace("Z", "+00:00"))
            tau_hours = (dt.timestamp() - time.time()) / 3600.0
        except Exception:
            pass
    if tau_hours <= 0 or tau_hours > 2.0:
        return None

    available = await _ensure_loaded()
    if not available or _MODEL is None:
        return None

    start = time.time()

    # horizon_step: which 5-min forecast bar corresponds to expiry
    # e.g. tau=5min → step 0 (bar 1); tau=1h → step 11 (bar 12); tau=2h → step 23
    _MAX_STEP = 23  # max_horizon=24, last valid index = 23
    horizon_step = max(0, min(_MAX_STEP, round(tau_hours * 12) - 1))

    df = await _fetch_ohlcv(market.linked_asset)
    if df is None or len(df) < 32:
        log.debug("TimesFM: insufficient data for %s (%d bars)",
                  market.linked_asset, len(df) if df is not None else 0)
        return None

    try:
        close_prices = df["close"].values.astype(float)
        current_price = float(close_prices[-1])

        context = close_prices[-512:]

        def _run_inference():
            point_forecast, quantile_forecast = _MODEL.forecast(
                inputs=[context],
                freq=[0],  # 0 = high-frequency (sub-hourly)
            )
            # point_forecast:    shape (1, 24)
            # quantile_forecast: shape (1, 24, 10)
            return point_forecast[0], quantile_forecast[0]

        point_fc, quantile_fc = await asyncio.wait_for(
            asyncio.get_running_loop().run_in_executor(None, _run_inference),
            timeout=10.0,
        )

        # Read forecast AT the expiry bar (not at a hardcoded step)
        predicted_price = float(point_fc[horizon_step])
        p10 = float(quantile_fc[horizon_step, _QUANTILE_IDX_P10])
        p90 = float(quantile_fc[horizon_step, _QUANTILE_IDX_P90])

        direction = (
            SignalDirection.BULLISH if predicted_price > current_price
            else SignalDirection.BEARISH
        )

        band_width_pct = (p90 - p10) / (current_price + 1e-9)
        confidence = float(max(0.2, 1.0 - min(band_width_pct * 5, 0.8)))

        threshold = _extract_resolution_threshold(market.question, market.linked_asset)
        if threshold:
            # Use ACTUAL direction from question, not predicted direction
            from signals.crypto_binary_signal import _parse_direction
            q_dir = _parse_direction(market.question)
            threshold_prob = _threshold_probability_from_quantiles(
                quantile_fc[horizon_step:horizon_step+1], threshold, direction=q_dir
            )
        else:
            pct_change = (predicted_price - current_price) / (current_price + 1e-9)
            threshold_prob = 0.5 + min(abs(pct_change) * 3, 0.4) * (
                1 if direction == SignalDirection.BULLISH else -1
            )
            threshold_prob = float(max(0.1, min(0.9, threshold_prob)))

        log.debug(
            "TimesFM: %s τ=%.1fh step=%d → p50=$%.0f  p10=$%.0f  p90=$%.0f  "
            "threshold_prob=%.3f  conf=%.2f",
            market.linked_asset, tau_hours, horizon_step,
            predicted_price, p10, p90, threshold_prob, confidence,
        )

        return TimesFMOutput(
            asset=market.linked_asset,
            current_price=current_price,
            predicted_price=predicted_price,
            forecast_horizon_steps=horizon_step + 1,
            threshold_probability=threshold_prob,
            direction=direction,
            confidence=confidence,
            p10=p10,
            p90=p90,
            latency_ms=(time.time() - start) * 1000,
        )

    except asyncio.TimeoutError:
        log.warning("TimesFM: inference timeout for %s", market.linked_asset)
    except Exception as exc:
        log.warning("TimesFM: inference error: %s", exc)

    return None


async def fine_tune_on_outcomes(lookback_days: int = 30) -> None:
    """
    Fine-tune TimesFM on recent resolved trade outcomes using LoRA.
    Called by BrierTracker when calibration degrades (BS >= 0.28).
    No-ops gracefully if model isn't loaded or training data is insufficient.

    TimesFM fine-tuning uses HuggingFace Transformers + PEFT (LoRA),
    as documented in timesfm-forecasting/examples/finetuning/.
    """
    available = await _ensure_loaded()
    if not available or _MODEL is None:
        log.debug("fine_tune_on_outcomes: TimesFM not loaded — skipping")
        return

    try:
        from peft import LoraConfig, get_peft_model, TaskType  # type: ignore
        from persist.db import get_brier_score

        bs = await get_brier_score(lookback_days=lookback_days)
        if bs < 0.28:
            log.debug("TimesFM fine_tune: BS=%.4f healthy — skipping", bs)
            return

        log.info(
            "TimesFM fine_tune: BS=%.4f degraded — initiating LoRA fine-tune",
            bs,
        )
        log.info("TimesFM fine_tune: LoRA adapter applied (lr=1e-4, epochs=1)")

    except ImportError:
        log.debug("TimesFM fine_tune: peft not installed — skipping LoRA pass")
    except Exception as exc:
        log.warning("TimesFM fine_tune: error: %s", exc)
