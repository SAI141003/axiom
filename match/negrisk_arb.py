"""
NegRisk Dutch Book Scanner — Strategy #1 by Total Profit

Source: Saguillo et al. (arXiv:2508.03474) documented $29M extracted from NegRisk
multi-condition markets in 12 months, out of $39.6M total Polymarket arbitrage.
40.9% of all analyzed conditions had exploitable deviations.

NegRisk Markets: N mutually exclusive outcomes sharing one $1.00 probability pool.
The NegRiskAdapter smart contract allows atomic conversion:
  1 NO token on outcome_i → YES tokens on all other outcomes_j (j≠i)

No-Arbitrage Conditions:
  BUY ALL:  Σ YES_ask(i) < 1.00 − total_fees → guaranteed profit on resolution
  SELL ALL: Σ YES_bid(i) > 1.00 + total_fees → guaranteed profit now

Fee Schedule (Polymarket CLOB v2, April 2026):
  Crypto/Sports:    peak 1.80% at p=0.50  formula: fee = 0.018 × 4p(1-p)
  Politics/Finance: peak 1.00% at p=0.50  formula: fee = 0.010 × 4p(1-p)
  Geopolitical:     0% — fee-free, highest margin opportunities

Why this works:
  Retail flow concentrates on 1-2 favorites, leaving complementary probability
  space mispriced. Median arbitrage window: 2.7 seconds (2026).
  Median profit per trade: ~$400. Max annualized: several thousand percent.

Scan cadence: every 5 seconds (cfg.negrisk_scan_interval).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field, asdict
from typing import Optional

import aiohttp

from core.config import cfg
from persist.redis_state import cache_get, cache_set

log = logging.getLogger(__name__)

GAMMA_BASE = cfg.polymarket_gamma_api
_CACHE_TTL = 8  # short TTL — NegRisk windows close in 2.7s


# ── Fee curve (CLOB v2) ───────────────────────────────────────────────────────

def clob_taker_fee(p: float, category: str = "other") -> float:
    """
    Polymarket CLOB v2 dynamic taker fee: fee = peak_rate × 4p(1−p)
    Inverted-U shape peaking at p=0.50.
    Geopolitical markets: 0% fee (fee-free).
    """
    cat = category.lower()
    if cat in ("geopolitical", "world"):
        return 0.0
    peak = (
        cfg.clob_fee_peak_crypto   if cat in ("crypto",)  else
        cfg.clob_fee_peak_sports   if cat in ("sports",)  else
        cfg.clob_fee_peak_politics if cat in ("politics", "finance") else
        cfg.clob_fee_peak_other
    )
    return peak * 4.0 * p * (1.0 - p)


def total_fees_for_legs(prices: list[float], category: str) -> float:
    """Sum of taker fees across all legs."""
    return sum(clob_taker_fee(p, category) for p in prices)


# ── Data models ───────────────────────────────────────────────────────────────

@dataclass
class NegRiskLeg:
    market_id: str
    question: str
    yes_ask: float   # best ask — what we'd pay to BUY YES
    yes_bid: float   # best bid — what we'd receive to SELL YES
    volume: float = 0.0
    token_id: str = ""   # YES token — needed for CLOB orderbook validation


@dataclass
class NegRiskOpportunity:
    id: str = field(default_factory=lambda: str(uuid.uuid4())[:12])
    event_id: str = ""
    event_title: str = ""
    category: str = "other"
    direction: str = ""          # "BUY_ALL" or "SELL_ALL"
    legs: list[NegRiskLeg] = field(default_factory=list)
    sum_ask: float = 0.0
    sum_bid: float = 0.0
    total_fees: float = 0.0
    edge: float = 0.0            # net profit per $1 wagered
    edge_pct: float = 0.0        # edge as % of total cost
    min_liquidity: float = 0.0   # minimum available across all legs
    action: str = ""
    reason: str = ""
    # CLOB-validated (executable) numbers — the raw Gamma edge is a CANDIDATE
    # only; a Dutch book is real iff it prices at the live orderbook.
    exec_sum: float = 0.0        # Σ real asks (BUY_ALL) or Σ real bids (SELL_ALL)
    exec_edge: float = 0.0       # edge at executable prices, after fees
    validated: bool = False
    ts: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["strategy"] = "negrisk_dutch_book"
        return d


# ── Gamma API fetch ───────────────────────────────────────────────────────────

async def fetch_negrisk_events(limit: int = 300) -> list[dict]:
    """
    Fetch NegRisk events from Gamma API.
    Returns list of event dicts, each with 'markets' key.
    Cached for cfg.negrisk_scan_interval seconds.
    """
    cache_key = f"negrisk:events:{limit}"
    raw = await cache_get(cache_key)
    if raw:
        try:
            return json.loads(raw)
        except Exception:
            pass

    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(
                f"{GAMMA_BASE}/events",
                params={
                    "active": "true",
                    "closed": "false",
                    "neg_risk": "true",
                    "limit": limit,
                    "order": "volume",
                    "ascending": "false",
                },
                timeout=aiohttp.ClientTimeout(total=8.0),
            ) as r:
                if r.status != 200:
                    log.debug("NegRiskScanner: Gamma API %d", r.status)
                    return []
                events = await r.json()
    except Exception as exc:
        log.debug("NegRiskScanner: fetch error: %s", exc)
        return []

    valid = [e for e in events if isinstance(e, dict) and e.get("markets")]
    if valid:
        await cache_set(cache_key, json.dumps(valid), ttl=_CACHE_TTL)
    return valid


# ── Scanner logic ─────────────────────────────────────────────────────────────

def _infer_category(event: dict) -> str:
    tags = " ".join(str(t).lower() for t in event.get("tags", []))
    title = event.get("title", event.get("name", "")).lower()
    combined = tags + " " + title
    if any(w in combined for w in ("bitcoin", "btc", "crypto", "ethereum")):
        return "crypto"
    if any(w in combined for w in ("geopolit", "world event", "international")):
        return "geopolitical"
    if any(w in combined for w in ("election", "president", "congress", "senate")):
        return "politics"
    if any(w in combined for w in ("soccer", "nba", "nfl", "ufc", "tennis")):
        return "sports"
    if any(w in combined for w in ("finance", "fed", "inflation", "gdp", "nasdaq")):
        return "finance"
    return "other"


def scan_event(event: dict) -> Optional[NegRiskOpportunity]:
    """
    Evaluate a single NegRisk event for Dutch book opportunities.
    Returns an opportunity if the no-arbitrage condition is violated.
    """
    markets = event.get("markets", [])
    if len(markets) < 2:
        return None

    category = _infer_category(event)
    legs: list[NegRiskLeg] = []

    for m in markets:
        try:
            # Parse outcome prices
            prices_raw = m.get("outcomePrices", "[0.5,0.5]")
            if isinstance(prices_raw, str):
                prices = json.loads(prices_raw)
            else:
                prices = prices_raw

            yes_ask = float(prices[0]) if prices else 0.5
            no_ask  = float(prices[1]) if len(prices) > 1 else 1.0 - yes_ask

            # Best bid is typically yes_ask - spread; use 0.02 spread estimate
            yes_bid = max(0.01, yes_ask - 0.02)
            vol     = float(m.get("volume", 0))

            try:
                token_id = json.loads(m.get("clobTokenIds") or "[]")[0]
            except Exception:
                token_id = ""

            # NOTE: legs are NEVER dropped. A Dutch book needs the COMPLETE
            # basket — skipping an illiquid leg fabricates huge fake edges
            # (this bug produced the perpetual "avg edge +153%" readings).
            legs.append(NegRiskLeg(
                market_id=m.get("conditionId", m.get("condition_id", "")),
                question=m.get("question", "")[:80],
                yes_ask=round(yes_ask, 4),
                yes_bid=round(yes_bid, 4),
                volume=vol,
                token_id=token_id,
            ))
        except Exception:
            return None   # unparseable leg → basket incomplete → not an arb

    if len(legs) < 2 or len(legs) != len(markets):
        return None

    ask_prices = [l.yes_ask for l in legs]
    bid_prices = [l.yes_bid for l in legs]
    sum_ask = sum(ask_prices)
    sum_bid = sum(bid_prices)
    fees_buy  = total_fees_for_legs(ask_prices, category)
    fees_sell = total_fees_for_legs(bid_prices, category)
    min_liq   = min(l.volume for l in legs)

    event_id    = str(event.get("id", ""))
    event_title = str(event.get("title", event.get("name", "")))[:80]

    # BUY ALL: Σ YES_ask < 1.00 − fees
    if sum_ask + fees_buy < 1.00 - cfg.negrisk_min_edge:
        edge     = 1.00 - sum_ask - fees_buy
        edge_pct = edge / sum_ask if sum_ask > 0 else 0
        legs_str = "  +  ".join(
            f"YES '{l.question[:30]}' @ {l.yes_ask:.3f}" for l in legs
        )
        return NegRiskOpportunity(
            event_id=event_id,
            event_title=event_title,
            category=category,
            direction="BUY_ALL",
            legs=legs,
            sum_ask=round(sum_ask, 4),
            sum_bid=round(sum_bid, 4),
            total_fees=round(fees_buy, 4),
            edge=round(edge, 4),
            edge_pct=round(edge_pct, 4),
            min_liquidity=min_liq,
            action=f"BUY ALL YES legs — total cost={sum_ask:.3f} → guaranteed $1.00 on resolution",
            reason=f"Σ YES_ask={sum_ask:.4f} + fees={fees_buy:.4f} = {sum_ask+fees_buy:.4f} < 1.00 | legs: {legs_str}",
        )

    # SELL ALL: Σ YES_bid > 1.00 + fees
    if sum_bid - fees_sell > 1.00 + cfg.negrisk_min_edge:
        edge     = sum_bid - 1.00 - fees_sell
        edge_pct = edge / 1.0   # per $1 of resolution liability
        return NegRiskOpportunity(
            event_id=event_id,
            event_title=event_title,
            category=category,
            direction="SELL_ALL",
            legs=legs,
            sum_ask=round(sum_ask, 4),
            sum_bid=round(sum_bid, 4),
            total_fees=round(fees_sell, 4),
            edge=round(edge, 4),
            edge_pct=round(edge_pct, 4),
            min_liquidity=min_liq,
            action=f"SELL ALL YES legs (buy all NO) — receive {sum_bid:.3f} now, pay $1.00 on resolution",
            reason=f"Σ YES_bid={sum_bid:.4f} − fees={fees_sell:.4f} = {sum_bid-fees_sell:.4f} > 1.00",
        )

    return None


CLOB_BASE = "https://clob.polymarket.com"
_VALIDATION_LOG = None  # lazy Path


async def _clob_prices(tokens: list[str], side: str) -> dict[str, float]:
    """Batch executable prices from the live orderbook.
    side="SELL" → best asks (what BUY_ALL pays); side="BUY" → best bids."""
    out: dict[str, float] = {}
    try:
        async with aiohttp.ClientSession() as s:
            for i in range(0, len(tokens), 60):     # API batch limit safety
                chunk = tokens[i:i + 60]
                async with s.post(f"{CLOB_BASE}/prices",
                                  json=[{"token_id": t, "side": side} for t in chunk],
                                  timeout=aiohttp.ClientTimeout(total=8)) as r:
                    if r.status != 200:
                        continue
                    for k, v in (await r.json()).items():
                        try:
                            out[k] = float(v.get(side))
                        except Exception:
                            pass
    except Exception as exc:
        log.debug("NegRisk CLOB validation fetch error: %s", exc)
    return out


async def validate_with_clob(opp: NegRiskOpportunity) -> NegRiskOpportunity:
    """
    Re-price the ENTIRE basket at live orderbook prices. The Gamma-based edge
    is only a candidate; this is the number a real order would get.
    Every leg must have a live quote — one missing quote = no arbitrage.
    """
    tokens = [l.token_id for l in opp.legs]
    if not all(tokens):
        return opp
    side = "SELL" if opp.direction == "BUY_ALL" else "BUY"
    px = await _clob_prices(tokens, side)
    if len(px) != len(tokens):
        opp.exec_sum = -1.0             # marker: basket has unquoted legs
        return opp                      # incomplete book — cannot execute
    prices = [px[t] for t in tokens]
    if any(p <= 0 or p >= 1 for p in prices):
        return opp
    exec_sum = sum(prices)
    fees = total_fees_for_legs(prices, opp.category)
    if opp.direction == "BUY_ALL":
        opp.exec_edge = round(1.0 - exec_sum - fees, 4)
    else:
        opp.exec_edge = round(exec_sum - 1.0 - fees, 4)
    opp.exec_sum = round(exec_sum, 4)
    opp.validated = opp.exec_edge > cfg.negrisk_min_edge
    return opp


def _log_validation(opp: NegRiskOpportunity) -> None:
    """Gap journal: raw Gamma edge vs executable CLOB edge, per basket."""
    global _VALIDATION_LOG
    try:
        if _VALIDATION_LOG is None:
            from pathlib import Path
            _VALIDATION_LOG = Path(__file__).resolve().parent.parent / "logs" / "negrisk_validated.jsonl"
        with _VALIDATION_LOG.open("a") as f:
            f.write(json.dumps({
                "ts": int(time.time()), "event": opp.event_title,
                "direction": opp.direction, "legs": len(opp.legs),
                "gamma_edge": opp.edge, "exec_edge": opp.exec_edge,
                "exec_sum": opp.exec_sum, "validated": opp.validated,
                "status": "validated" if opp.validated else ("unquotable" if opp.exec_sum < 0 else "no_edge"),
                "category": opp.category, "min_liq": opp.min_liquidity,
            }) + "\n")
    except Exception:
        pass


async def scan_all() -> list[NegRiskOpportunity]:
    """Scan all NegRisk events, then VALIDATE candidates at the live orderbook.
    Only orderbook-validated opportunities are returned/published."""
    events = await fetch_negrisk_events()
    if not events:
        return []

    candidates: list[NegRiskOpportunity] = []
    for event in events:
        opp = scan_event(event)
        if opp is not None:
            candidates.append(opp)

    # validate the strongest candidates against real executable prices
    candidates.sort(key=lambda o: -abs(o.edge))
    validated: list[NegRiskOpportunity] = []
    for opp in candidates[:10]:
        opp = await validate_with_clob(opp)
        _log_validation(opp)
        if opp.validated:
            validated.append(opp)

    if candidates:
        log.info(
            "NegRiskScanner: %d candidates (gamma prices) → %d VALIDATED at the "
            "orderbook | best exec_edge=%+.3f",
            len(candidates), len(validated),
            max((o.exec_edge for o in validated), default=0.0),
        )
    return validated
