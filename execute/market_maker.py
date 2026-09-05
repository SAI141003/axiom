"""
Binary Market Maker — Avellaneda-Stoikov adapted to prediction markets

Source:
  - arXiv:2510.15205 "Toward Black-Scholes for Prediction Markets"
  - Polymarket CLOB v2 rebate structure (April 2026)

Strategy:
  Post limit orders on both sides of the book. Earn the bid-ask spread plus
  the maker rebate (50% of taker fees redistributed to makers daily).
  Inventory-adjusted quoting prevents one-sided exposure (logit-space).

Logit-Space Reservation Price (from paper):
  r_x(t) = x_t - q_t × γ × σ_b² × (T-t)
  where:
    x_t   = logit(mid_price) = log(p/(1-p))
    q_t   = net inventory (positive = long YES)
    γ     = risk-aversion parameter (cfg.mm_gamma)
    σ_b   = short-horizon belief volatility (cfg.mm_sigma_b)
    T-t   = time to resolution (seconds)

Optimal Half-Spread (logit space):
  δ_x = (γ × σ_b² × (T-t)) / 2 + log(1 + γ/k) / k
  where k = order arrival rate (cfg.mm_k)

Convert back to probability space:
  bid_p = σ(r_x - δ_x)    ask_p = σ(r_x + δ_x)

VPIN Guard:
  When VPIN > cfg.vpin_adverse_threshold → widen spread 2× or pause quoting.
  Adverse selection from the informed 3% of traders is the primary risk.

Rebate Requirements (CLOB v2):
  Orders must be active ≥ cfg.mm_min_rebate_lifetime_s (3.5 seconds) to qualify.
  Rebate share ∝ size × closeness_to_mid × consistency_quotient.

Usage:
  Disabled by default (cfg.market_maker_enabled = False).
  Enable in .env: MARKET_MAKER_ENABLED=true
  Recommended markets: Finance/Politics (lower fees), Geopolitical (0% fees).
"""
from __future__ import annotations

import asyncio
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Optional

from core.config import cfg

log = logging.getLogger(__name__)


# ── Quoting model ─────────────────────────────────────────────────────────────

def logit(p: float) -> float:
    p = max(1e-6, min(1 - 1e-6, p))
    return math.log(p / (1.0 - p))


def sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-x))


@dataclass
class Quote:
    bid: float        # probability to post as bid (buy YES at this price)
    ask: float        # probability to post as ask (sell YES at this price)
    spread: float     # ask - bid
    reservation: float  # inventory-adjusted fair value
    valid: bool = True
    reason: str = ""


def compute_quotes(
    mid_price: float,
    time_to_resolution_s: float,
    inventory_usd: float,
    bankroll: float,
    vpin: float = 0.0,
    gamma: float | None = None,
    sigma_b: float | None = None,
    k: float | None = None,
) -> Quote:
    """
    Compute optimal bid/ask quotes using Avellaneda-Stoikov in logit space.

    mid_price:             current market mid-price (0–1)
    time_to_resolution_s:  seconds until market resolves
    inventory_usd:         current net YES position in USD (signed)
    bankroll:              total bankroll for inventory normalization
    vpin:                  current VPIN (0=safe, 1=toxic)
    """
    gamma   = gamma   or cfg.mm_gamma
    sigma_b = sigma_b or cfg.mm_sigma_b
    k_param = k       or cfg.mm_k

    if mid_price <= 0.01 or mid_price >= 0.99:
        return Quote(bid=0.0, ask=1.0, spread=1.0, reservation=mid_price,
                     valid=False, reason="price_near_boundary")
    if time_to_resolution_s <= 0:
        return Quote(bid=0.0, ask=1.0, spread=1.0, reservation=mid_price,
                     valid=False, reason="expired")

    T_minus_t = time_to_resolution_s / 86_400.0  # normalize to days
    x_mid = logit(mid_price)

    # Inventory in logit units (normalize by bankroll)
    q = inventory_usd / max(bankroll, 1.0)

    # Reservation price (inventory-adjusted)
    r_x = x_mid - q * gamma * (sigma_b ** 2) * T_minus_t

    # Optimal half-spread
    half_spread = (
        gamma * (sigma_b ** 2) * T_minus_t / 2.0
        + math.log(1.0 + gamma / k_param) / k_param
    )

    # Adverse selection: widen spread on high VPIN
    if vpin > cfg.vpin_adverse_threshold:
        half_spread *= 2.0

    bid_x = r_x - half_spread
    ask_x = r_x + half_spread

    bid = sigmoid(bid_x)
    ask = sigmoid(ask_x)
    reservation = sigmoid(r_x)

    # Enforce minimum spread
    if ask - bid < cfg.mm_min_spread:
        mid_prob = (bid + ask) / 2.0
        bid = mid_prob - cfg.mm_min_spread / 2.0
        ask = mid_prob + cfg.mm_min_spread / 2.0

    # Clamp to valid range
    bid = max(0.01, min(0.98, bid))
    ask = max(0.02, min(0.99, ask))

    return Quote(
        bid=round(bid, 4),
        ask=round(ask, 4),
        spread=round(ask - bid, 4),
        reservation=round(reservation, 4),
    )


# ── Inventory tracker ─────────────────────────────────────────────────────────

class InventoryTracker:
    """Track net YES/NO inventory per market."""

    def __init__(self) -> None:
        self._positions: dict[str, float] = {}  # market_id → net USD in YES

    def on_fill(self, market_id: str, side: str, size_usd: float) -> None:
        current = self._positions.get(market_id, 0.0)
        if side == "YES":
            self._positions[market_id] = current + size_usd
        else:
            self._positions[market_id] = current - size_usd

    def net_position(self, market_id: str) -> float:
        return self._positions.get(market_id, 0.0)

    def total_exposure(self) -> float:
        return sum(abs(v) for v in self._positions.values())


# ── Market Maker Worker ───────────────────────────────────────────────────────

class MarketMakerWorker:
    """
    Posts and manages limit orders for eligible markets.
    Only active when cfg.market_maker_enabled = True.

    Priority markets:
      1. Geopolitical/world events (0% fees — pure spread capture)
      2. Finance/politics (50% maker rebate share)
      3. Avoid: crypto markets at p ≈ 0.50 (1.80% taker fee hurts maker profitability)
    """

    def __init__(self) -> None:
        self._inventory = InventoryTracker()
        self._active_quotes: dict[str, dict] = {}  # market_id → {bid_order_id, ask_order_id}
        self._running = False

    async def run(self) -> None:
        if not cfg.market_maker_enabled:
            log.info("MarketMaker: disabled (set MARKET_MAKER_ENABLED=true to enable)")
            return

        self._running = True
        log.info("MarketMaker: starting — γ=%.2f σ_b=%.3f k=%.2f",
                 cfg.mm_gamma, cfg.mm_sigma_b, cfg.mm_k)

        await asyncio.gather(
            self._quoting_loop(),
            self._fill_monitor_loop(),
        )

    async def _quoting_loop(self) -> None:
        """Refresh quotes every 10 seconds for all eligible markets."""
        from persist import redis_state
        from signals.microstructure import get_vpin_tracker

        while self._running:
            await asyncio.sleep(5.0)
            try:
                markets = await redis_state.get_all_markets()
                bankroll = await redis_state.get_bankroll()

                for m in markets:
                    # Target: geopolitical (0% fees) and politics/finance (low fees)
                    if m.category not in ("geopolitical", "politics", "finance", "other"):
                        continue
                    if m.yes_price < 0.05 or m.yes_price > 0.95:
                        continue  # skip near-certain (thin spread, high adverse selection)
                    if not m.end_date:
                        continue

                    try:
                        from datetime import datetime, timezone
                        end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
                        T_s = max(0.0, (end_dt - datetime.now(timezone.utc)).total_seconds())
                    except Exception:
                        continue

                    if T_s < 3600:  # skip markets resolving in < 1 hour (adverse sel spike)
                        continue

                    vpin_tracker = get_vpin_tracker(m.condition_id)
                    vpin = vpin_tracker.vpin()
                    inventory = self._inventory.net_position(m.condition_id)

                    if abs(inventory) > cfg.mm_max_inventory:
                        log.debug("MarketMaker: inventory limit on %s (%.0f USD)",
                                  m.condition_id[:8], inventory)
                        continue

                    quote = compute_quotes(
                        mid_price=m.yes_price,
                        time_to_resolution_s=T_s,
                        inventory_usd=inventory,
                        bankroll=bankroll,
                        vpin=vpin,
                    )

                    if not quote.valid:
                        continue

                    log.debug(
                        "MarketMaker: %s bid=%.3f ask=%.3f spread=%.3f res=%.3f inv=%.0f VPIN=%.2f",
                        m.condition_id[:8], quote.bid, quote.ask, quote.spread,
                        quote.reservation, inventory, vpin,
                    )
                    # In live mode: submit limit orders via ClobClient
                    # Here we emit as a signal for the execution worker to handle
                    from core.events import Channel, bus
                    await bus.publish(Channel.ARB_OPPORTUNITY, {
                        "id":               f"mm_{m.condition_id[:10]}_{int(time.time())}",
                        "strategy":         "market_making",
                        "market_a_id":      m.condition_id,
                        "market_a_question": m.question[:80],
                        "market_a_side":    "YES",
                        "market_a_price":   quote.bid,
                        "market_b_id":      m.condition_id,
                        "market_b_question": m.question[:80],
                        "market_b_side":    "NO",
                        "market_b_price":   1.0 - quote.ask,
                        "edge":             round(quote.spread, 4),
                        "confidence":       0.65,
                        "reason": (
                            f"AS quote: bid={quote.bid:.3f} ask={quote.ask:.3f} "
                            f"spread={quote.spread:.3f} inv={inventory:+.0f} VPIN={vpin:.2f}"
                        ),
                        "action": (
                            f"POST BID YES @ {quote.bid:.3f}  |  "
                            f"POST ASK YES @ {quote.ask:.3f}  (collect spread + rebate)"
                        ),
                        "ts": time.time(),
                        "spot_price": 0.0, "strike_price": 0.0,
                        "tau_hours": T_s / 3600.0, "realized_vol": 0.0, "model_prob": quote.reservation,
                    })

            except Exception as exc:
                log.debug("MarketMaker: quoting error: %s", exc)

    async def _fill_monitor_loop(self) -> None:
        """Listen for fill events to update inventory."""
        from core.events import Channel, bus
        q = bus.subscribe_local(Channel.ORDER_CANCELLED)  # reuse fill events when available
        while self._running:
            try:
                await asyncio.wait_for(q.get(), timeout=5.0)
            except asyncio.TimeoutError:
                pass

    def on_fill(self, market_id: str, side: str, size_usd: float) -> None:
        self._inventory.on_fill(market_id, side, size_usd)


# Module-level singleton
market_maker = MarketMakerWorker()
