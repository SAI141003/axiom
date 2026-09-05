"""
On-chain / Futures Market Microstructure Signal

Uses Binance Futures public endpoints (no API key required):
  - globalLongShortAccountRatio  — net positioning (crowded long vs short)
  - takerlongshortRatio          — taker order-flow imbalance (momentum proxy)
  - openInterest                 — total USD notional locked in futures

Inspired by Fincept Terminal's CoinGlass integration (liq cascades, L/S ratios,
funding pressure). We use Binance FAPI instead — zero auth, same signal content.

Outputs per-asset:
  vol_multiplier:  multiply Heston v0 before pricing (1.0 = no change)
  direction_bias:  [-1, +1] applied to annualized drift μ in the binary pricer
  confidence:      signal reliability (higher when L/S and taker agree)
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass

import aiohttp

from persist.redis_state import cache_get as _rc_get, cache_set as _rc_set

BINANCE_FAPI = "https://fapi.binance.com"
log = logging.getLogger(__name__)


@dataclass
class OnchainOutput:
    asset: str
    ls_ratio: float             # long / short account ratio (1h)
    taker_ratio: float          # taker buy vol / sell vol  (5m)
    open_interest_usd: float    # USD notional OI
    vol_multiplier: float       # ≥ 1.0 — scale Heston v0 by this
    direction_bias: float       # [-1, +1]
    confidence: float           # [0, 1]


# ── Binance FAPI fetch helpers ────────────────────────────────────────────────

async def _fapi_get(
    path: str,
    params: dict,
    cache_key: str,
    ttl: int,
) -> object:
    cached = await _rc_get(cache_key)
    if cached:
        return json.loads(cached)
    url = f"{BINANCE_FAPI}{path}"
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(url, params=params, timeout=aiohttp.ClientTimeout(total=4.0)) as r:
                if r.status != 200:
                    return None
                data = await r.json()
        await _rc_set(cache_key, json.dumps(data), ttl=ttl)
        return data
    except Exception as exc:
        log.debug("onchain %s failed: %s", cache_key, exc)
        return None


async def _fetch_ls_ratio(symbol: str) -> float:
    data = await _fapi_get(
        "/futures/data/globalLongShortAccountRatio",
        {"symbol": symbol, "period": "1h", "limit": 1},
        cache_key=f"oc:ls:{symbol}",
        ttl=300,
    )
    if isinstance(data, list) and data:
        try:
            return float(data[0]["longShortRatio"])
        except (KeyError, ValueError):
            pass
    return 1.0


async def _fetch_taker_ratio(symbol: str) -> float:
    data = await _fapi_get(
        "/futures/data/takerlongshortRatio",
        {"symbol": symbol, "period": "5m", "limit": 1},
        cache_key=f"oc:taker:{symbol}",
        ttl=30,
    )
    if isinstance(data, list) and data:
        try:
            return float(data[0]["buySellRatio"])
        except (KeyError, ValueError):
            pass
    return 1.0


async def _fetch_open_interest_usd(symbol: str) -> float:
    data = await _fapi_get(
        "/futures/data/openInterestHist",
        {"symbol": symbol, "period": "1h", "limit": 1},
        cache_key=f"oc:oi:{symbol}",
        ttl=300,
    )
    if isinstance(data, list) and data:
        try:
            return float(data[0]["sumOpenInterestValue"])
        except (KeyError, ValueError):
            pass
    return 0.0


# ── Signal computation ────────────────────────────────────────────────────────

def _derive_adjustments(
    ls_ratio: float,
    taker_ratio: float,
) -> tuple[float, float, float]:
    """
    Returns (vol_multiplier, direction_bias, confidence).

    Crowded long/short → elevated realized vol risk (classic short-squeeze / long-unwind).
    Taker imbalance → momentum direction signal.
    Signals are contrarian on L/S extremes, momentum on taker.
    """
    # Long/short ratio signal
    if ls_ratio > 2.2:
        ls_vol, ls_bias = 1.30, -0.60      # very crowded long → fade, high vol
    elif ls_ratio > 1.6:
        ls_vol, ls_bias = 1.15, -0.25
    elif ls_ratio < 0.55:
        ls_vol, ls_bias = 1.30, +0.60      # very crowded short → fade, high vol
    elif ls_ratio < 0.80:
        ls_vol, ls_bias = 1.15, +0.25
    else:
        ls_vol, ls_bias = 1.00, 0.00

    # Taker ratio signal (5-min momentum)
    if taker_ratio > 1.40:
        tk_vol, tk_bias = 1.20, +0.45
    elif taker_ratio > 1.10:
        tk_vol, tk_bias = 1.05, +0.18
    elif taker_ratio < 0.65:
        tk_vol, tk_bias = 1.20, -0.45
    elif taker_ratio < 0.90:
        tk_vol, tk_bias = 1.05, -0.18
    else:
        tk_vol, tk_bias = 1.00, 0.00

    vol_multiplier = ls_vol * tk_vol
    direction_bias = (ls_bias + tk_bias) / 2.0
    # Confidence peaks when L/S and taker agree on direction
    confidence = 0.50 + 0.30 * (1.0 if ls_bias * tk_bias > 0 else 0.0)

    return vol_multiplier, float(direction_bias), confidence


# ── Public API ────────────────────────────────────────────────────────────────

async def forecast(asset: str, symbol: str) -> OnchainOutput:
    """
    Fetch Binance futures microstructure data and compute signal adjustments.
    Always returns a valid OnchainOutput; falls back to neutral on any error.
    """
    ls_ratio, taker_ratio, oi = await asyncio.gather(
        _fetch_ls_ratio(symbol),
        _fetch_taker_ratio(symbol),
        _fetch_open_interest_usd(symbol),
    )

    vol_mul, dir_bias, conf = _derive_adjustments(ls_ratio, taker_ratio)

    log.debug(
        "Onchain %s: L/S=%.2f taker=%.2f OI=$%.1fB → vol×%.2f bias%+.2f conf=%.0f%%",
        asset, ls_ratio, taker_ratio, oi / 1e9, vol_mul, dir_bias, conf * 100,
    )

    return OnchainOutput(
        asset=asset,
        ls_ratio=ls_ratio,
        taker_ratio=taker_ratio,
        open_interest_usd=oi,
        vol_multiplier=vol_mul,
        direction_bias=dir_bias,
        confidence=conf,
    )
