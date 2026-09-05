"""
Kalshi Cross-Platform Arbitrage Scanner (Strategy 5)

Fetches active Kalshi markets and matches them against Polymarket markets
using token-level Jaccard similarity. When both platforms price the same event
but disagree by more than the combined round-trip fee (~4%), the gap is a
genuine cross-platform statistical arbitrage.

Kalshi public REST API — no authentication required for market listings.
Base: https://trading-api.kalshi.com/trade-api/v2

Inspired by Fincept Terminal's PolymarketService + Kalshi binary options integration.
"""
from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass

import aiohttp

from core.models import Market
from persist.redis_state import cache_get as _rc_get, cache_set as _rc_set

log = logging.getLogger(__name__)

KALSHI_BASE   = "https://trading-api.kalshi.com/trade-api/v2"
_MIN_EDGE     = 0.03    # minimum edge after all fees
_MATCH_THRESH = 0.28    # Jaccard similarity to accept a match
_CACHE_TTL    = 90      # seconds


def _poly_taker_fee(p: float, category: str = "other") -> float:
    """Polymarket CLOB v2 dynamic fee: peak_rate × 4p(1−p)."""
    from match.negrisk_arb import clob_taker_fee
    return clob_taker_fee(p, category)


def _kalshi_taker_fee(p: float) -> float:
    """Kalshi fee: ceil(0.07 × contracts × p × (1−p)) — approximated as rate."""
    return 0.07 * p * (1.0 - p)


@dataclass
class KalshiMarket:
    ticker: str
    title: str
    yes_price: float   # mid-point (0–1)
    volume: float
    expiry_ts: float


# ── Kalshi data fetcher ───────────────────────────────────────────────────────

async def fetch_kalshi_markets(limit: int = 200) -> list[KalshiMarket]:
    """Fetch active Kalshi markets. Results cached 90 s in Redis."""
    cache_key = f"kalshi:mkts:{limit}"
    cached = await _rc_get(cache_key)
    if cached:
        rows = json.loads(cached)
        return [KalshiMarket(**r) for r in rows]

    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{KALSHI_BASE}/markets",
                params={"limit": limit, "status": "open"},
                headers={"Accept": "application/json"},
                timeout=aiohttp.ClientTimeout(total=7.0),
            ) as r:
                if r.status != 200:
                    log.debug("Kalshi API %d", r.status)
                    return []
                data = await r.json()
    except Exception as exc:
        log.debug("Kalshi fetch: %s", exc)
        return []

    markets: list[KalshiMarket] = []
    for item in data.get("markets", []):
        try:
            # Kalshi prices are in cents (0–100); convert to probability (0–1)
            yes_bid_raw = float(item.get("yes_bid", 0))
            yes_ask_raw = float(item.get("yes_ask", 100))
            # Skip one-sided/illiquid markets (no real quote on at least one leg)
            if yes_bid_raw <= 1 or yes_ask_raw >= 99:
                continue
            yes_bid = yes_bid_raw / 100.0
            yes_ask = yes_ask_raw / 100.0
            yes_mid = (yes_bid + yes_ask) / 2.0
            if not (0.03 < yes_mid < 0.97):
                continue

            expiry_ts = 0.0
            raw_expiry = item.get("expiration_time") or item.get("close_time")
            if raw_expiry:
                from datetime import datetime, timezone
                expiry_ts = datetime.fromisoformat(
                    raw_expiry.replace("Z", "+00:00")
                ).timestamp()

            markets.append(KalshiMarket(
                ticker=item.get("ticker", ""),
                title=item.get("title", item.get("subtitle", "")),
                yes_price=round(yes_mid, 4),
                volume=float(item.get("volume", 0)),
                expiry_ts=expiry_ts,
            ))
        except Exception:
            continue

    if markets:
        await _rc_set(cache_key, json.dumps([asdict(m) for m in markets]), ttl=_CACHE_TTL)

    log.debug("Kalshi: fetched %d active markets", len(markets))
    return markets


# ── Matching & edge calculation ───────────────────────────────────────────────

def _jaccard(a: str, b: str) -> float:
    sa = set(a.lower().split())
    sb = set(b.lower().split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _devig(yes: float, no: float) -> float:
    total = yes + no
    return yes / total if total > 0 else yes


def find_cross_platform_opps(
    poly_markets: list[Market],
    kalshi_markets: list[KalshiMarket],
) -> list[dict]:
    """
    Match markets by question similarity and return cross-platform arbitrage
    opportunities as ArbOpportunity-compatible dicts.
    """
    opps: list[dict] = []

    for km in kalshi_markets:
        best_score = 0.0
        best_pm: Market | None = None
        for pm in poly_markets:
            score = _jaccard(km.title, pm.question)
            if score > best_score:
                best_score = score
                best_pm = pm

        if best_pm is None or best_score < _MATCH_THRESH:
            continue

        poly_p   = _devig(best_pm.yes_price, best_pm.no_price)
        kalshi_p = km.yes_price
        raw_edge = abs(kalshi_p - poly_p)
        # CLOB v2 fee curve: each fee depends on the execution price
        poly_fee   = _poly_taker_fee(poly_p, best_pm.category)
        kalshi_fee = _kalshi_taker_fee(kalshi_p)
        edge       = raw_edge - poly_fee - kalshi_fee

        if edge < _MIN_EDGE:
            continue

        if kalshi_p < poly_p:
            # Kalshi is cheaper → buy YES on Kalshi, it should converge up
            side   = "YES"
            action = (
                f"BUY YES Kalshi @ {kalshi_p:.3f}  "
                f"| SELL YES Polymarket @ {poly_p:.3f}"
            )
        else:
            # Polymarket NO is cheaper → buy NO on Polymarket
            side   = "NO"
            action = (
                f"BUY NO Polymarket @ {1-poly_p:.3f}  "
                f"| SELL YES Kalshi @ {kalshi_p:.3f}"
            )

        opp_id = f"kx_{best_pm.condition_id[:10]}_{km.ticker[:8]}"
        opps.append({
            "id":                   opp_id[:20],
            "strategy":             "kalshi_cross",
            "market_a_id":          best_pm.condition_id,
            "market_a_question":    best_pm.question,
            "market_a_side":        side,
            "market_a_price":       round(poly_p, 4),
            "market_b_id":          km.ticker,
            "market_b_question":    km.title,
            "market_b_side":        side,
            "market_b_price":       round(kalshi_p, 4),
            "edge":                 round(edge, 4),
            "confidence":           round(min(0.80, best_score * 0.85), 3),
            "reason": (
                f"Poly={poly_p:.3f}  Kalshi={kalshi_p:.3f}  "
                f"match={best_score:.0%}  raw_edge={raw_edge:.3f}"
            ),
            "action":               action,
            "ts":                   time.time(),
            "spot_price":           0.0,
            "strike_price":         0.0,
            "tau_hours":            0.0,
            "realized_vol":         0.0,
            "model_prob":           0.0,
        })

    if opps:
        log.info(
            "KalshiArb: %d cross-platform opps (avg edge=+%.1f%%)",
            len(opps), sum(o["edge"] for o in opps) / len(opps) * 100,
        )
    return opps
