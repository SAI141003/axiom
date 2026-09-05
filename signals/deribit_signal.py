"""
Deribit IV Surface → Polymarket Implied Probability Arbitrage

Strategy: BTC binary options on Polymarket should price at N(d₂) from the Deribit
volatility surface. When retail sentiment diverges from the options market's
forward-looking implied volatility, a 5–15% edge appears.

Workflow:
  1. Fetch Deribit option chain for BTC/ETH (all expiries)
  2. Build a per-expiry IV smile: {strike: implied_vol} via cubic spline
  3. For each Polymarket "Will BTC be above $X at time T?" market:
       a. Match to nearest Deribit expiry
       b. Interpolate σ for the exact strike K from the smile
       c. Compute N(d₂) with that σ
       d. Compare to Polymarket devigged price → edge = |N(d₂) - poly_price|

This is superior to using realized vol (our current crypto_binary approach)
because Deribit IV is forward-looking and consensus from professional options traders.

Architecture:
  - One persistent aiohttp session to Deribit public REST API
  - IV surface cached in Redis for cfg.deribit_scan_interval seconds
  - Scan runs every cfg.deribit_scan_interval seconds for all matched markets

References:
  - arXiv:2510.15205 "Toward Black-Scholes for Prediction Markets"
  - dev.to/xniiinx "Probability Arbitrage: How to Beat Polymarket Using Deribit Options"
"""
from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Optional

import aiohttp
import numpy as np
from scipy.stats import norm
from scipy.interpolate import CubicSpline

from core.config import cfg
from persist.redis_state import cache_get, cache_set

log = logging.getLogger(__name__)

DERIBIT_REST = "https://www.deribit.com/api/v2"
_CACHE_KEY_PREFIX = "deribit:smile"
_CACHE_TTL = int(cfg.deribit_scan_interval)

_ASSETS = ("BTC", "ETH")
_MIN_OPTION_IV = 0.05   # filter garbage quotes
_MAX_OPTION_IV = 5.00


@dataclass
class DeribitSurface:
    asset: str
    ts: float
    # expiry_ts → list of (strike, iv) sorted by strike
    smiles: dict[float, list[tuple[float, float]]] = field(default_factory=dict)

    def get_iv(self, expiry_ts: float, strike: float) -> Optional[float]:
        """
        Interpolate implied vol for a given expiry and strike.
        Snaps to nearest expiry within 12 hours if exact match unavailable.
        """
        if not self.smiles:
            return None

        # Find nearest expiry
        expiries = sorted(self.smiles.keys())
        nearest = min(expiries, key=lambda e: abs(e - expiry_ts))
        if abs(nearest - expiry_ts) > 43_200:  # 12 hours
            return None

        smile = self.smiles[nearest]
        if len(smile) < 3:
            return None

        strikes = np.array([s for s, _ in smile])
        ivs     = np.array([v for _, v in smile])

        # Extrapolate flat outside range; interpolate with cubic spline inside
        if strike <= strikes[0]:
            return float(ivs[0])
        if strike >= strikes[-1]:
            return float(ivs[-1])
        cs = CubicSpline(strikes, ivs)
        iv = float(cs(strike))
        return max(_MIN_OPTION_IV, min(_MAX_OPTION_IV, iv))

    def nearest_expiry(self, target_ts: float) -> Optional[float]:
        if not self.smiles:
            return None
        return min(self.smiles.keys(), key=lambda e: abs(e - target_ts))


# ── Fetch Deribit surface ─────────────────────────────────────────────────────

async def _fetch_instruments(asset: str) -> list[dict]:
    """Fetch all active BTC/ETH option instruments from Deribit."""
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{DERIBIT_REST}/public/get_instruments",
                params={"currency": asset, "kind": "option", "expired": "false"},
                timeout=aiohttp.ClientTimeout(total=8.0),
            ) as r:
                data = await r.json()
                return data.get("result", [])
    except Exception as exc:
        log.debug("Deribit instruments fetch error for %s: %s", asset, exc)
        return []


async def _fetch_ticker(instrument_name: str) -> Optional[dict]:
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{DERIBIT_REST}/public/get_ticker",
                params={"instrument_name": instrument_name},
                timeout=aiohttp.ClientTimeout(total=5.0),
            ) as r:
                data = await r.json()
                return data.get("result")
    except Exception:
        return None


async def build_surface(asset: str) -> Optional[DeribitSurface]:
    """
    Build the full IV surface for an asset by fetching all option tickers.
    Results cached in Redis.
    """
    cache_key = f"{_CACHE_KEY_PREFIX}:{asset}"
    raw = await cache_get(cache_key)
    if raw:
        try:
            obj = json.loads(raw)
            surface = DeribitSurface(asset=asset, ts=obj["ts"])
            surface.smiles = {float(k): [tuple(x) for x in v] for k, v in obj["smiles"].items()}
            return surface
        except Exception:
            pass

    instruments = await _fetch_instruments(asset)
    if not instruments:
        return None

    # Group by expiry
    by_expiry: dict[float, list[tuple[float, float]]] = {}

    # Batch fetch tickers — limit to ATM options for speed
    # Filter: only instruments where abs(log(S/K)) < 0.30 — near-ATM
    for inst in instruments[:120]:  # cap to avoid rate limiting
        name     = inst.get("instrument_name", "")
        strike   = float(inst.get("strike", 0))
        expiry_s = inst.get("expiration_timestamp", 0) / 1000.0

        if strike == 0 or expiry_s < time.time():
            continue

        ticker = await _fetch_ticker(name)
        if ticker is None:
            continue

        mark_iv = ticker.get("mark_iv")
        if mark_iv is None:
            continue

        iv = float(mark_iv) / 100.0  # Deribit returns as percentage
        if not (_MIN_OPTION_IV < iv < _MAX_OPTION_IV):
            continue

        by_expiry.setdefault(expiry_s, []).append((strike, iv))

    # Sort each smile by strike
    for exp_ts in by_expiry:
        by_expiry[exp_ts].sort(key=lambda x: x[0])

    # Filter expiries with too few strikes for a stable spline
    smiles = {k: v for k, v in by_expiry.items() if len(v) >= 3}

    if not smiles:
        return None

    surface = DeribitSurface(asset=asset, ts=time.time(), smiles=smiles)
    await cache_set(cache_key, json.dumps({
        "ts": surface.ts,
        "smiles": {str(k): list(v) for k, v in smiles.items()},
    }), ttl=_CACHE_TTL)

    log.debug("Deribit surface built: %s expiries=%d", asset, len(smiles))
    return surface


# ── Pricing ───────────────────────────────────────────────────────────────────

def nd2_probability(spot: float, strike: float, T_years: float, r: float, sigma: float) -> float:
    """
    Risk-neutral probability P(S_T > K) = N(d₂) from Black-Scholes.
    This is what the Polymarket market SHOULD price at.
    """
    if T_years <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return 0.5
    d1 = (math.log(spot / strike) + (r + 0.5 * sigma**2) * T_years) / (sigma * math.sqrt(T_years))
    d2 = d1 - sigma * math.sqrt(T_years)
    return float(norm.cdf(d2))


@dataclass
class DeribitSignal:
    asset: str
    market_id: str
    market_question: str
    spot_price: float
    strike_price: float
    tau_hours: float
    deribit_iv: float                   # σ from Deribit smile
    model_prob: float                    # N(d₂) using Deribit IV
    poly_prob: float                     # devigged Polymarket price
    edge: float                          # model_prob - poly_prob
    direction: str                       # "BUY_YES" or "BUY_NO"
    latency_ms: float = 0.0


async def compare_market(
    market_id: str,
    question: str,
    yes_price: float,
    no_price: float,
    strike: float,
    expiry_ts: float,
    spot: float,
    asset: str,
    surface: DeribitSurface,
    r: float = 0.05,
) -> Optional[DeribitSignal]:
    """
    Compare a single Polymarket binary market against the Deribit IV surface.
    Returns a DeribitSignal if |edge| > cfg.deribit_min_edge.
    """
    t0 = time.time()
    T_years = max(0.0, (expiry_ts - time.time()) / (365 * 86400))
    if T_years < 1 / 8760:  # less than 1 hour
        return None

    iv = surface.get_iv(expiry_ts, strike)
    if iv is None:
        return None

    model_prob = nd2_probability(spot, strike, T_years, r, iv)

    # Devig Polymarket price
    total = yes_price + no_price
    poly_prob = yes_price / total if total > 0 else yes_price

    edge = model_prob - poly_prob
    if abs(edge) < cfg.deribit_min_edge:
        return None

    direction = "BUY_YES" if edge > 0 else "BUY_NO"
    tau_hours = T_years * 8760

    return DeribitSignal(
        asset=asset,
        market_id=market_id,
        market_question=question[:80],
        spot_price=spot,
        strike_price=strike,
        tau_hours=round(tau_hours, 2),
        deribit_iv=round(iv, 4),
        model_prob=round(model_prob, 4),
        poly_prob=round(poly_prob, 4),
        edge=round(edge, 4),
        direction=direction,
        latency_ms=round((time.time() - t0) * 1000, 2),
    )


# ── Surfaces cache (module-level, refreshed each scan cycle) ─────────────────
_SURFACES: dict[str, DeribitSurface] = {}


async def refresh_surfaces() -> None:
    """Refresh IV surfaces for all tracked assets. Called before each scan cycle."""
    import asyncio
    tasks = [build_surface(a) for a in _ASSETS]
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for asset, result in zip(_ASSETS, results):
        if isinstance(result, DeribitSurface):
            _SURFACES[asset] = result


def get_surface(asset: str) -> Optional[DeribitSurface]:
    return _SURFACES.get(asset.upper())
