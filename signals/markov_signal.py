"""
PATH G — Markov State Transition Signal (BTC Priority)

Tracks BTC price ticks, buckets them into 5-min windows (OHLC), and builds
a first-order Markov chain over UP/DOWN states. The persistence score
P(state → state) measures how strongly the current trend will continue.

From the CLAUDE × HERMES bot (@BONEREAPER, $794k, 14 months):
  α = φ − q ≥ ε → ENTER     (model prob minus market price ≥ min_gap)
  f* = p − (1−p)/b            (Kelly sizing)
  Enter only when persistence ≥ 0.87

288 windows/day (24h × 12 per hour). With 50-window lookback (~4 hours),
the transition matrix is statistically stable for BTC.

Concurrency: one asyncio.Lock per asset — safe for concurrent signal_worker tasks.
Cached in Redis with 5-min TTL (one window length).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from collections import deque
from typing import Optional

from core.config import cfg
from core.models import Market, MarkovOutput, MarkovState
from persist.redis_state import cache_get, cache_set

log = logging.getLogger(__name__)

# Per-asset price history: deque of (unix_ts, price)
_PRICE_BUF: dict[str, deque] = {}
_BUF_LOCKS: dict[str, asyncio.Lock] = {}

_BTC_KEYWORDS = {"BTC", "BITCOIN", "BTCUSDT", "BTCUSD", "BTC/USD"}


def _is_btc(market: Market) -> bool:
    if market.linked_asset and market.linked_asset.upper() in _BTC_KEYWORDS:
        return True
    q = market.question.upper()
    return "BITCOIN" in q or " BTC " in q or q.startswith("BTC")


def _asset_key(market: Market) -> str:
    return (market.linked_asset or "BTC").upper()


def _classify(price_open: float, price_close: float) -> MarkovState:
    return MarkovState.UP if price_close >= price_open else MarkovState.DOWN


def _build_matrix(states: list[MarkovState]) -> dict[str, dict[str, float]]:
    """
    Empirical 2×2 transition matrix from a state sequence.
    Laplace-smoothed (+1 pseudocount) to avoid zero-probability cells.
    """
    counts: dict[str, dict[str, float]] = {
        "up":   {"up": 1.0, "down": 1.0},
        "down": {"up": 1.0, "down": 1.0},
    }
    for i in range(len(states) - 1):
        counts[states[i].value][states[i + 1].value] += 1.0

    matrix: dict[str, dict[str, float]] = {}
    for from_s, to_dict in counts.items():
        total = sum(to_dict.values())
        matrix[from_s] = {k: v / total for k, v in to_dict.items()}
    return matrix


def _persistence(matrix: dict[str, dict[str, float]], state: MarkovState) -> float:
    return matrix.get(state.value, {}).get(state.value, 0.5)


def _ticks_to_windows(
    ticks: list[tuple[float, float]],
    window_s: int,
) -> list[tuple[float, float]]:
    """
    Group (ts, price) ticks into window_s-second buckets.
    Returns list of (open_price, close_price) per completed bucket.
    """
    if not ticks:
        return []
    windows: list[tuple[float, float]] = []
    bucket_start = ticks[0][0]
    bucket_open = ticks[0][1]
    bucket_close = ticks[0][1]

    for ts, price in ticks[1:]:
        if ts - bucket_start >= window_s:
            windows.append((bucket_open, bucket_close))
            bucket_start = ts
            bucket_open = price
        bucket_close = price

    # Include in-progress bucket if it has meaningful data
    if bucket_close != bucket_open:
        windows.append((bucket_open, bucket_close))
    return windows


async def push_price(asset: str, price: float) -> None:
    """
    Feed a new price tick into the asset's rolling buffer.
    Called by market_watcher on every BTC price update event.
    """
    key = asset.upper()
    if key not in _PRICE_BUF:
        _PRICE_BUF[key] = deque(maxlen=cfg.markov_lookback_n + 20)
        _BUF_LOCKS[key] = asyncio.Lock()

    async with _BUF_LOCKS[key]:
        _PRICE_BUF[key].append((time.time(), price))


async def forecast(market: Market) -> Optional[MarkovOutput]:
    """
    Compute Markov State Transition forecast for a BTC market.
    Returns None if market is not BTC, insufficient history, or Redis unavailable.
    """
    if not _is_btc(market):
        return None

    t0 = time.time()
    asset = _asset_key(market)

    # Check Redis cache first (TTL = one 5-min window)
    cache_key = f"markov:{asset}:v1"
    raw = await cache_get(cache_key)
    if raw:
        try:
            return MarkovOutput(**json.loads(raw))
        except Exception:
            pass

    buf = _PRICE_BUF.get(asset)
    if buf is None or len(buf) < cfg.markov_min_history:
        log.debug("Markov: insufficient history for %s (%d/%d ticks)",
                  asset, len(buf) if buf else 0, cfg.markov_min_history)
        return None

    lock = _BUF_LOCKS.get(asset)
    if lock:
        async with lock:
            ticks = list(buf)
    else:
        ticks = list(buf)

    windows = _ticks_to_windows(ticks, cfg.markov_window_s)
    if len(windows) < 5:
        return None

    states = [_classify(o, c) for o, c in windows]
    matrix = _build_matrix(states)
    current_state = states[-1]
    persist = _persistence(matrix, current_state)
    confirmed = persist >= cfg.markov_min_persistence

    out = MarkovOutput(
        asset=asset,
        current_state=current_state,
        persistence=round(persist, 4),
        transition_matrix=matrix,
        n_windows=len(windows),
        signal_confirmed=confirmed,
        latency_ms=round((time.time() - t0) * 1000, 2),
    )

    await cache_set(cache_key, out.model_dump_json(), ttl=cfg.markov_window_s)
    log.debug(
        "Markov %s: state=%s persist=%.3f confirmed=%s windows=%d",
        asset, current_state.value, persist, confirmed, len(windows),
    )
    return out
