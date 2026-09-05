"""
Real-Time Order Flow Signal — Cumulative Volume Delta (CVD) from Binance aggTrades.

Research basis:
  - Order Flow Imbalance (OFI) is the single strongest predictor of 5-min price moves
    (Chordia, Roll, Subrahmanyam 2002; Cont, Kukanov, Stoikov 2014)
  - CVD Z-score > 2.5 sigma predicts upside; < -2.5 predicts downside
  - Hawkes process intensity on trade arrivals signals momentum shifts
  - At 5-min horizon, OFI explains 5–15% of return variance (R²)

Signal construction:
  1. Fetch last 500 aggTrades from Binance (covers ~60s of trades)
  2. Classify each trade: buyer_is_maker=True → seller initiated (bearish tick)
  3. CVD = Σ(qty × +1 if buy-initiated) - Σ(qty × +1 if sell-initiated)
  4. Z-score vs 1-hour rolling baseline stored in Redis
  5. OBI = (bid_depth_pct - ask_depth_pct) / total from top 20 levels

Output:
  cvd_z:          CVD z-score in [-5, +5] range
  obi:            order book imbalance in [-1, +1]
  trade_intensity: trades-per-second in last 60s (high = momentum event)
  direction_bias:  [-1, +1] combined directional signal
  vol_multiplier:  1.0 + |cvd_z| × 0.1  (vol premium when order flow spikes)

API endpoints used (all public, no auth):
  GET  /api/v3/aggTrades   — recent aggregate trades
  GET  /api/v3/depth       — order book snapshot (top 20)
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from dataclasses import dataclass
from typing import Optional

import aiohttp

from persist.redis_state import cache_get as _rc_get, cache_set as _rc_set

log = logging.getLogger(__name__)

BINANCE_REST = "https://api.binance.com"

# CVD history for z-score normalization
# Key: symbol  Value: list of (timestamp, cvd_60s) for last 60 minutes
_CVD_HISTORY: dict[str, list[tuple[float, float]]] = {}
_HISTORY_WINDOW_S = 3600  # keep 1 hour of history for z-score baseline
_CVD_CACHE_TTL = 5        # 5s cache — fresh enough for 5-min markets


@dataclass
class OrderFlowOutput:
    asset: str
    symbol: str
    cvd_60s: float          # raw CVD over last ~60s (buy_vol - sell_vol in BTC)
    cvd_z: float            # z-score vs 1h rolling baseline
    obi: float              # order book imbalance [-1, +1]
    trade_intensity: float  # trades per second (last 60s)
    direction_bias: float   # [-1, +1] combined signal
    vol_multiplier: float   # 1.0 = no change, >1.0 = elevated vol expected
    confidence: float       # signal reliability [0, 1]
    vpin: float = 0.0       # VPIN toxicity [0, 1]; >0.70 → high adverse selection risk


async def _fetch_agg_trades(
    session: aiohttp.ClientSession,
    symbol: str,
    limit: int = 500,
) -> list[dict]:
    """Fetch last `limit` aggregate trades from Binance."""
    cache_key = f"oflow:trades:{symbol}"
    cached = await _rc_get(cache_key)
    if cached:
        return json.loads(cached)

    try:
        async with session.get(
            f"{BINANCE_REST}/api/v3/aggTrades",
            params={"symbol": symbol, "limit": limit},
            timeout=aiohttp.ClientTimeout(total=4.0),
        ) as r:
            if r.status != 200:
                return []
            trades = await r.json()
        await _rc_set(cache_key, json.dumps(trades), ttl=_CVD_CACHE_TTL)
        return trades
    except Exception as exc:
        log.debug("OrderFlow: aggTrades fetch failed %s: %s", symbol, exc)
        return []


async def _fetch_order_book(
    session: aiohttp.ClientSession,
    symbol: str,
    levels: int = 20,
) -> tuple[float, float]:
    """
    Return (bid_volume_pct, ask_volume_pct) from top `levels` of the book.
    Both are fractions of total depth — OBI = bid_pct - ask_pct.
    """
    cache_key = f"oflow:book:{symbol}"
    cached = await _rc_get(cache_key)
    if cached:
        d = json.loads(cached)
        return d["bid"], d["ask"]

    try:
        async with session.get(
            f"{BINANCE_REST}/api/v3/depth",
            params={"symbol": symbol, "limit": levels},
            timeout=aiohttp.ClientTimeout(total=4.0),
        ) as r:
            if r.status != 200:
                return 0.5, 0.5
            data = await r.json()

        bid_vol = sum(float(x[1]) for x in data.get("bids", []))
        ask_vol = sum(float(x[1]) for x in data.get("asks", []))
        total   = bid_vol + ask_vol + 1e-9
        result  = {"bid": bid_vol / total, "ask": ask_vol / total}
        await _rc_set(cache_key, json.dumps(result), ttl=_CVD_CACHE_TTL)
        return result["bid"], result["ask"]
    except Exception as exc:
        log.debug("OrderFlow: depth fetch failed %s: %s", symbol, exc)
        return 0.5, 0.5


def _compute_cvd(trades: list[dict], window_s: float = 60.0) -> tuple[float, float, float]:
    """
    Compute CVD over the last `window_s` seconds.

    Returns (cvd, buy_vol, sell_vol) where:
      cvd = buy_vol - sell_vol (positive = buying pressure)
      buyer_is_maker=True → sell-initiated (aggressive seller)
      buyer_is_maker=False → buy-initiated (aggressive buyer)
    """
    if not trades:
        return 0.0, 0.0, 0.0

    cutoff_ms = (time.time() - window_s) * 1000
    buy_vol = sell_vol = 0.0

    for t in trades:
        ts_ms = t.get("T", 0)
        if ts_ms < cutoff_ms:
            continue
        qty = float(t.get("q", 0))
        if t.get("m", False):   # buyer is maker → seller initiated
            sell_vol += qty
        else:                   # buyer is maker = False → buy initiated
            buy_vol += qty

    return buy_vol - sell_vol, buy_vol, sell_vol


def _compute_vpin(trades: list[dict], n_buckets: int = 10) -> float:
    """
    Volume-Synchronized PIN (VPIN) — Easley, López de Prado, O'Hara (2012).
    "Flow Toxicity and Liquidity in a High-Frequency World", RFS 25(5).

    VPIN = mean_bucket |V_buy - V_sell| / V_bucket

    Divide trades into n_buckets equal-volume chunks.
    High VPIN (>0.70) indicates informed order flow → adverse selection risk.
    """
    if not trades or len(trades) < n_buckets * 2:
        return 0.0

    total_vol = sum(float(t.get("q", 0)) for t in trades)
    if total_vol <= 0:
        return 0.0

    bucket_size = total_vol / n_buckets
    buckets_imbalance: list[float] = []
    buy_acc = sell_acc = 0.0
    bucket_total = 0.0

    for t in trades:
        qty = float(t.get("q", 0))
        if t.get("m", False):
            sell_acc += qty
        else:
            buy_acc += qty
        bucket_total += qty

        if bucket_total >= bucket_size:
            btot = buy_acc + sell_acc
            if btot > 0:
                buckets_imbalance.append(abs(buy_acc - sell_acc) / btot)
            buy_acc = sell_acc = bucket_total = 0.0

    if not buckets_imbalance:
        return 0.0
    return min(1.0, sum(buckets_imbalance) / len(buckets_imbalance))


def _cvd_zscore(symbol: str, cvd: float) -> float:
    """
    Z-score of current CVD vs 1-hour rolling history.
    Returns 0 if insufficient history (< 10 samples).
    """
    now = time.time()
    history = _CVD_HISTORY.setdefault(symbol, [])

    # Evict old entries
    _CVD_HISTORY[symbol] = [(ts, v) for ts, v in history if now - ts < _HISTORY_WINDOW_S]

    # Record current sample
    _CVD_HISTORY[symbol].append((now, cvd))

    vals = [v for _, v in _CVD_HISTORY[symbol]]
    if len(vals) < 10:
        return 0.0

    mean = sum(vals) / len(vals)
    variance = sum((v - mean) ** 2 for v in vals) / len(vals)
    std = math.sqrt(variance) if variance > 1e-12 else 1e-9
    return max(-5.0, min(5.0, (cvd - mean) / std))


async def get_order_flow(asset: str, symbol: str) -> OrderFlowOutput:
    """
    Compute real-time order flow signal for a crypto asset.
    Uses Binance aggTrades (REST) + L2 depth snapshot.

    Always returns a result (uses defaults on API failure).
    """
    async with aiohttp.ClientSession() as session:
        trades_task   = _fetch_agg_trades(session, symbol)
        book_task     = _fetch_order_book(session, symbol)
        trades, (bid_pct, ask_pct) = await asyncio.gather(trades_task, book_task)

    cvd, buy_vol, sell_vol = _compute_cvd(trades, window_s=60.0)
    cvd_z = _cvd_zscore(symbol, cvd)
    vpin = _compute_vpin(trades)

    # Trades per second in the last 60s
    now_ms = time.time() * 1000
    cutoff_ms = now_ms - 60_000
    recent_count = sum(1 for t in trades if t.get("T", 0) >= cutoff_ms)
    trade_intensity = recent_count / 60.0

    # Order book imbalance [-1, +1]
    obi = (bid_pct - ask_pct) / (bid_pct + ask_pct + 1e-9)

    # Directional bias: combine CVD z-score (70%) + OBI (30%)
    # CVD is lagging (happened already), OBI is leading (what's queued)
    direction_bias = float(
        max(-1.0, min(1.0, cvd_z * 0.07 + obi * 0.3))
    )

    # Vol multiplier: spikes in trade intensity or |cvd_z| indicate vol events
    intensity_norm = min(trade_intensity / max(1.0, _typical_intensity(symbol)), 3.0)
    vol_multiplier = 1.0 + max(0.0, abs(cvd_z) - 1.5) * 0.08 + max(0.0, intensity_norm - 1.5) * 0.05
    vol_multiplier = min(vol_multiplier, 1.5)  # cap at +50% vol premium

    # Confidence: higher when CVD z-score and OBI agree
    agree = (cvd_z > 0) == (obi > 0)
    confidence = 0.75 if agree else 0.45
    if abs(cvd_z) < 0.5 and abs(obi) < 0.05:
        confidence = 0.30  # weak signal

    log.debug(
        "OrderFlow %s: cvd=%.4f (z=%.2f)  obi=%.3f  intensity=%.1f/s  "
        "dir=%.3f  vol_mult=%.2f  conf=%.2f  vpin=%.3f",
        symbol, cvd, cvd_z, obi, trade_intensity,
        direction_bias, vol_multiplier, confidence, vpin,
    )

    return OrderFlowOutput(
        asset=asset,
        symbol=symbol,
        cvd_60s=cvd,
        cvd_z=cvd_z,
        obi=obi,
        trade_intensity=trade_intensity,
        direction_bias=direction_bias,
        vol_multiplier=vol_multiplier,
        confidence=confidence,
        vpin=vpin,
    )


def _typical_intensity(symbol: str) -> float:
    """Approximate typical trade rate (trades/s) per symbol."""
    _rates = {
        "BTCUSDT": 40.0,
        "ETHUSDT": 30.0,
        "SOLUSDT": 25.0,
        "DOGEUSDT": 15.0,
    }
    return _rates.get(symbol, 10.0)
