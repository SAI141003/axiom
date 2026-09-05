"""
Smart Money Detection — Order Depth Spike + Signal Quality Scorer

Source: Web3Fuel implementation (web3fuel.io) + arXiv:2604.24366 (microstructure paper)
Reported accuracy: 73% on bid depth spikes predicting YES outcomes.
False positive rate: 4%. Average lead time: 8 minutes before price movements.

Only 3% of traders drive Polymarket's price discovery (Gómez-Cram et al., 2026).
These informed traders are 7-12× more impactful per dollar than typical participants.
Their signature: sudden depth spikes at specific price levels.

Signal Quality Score (0–100):
  - Z-score component (40 pts): depth spike vs. rolling baseline
  - OBI component (30 pts):     absolute orderbook imbalance
  - RSI component (30 pts):     momentum divergence from 50

Score ≥ cfg.smart_money_signal_threshold (default 65) → actionable signal.
Lead time: ~8 minutes average; most price movements follow within 30 minutes.

Key insight from arXiv:2604.24366:
  Trade direction inferred from Polymarket WebSocket agrees with on-chain ground
  truth only ~59% of the time. This module uses orderbook DEPTH (not direction)
  which is far more reliable as an informed-flow signal.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Optional

from core.config import cfg
from core.events import Channel, bus

log = logging.getLogger(__name__)

# Per-market depth history: deque of (ts, bid_depth_5, ask_depth_5)
_DEPTH_HISTORY: dict[str, deque] = {}
_PRICE_HISTORY: dict[str, deque] = {}
_HISTORY_LOCK = asyncio.Lock()

_MAX_HISTORY = cfg.smart_money_baseline_periods + 50


@dataclass
class SmartMoneySignal:
    market_id: str
    market_question: str
    signal_score: float       # 0-100
    direction: str            # "YES" or "NO"
    bid_depth: float
    ask_depth: float
    depth_z_score: float
    obi: float
    rsi: float
    yes_price: float
    confidence: float         # 0-1 (score / 100)
    lead_time_minutes: float = 8.0   # empirical average lead time
    ts: float = field(default_factory=time.time)


def _compute_rsi(prices: list[float], period: int = 14) -> float:
    """Wilder's RSI. Returns 50 if insufficient data."""
    if len(prices) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(prices)):
        diff = prices[i] - prices[i - 1]
        gains.append(max(diff, 0.0))
        losses.append(max(-diff, 0.0))
    avg_gain = sum(gains[-period:]) / period
    avg_loss = sum(losses[-period:]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100.0 - 100.0 / (1.0 + rs)


def _compute_signal_score(
    bid_depth: float,
    ask_depth: float,
    baseline_bid: list[float],
    baseline_ask: list[float],
    recent_prices: list[float],
) -> tuple[float, str, float, float, float]:
    """
    Returns (score, direction, obi, depth_z, rsi).
    Direction: "YES" if bid spike, "NO" if ask spike.
    """
    # Factor 1: Z-score of depth spike (max 40 points)
    baseline_bids = baseline_bid[-cfg.smart_money_baseline_periods:]
    baseline_asks = baseline_ask[-cfg.smart_money_baseline_periods:]

    bid_mean = sum(baseline_bids) / max(len(baseline_bids), 1)
    bid_std  = (sum((x - bid_mean)**2 for x in baseline_bids) / max(len(baseline_bids) - 1, 1)) ** 0.5

    ask_mean = sum(baseline_asks) / max(len(baseline_asks), 1)
    ask_std  = (sum((x - ask_mean)**2 for x in baseline_asks) / max(len(baseline_asks) - 1, 1)) ** 0.5

    bid_z = (bid_depth - bid_mean) / bid_std if bid_std > 0 else 0.0
    ask_z = (ask_depth - ask_mean) / ask_std if ask_std > 0 else 0.0

    # Use the larger z-score; direction follows whichever spiked
    if abs(bid_z) >= abs(ask_z):
        depth_z = bid_z
        direction = "YES"
    else:
        depth_z = ask_z
        direction = "NO"

    z_component = min(abs(depth_z) / cfg.smart_money_depth_z_threshold, 1.0) * 40.0

    # Factor 2: OBI absolute magnitude (max 30 points)
    total = bid_depth + ask_depth
    obi = (bid_depth - ask_depth) / total if total > 0 else 0.0
    obi_component = abs(obi) * 30.0

    # Factor 3: RSI deviation from 50 (max 30 points)
    rsi = _compute_rsi(recent_prices)
    rsi_component = (abs(rsi - 50.0) / 50.0) * 30.0

    score = z_component + obi_component + rsi_component
    return min(100.0, score), direction, obi, depth_z, rsi


# ── Per-market state tracking ─────────────────────────────────────────────────

def record_depth(market_id: str, bid_depth: float, ask_depth: float, yes_price: float) -> None:
    """
    Update rolling depth and price history for a market.
    Called from the MARKET_UPDATE event listener.
    """
    if market_id not in _DEPTH_HISTORY:
        _DEPTH_HISTORY[market_id] = deque(maxlen=_MAX_HISTORY)
        _PRICE_HISTORY[market_id] = deque(maxlen=50)

    _DEPTH_HISTORY[market_id].append((time.time(), bid_depth, ask_depth))
    _PRICE_HISTORY[market_id].append(yes_price)


def evaluate(market_id: str, market_question: str, yes_price: float) -> Optional[SmartMoneySignal]:
    """
    Evaluate a single market for smart money signals.
    Returns SmartMoneySignal if score ≥ threshold, None otherwise.
    """
    depth_hist = _DEPTH_HISTORY.get(market_id)
    price_hist = _PRICE_HISTORY.get(market_id)

    if depth_hist is None or len(depth_hist) < cfg.smart_money_baseline_periods + 2:
        return None
    if price_hist is None or len(price_hist) < 5:
        return None

    # Exclude markets that are near-certain (low information signal)
    if yes_price < 0.10 or yes_price > 0.90:
        return None

    # Current depths
    _, current_bid, current_ask = depth_hist[-1]

    # Baseline (all but latest)
    history = list(depth_hist)[:-1]
    bids = [d[1] for d in history]
    asks = [d[2] for d in history]
    prices = list(price_hist)

    score, direction, obi, depth_z, rsi = _compute_signal_score(
        current_bid, current_ask, bids, asks, prices
    )

    if score < cfg.smart_money_signal_threshold:
        return None

    return SmartMoneySignal(
        market_id=market_id,
        market_question=market_question[:80],
        signal_score=round(score, 1),
        direction=direction,
        bid_depth=round(current_bid, 2),
        ask_depth=round(current_ask, 2),
        depth_z_score=round(depth_z, 2),
        obi=round(obi, 4),
        rsi=round(rsi, 1),
        yes_price=yes_price,
        confidence=round(score / 100.0, 3),
    )


class SmartMoneyScanner:
    """
    Listens to MARKET_UPDATE events, maintains rolling depth histories,
    and periodically evaluates all markets for smart money signals.
    """

    def __init__(self) -> None:
        self._market_meta: dict[str, str] = {}  # market_id → question

    async def run(self) -> None:
        await asyncio.gather(
            self._update_loop(),
            self._scan_loop(),
        )

    async def _update_loop(self) -> None:
        """Feed every MARKET_UPDATE into per-market depth history."""
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                mid = event.get("market_id", "")
                if not mid:
                    continue
                yes_price = float(event.get("yes_price", 0.5))
                # L2 engine exposes top-5 bid/ask depths via orderbook_engine;
                # fall back to the published values when not present
                bid_depth = float(event.get("bid_depth_5", event.get("best_bid", 0) * 100))
                ask_depth = float(event.get("ask_depth_5", event.get("best_ask", 0) * 100))
                record_depth(mid, bid_depth, ask_depth, yes_price)
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("SmartMoney: update error: %s", exc)

    async def _scan_loop(self) -> None:
        """Periodically evaluate all markets with sufficient history."""
        from persist import redis_state
        while True:
            await asyncio.sleep(cfg.smart_money_scan_interval)
            try:
                markets = await redis_state.get_all_markets()
                for m in markets:
                    sig = evaluate(m.condition_id, m.question, m.yes_price)
                    if sig is None:
                        continue
                    log.info(
                        "SmartMoney: %s score=%.0f dir=%s z=%.1f OBI=%.2f RSI=%.0f",
                        m.condition_id[:8], sig.signal_score, sig.direction,
                        sig.depth_z_score, sig.obi, sig.rsi,
                    )
                    await bus.publish(Channel.ARB_OPPORTUNITY, {
                        "id":               f"sm_{m.condition_id[:10]}_{int(sig.ts)}",
                        "strategy":         "smart_money",
                        "market_a_id":      m.condition_id,
                        "market_a_question": m.question,
                        "market_a_side":    sig.direction,
                        "market_a_price":   sig.yes_price,
                        "edge":             round(sig.confidence * 0.12, 4),
                        "confidence":       sig.confidence,
                        "reason": (
                            f"Depth Z={sig.depth_z_score:+.1f}  OBI={sig.obi:+.2f}  "
                            f"RSI={sig.rsi:.0f}  score={sig.signal_score:.0f}/100"
                        ),
                        "action": f"BUY {sig.direction} (smart_money signal, lead_time≈8min)",
                        "ts": sig.ts,
                        "spot_price": 0.0, "strike_price": 0.0,
                        "tau_hours": 0.0, "realized_vol": 0.0, "model_prob": 0.0,
                    })
            except Exception as exc:
                log.debug("SmartMoney: scan error: %s", exc)


scanner = SmartMoneyScanner()
