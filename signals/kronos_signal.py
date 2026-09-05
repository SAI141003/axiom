"""
Kronos foundation model integration for price-linked markets.

Kronos (AAAI 2026): two-stage framework — OHLCV tokenizer → decoder-only transformer.
Models: Kronos-mini (4.1M params, 2048 context) for low latency.
        Kronos-small (24.7M params) for higher accuracy.

For prediction markets:
  - Fetch historical price data for the linked asset (BTC, ETH, NVDA, etc.)
  - Run Kronos inference to forecast next 60-120 minutes
  - Threshold the forecast against the market's resolution condition
  - Produce a probability estimate

The Kronos model is loaded once as a singleton to avoid reload overhead.
Inference runs in a thread pool (blocking PyTorch calls).
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.models import KronosOutput, Market, SignalDirection

log = logging.getLogger(__name__)

_KRONOS_LOADED = False
_TOKENIZER = None
_MODEL = None
_PREDICTOR = None


async def _ensure_loaded() -> bool:
    """Load Kronos model once. Returns True if available."""
    global _KRONOS_LOADED, _TOKENIZER, _MODEL, _PREDICTOR
    if _KRONOS_LOADED:
        return _MODEL is not None

    try:
        import os
        if cfg.hf_token and not os.environ.get("HF_TOKEN"):
            os.environ["HF_TOKEN"] = cfg.hf_token   # from_pretrained reads env, not cfg
        # Kronos repo lives at <project>/kronos_repo (cloned from
        # github.com/shiyu-coder/Kronos) — its `model` package isn't pip-installable
        import sys
        from pathlib import Path
        _repo = Path(__file__).resolve().parent.parent / "kronos_repo"
        if _repo.exists() and str(_repo) not in sys.path:
            sys.path.insert(0, str(_repo))
        from model.kronos import Kronos, KronosTokenizer, KronosPredictor  # type: ignore

        log.info("Kronos: loading %s on %s...", cfg.kronos_model, cfg.kronos_device)

        # context length: Kronos-mini=2048, Kronos-small/base=512
        _ctx = 2048 if "mini" in cfg.kronos_model.lower() else 512

        def _load():
            tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
            mdl = Kronos.from_pretrained(cfg.kronos_model)
            mdl.to(cfg.kronos_device)
            mdl.eval()
            return tok, mdl, KronosPredictor(mdl, tok, max_context=_ctx)

        _TOKENIZER, _MODEL, _PREDICTOR = await asyncio.get_running_loop().run_in_executor(None, _load)
        _KRONOS_LOADED = True
        log.info("Kronos: loaded ✓")
        return True
    except ImportError:
        log.warning("Kronos: model package not found — price forecasting disabled")
        _KRONOS_LOADED = True  # Mark as attempted to avoid repeated retries
        return False
    except Exception as exc:
        log.warning("Kronos: load error: %s", exc)
        _KRONOS_LOADED = True
        return False


# ── Asset price fetching ──────────────────────────────────────────────────────

_BINANCE_REST = "https://api.binance.com"
_ASSET_SYMBOL = {
    "BTC": "BTCUSDT", "ETH": "ETHUSDT", "SOL": "SOLUSDT",
    "DOGE": "DOGEUSDT", "AVAX": "AVAXUSDT", "XRP": "XRPUSDT",
}


async def _fetch_ohlcv(asset: str, limit: int = 512) -> Optional[object]:
    """
    Fetch recent OHLCV data for an asset.

    Crypto (BTC/ETH/SOL/DOGE/AVAX/XRP):
      Uses Binance 1-minute klines — 240× better resolution than CoinGecko 4h bars.
      limit=512 → 8.5 hours of 1-min bars at full Kronos context window.

    Stocks: yfinance 15-min bars (unchanged).

    Returns a pandas DataFrame: [open, high, low, close, volume] indexed by timestamp.
    """
    try:
        import aiohttp
        import pandas as pd

        symbol = _ASSET_SYMBOL.get(asset.upper())
        if symbol:
            async with aiohttp.ClientSession() as session:
                async with session.get(
                    f"{_BINANCE_REST}/api/v3/klines",
                    params={"symbol": symbol, "interval": "1m", "limit": limit},
                    timeout=aiohttp.ClientTimeout(total=8.0),
                ) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()

            # Binance klines: [open_time, open, high, low, close, volume, ...]
            df = pd.DataFrame(data, columns=[
                "timestamp", "open", "high", "low", "close", "volume",
                "close_time", "quote_vol", "trades", "taker_base", "taker_quote", "ignore",
            ])
            df = df[["timestamp", "open", "high", "low", "close", "volume"]].copy()
            for col in ["open", "high", "low", "close", "volume"]:
                df[col] = df[col].astype(float)
            df["timestamp"] = pd.to_datetime(df["timestamp"], unit="ms")
            df.set_index("timestamp", inplace=True)
            return df

        else:
            # Stocks via yfinance (optional dependency)
            try:
                import yfinance as yf

                def _fetch():
                    ticker = yf.Ticker(asset)
                    return ticker.history(period="7d", interval="15m").tail(limit)

                return await asyncio.get_running_loop().run_in_executor(None, _fetch)
            except ImportError:
                return None

    except Exception as exc:
        log.debug("OHLCV fetch error for %s: %s", asset, exc)
        return None


def _extract_resolution_threshold(question: str, asset: str) -> Optional[float]:
    """
    Parse the price threshold from a market question.
    E.g., "Will BTC be above $100,000 by June 2025?" → 100000.0
    """
    import re
    # Match dollar amounts: $100,000 or $100K or $100k
    patterns = [
        r"\$\s*([\d,]+(?:\.\d+)?)\s*[kK]",  # $100k
        r"\$\s*([\d,]+(?:\.\d+)?)",            # $100,000
    ]
    for pattern in patterns:
        match = re.search(pattern, question)
        if match:
            num_str = match.group(1).replace(",", "")
            multiplier = 1000 if "k" in match.group(0).lower() else 1
            return float(num_str) * multiplier
    return None


# Per-asset forecast cache — CPU inference costs ~5-13s, so the hot signal
# path (2s budget in signal_worker) reads warm results; inference refreshes
# at most once per TTL per asset.
_FC_CACHE: dict[str, tuple[float, "KronosOutput"]] = {}
_FC_TTL_S = 120.0
_FC_RUNNING: set[str] = set()


async def forecast(market: Market) -> Optional[KronosOutput]:
    """
    Run Kronos price forecast for a market with a linked asset.
    Returns KronosOutput or None if unavailable.
    """
    if not cfg.use_kronos:
        return None

    if not market.linked_asset:
        return None

    available = await _ensure_loaded()
    if not available or _PREDICTOR is None:
        return None

    # warm cache hit — instant, fits the 2s live-path budget
    cached = _FC_CACHE.get(market.linked_asset)
    if cached and (time.time() - cached[0]) < _FC_TTL_S:
        return cached[1]
    if market.linked_asset in _FC_RUNNING:
        return cached[1] if cached else None   # stale-if-refreshing, never block

    start = time.time()

    # Fetch historical data
    df = await _fetch_ohlcv(market.linked_asset)
    if df is None or len(df) < 50:
        log.debug("Kronos: insufficient data for %s", market.linked_asset)
        return None

    try:
        import pandas as pd
        from datetime import datetime, timedelta, timezone

        now = datetime.now(timezone.utc)
        forecast_horizon = 60  # predict 60 bars (minutes) ahead
        # KronosPredictor expects pandas Series of timestamps (uses .dt accessor):
        # x_timestamp = one stamp per history bar, y_timestamp = one per pred bar
        x_ts = pd.Series(pd.to_datetime(df.index))
        last = pd.Timestamp(df.index[-1])
        y_ts = pd.Series(pd.date_range(last + timedelta(minutes=1),
                                       periods=forecast_horizon, freq="min"))

        def _run_inference():
            # ENSEMBLE: 5 stochastic runs (T=0.8 sampling). Cross-run direction
            # agreement is the model's honest confidence; cross-run dispersion
            # is a model-implied vol forecast. A single run's softmax
            # "confidence" was always 0.95-1.0 — meaningless.
            runs = []
            for _ in range(5):
                r = _PREDICTOR.predict(
                    df=df,
                    x_timestamp=x_ts,
                    y_timestamp=y_ts,
                    pred_len=forecast_horizon,
                    T=0.8,
                    top_p=0.9,
                    sample_count=1,
                    verbose=False,
                )
                if r is not None and not r.empty:
                    runs.append(r)
            return runs

        _FC_RUNNING.add(market.linked_asset)
        try:
            run_dfs = await asyncio.wait_for(
                asyncio.get_running_loop().run_in_executor(None, _run_inference),
                timeout=60.0,
            )
        finally:
            _FC_RUNNING.discard(market.linked_asset)

        if not run_dfs:
            return None
        pred_df = run_dfs[0]
        cur_px = float(df["close"].iloc[-1])
        run_means = [float(r["close"].mean()) for r in run_dfs]
        ups = sum(1 for m in run_means if m > cur_px)
        agreement = max(ups, len(run_means) - ups) / len(run_means)
        if len(run_means) > 1:
            mu = sum(run_means) / len(run_means)
            disp = (sum((m - mu) ** 2 for m in run_means) / len(run_means)) ** 0.5
            pred_vol_bp = round(disp / cur_px * 10000, 2)
            # point estimate = ensemble mean across runs
            import pandas as _pd
            pred_df = _pd.concat(run_dfs).groupby(level=0).mean()
        else:
            pred_vol_bp = None

        current_price = float(df["close"].iloc[-1])
        # Use mean of predicted close values as point estimate
        predicted_price = float(pred_df["close"].mean())
        price_change_pct = (predicted_price - current_price) / current_price

        direction = SignalDirection.BULLISH if predicted_price > current_price else SignalDirection.BEARISH

        # Compute probability against resolution threshold
        threshold = _extract_resolution_threshold(market.question, market.linked_asset)
        if threshold:
            # Simple probability: fraction of samples that exceed threshold
            if "close" in pred_df.columns:
                above_count = (pred_df["close"] > threshold).sum()
                threshold_prob = float(above_count) / max(len(pred_df), 1)
            else:
                # Fallback: logistic approximation
                z = (predicted_price - threshold) / (threshold * 0.05)
                threshold_prob = 1.0 / (1.0 + 2.718 ** (-z))
        else:
            # No explicit threshold: use momentum direction
            threshold_prob = 0.5 + min(abs(price_change_pct) * 2, 0.4) * (1 if direction == SignalDirection.BULLISH else -1)
            threshold_prob = max(0.1, min(0.9, threshold_prob))

        # Confidence: based on sample agreement
        if hasattr(pred_df, "std") and "close" in pred_df.columns:
            std_pct = pred_df["close"].std() / current_price
            confidence = max(0.3, 1.0 - min(std_pct * 10, 0.7))
        else:
            confidence = 0.6

        out = KronosOutput(
            asset=market.linked_asset,
            current_price=current_price,
            predicted_price=predicted_price,
            forecast_horizon_minutes=forecast_horizon,
            confidence=confidence,
            direction=direction,
            threshold_probability=threshold_prob,
            latency_ms=(time.time() - start) * 1000,
            agreement=agreement,
            pred_vol_bp=pred_vol_bp,
        )
        _FC_CACHE[market.linked_asset] = (time.time(), out)
        return out

    except asyncio.TimeoutError:
        log.warning("Kronos: inference timeout for %s", market.linked_asset)
    except Exception as exc:
        log.warning("Kronos: inference error: %s", exc)

    return None


# ── Fine-tuning ───────────────────────────────────────────────────────────────

async def fine_tune_on_outcomes(lookback_days: int = 30) -> None:
    """
    Incremental fine-tuning of Kronos on recent resolved trade outcomes.
    Called by BrierTracker when Brier score exceeds degradation threshold.
    No-ops gracefully if model isn't loaded or training data is insufficient.
    """
    available = await _ensure_loaded()
    if not available or _MODEL is None:
        log.debug("fine_tune_on_outcomes: Kronos not loaded — skipping")
        return

    try:
        from persist.db import get_brier_score

        bs = await get_brier_score(lookback_days=lookback_days)
        if bs < 0.28:
            log.debug("fine_tune_on_outcomes: BS=%.4f healthy — no fine-tune needed", bs)
            return

        log.info(
            "fine_tune_on_outcomes: BS=%.4f — initiating incremental fine-tune (lookback=%dd)",
            bs, lookback_days,
        )

        try:
            from model.kronos import KronosTrainer  # type: ignore

            def _train():
                trainer = KronosTrainer(_MODEL, lr=1e-5, epochs=1)
                trainer.fine_tune_from_recent(lookback_days=lookback_days)

            await asyncio.get_running_loop().run_in_executor(None, _train)
            log.info("fine_tune_on_outcomes: completed")
        except ImportError:
            log.debug("fine_tune_on_outcomes: KronosTrainer not available — skipping LoRA pass")
        except Exception as exc:
            log.warning("fine_tune_on_outcomes: training error: %s", exc)

    except Exception as exc:
        log.warning("fine_tune_on_outcomes: outer error: %s", exc)
