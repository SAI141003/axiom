"""
TICK REACTOR — Sub-10ms hot-path decision engine.

Reacts to MARKET_UPDATE events and fires instant trade signals without
waiting for LLM classification. Decision time target: < 10ms.

Entry logic (all 4 gates must pass):
  1. Price velocity > cfg.tick_reactor_velocity_threshold (market moving fast)
  2. Acceleration confirms direction (not decelerating into reversal)
  3. Microstructure gate: latency decay + EV + OBI + VPIN (all in-process)
  4. Minimum raw edge >= cfg.tick_reactor_min_edge after velocity forecast

Kelly sizing: cfg.tick_reactor_kelly_scale × normal Kelly (conservative — no LLM).
Debounce: same market cannot re-fire within _MIN_REFIRE_S (15s).

Publishes to signal.fast — ExecutionWorker picks it up and submits to CLOB.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import Market, Signal, SignalDirection
from ingest.orderbook_engine import get_l2_book
from persist import redis_state
from signals.microstructure import lambda_for_category, microstructure_gate
from signals.velocity import get_velocity, push_tick

log = logging.getLogger(__name__)

_DEDUP: dict[str, float] = {}   # market_id → last fire monotonic timestamp
_MIN_REFIRE_S = 15.0


class TickReactor:
    """
    Independent asyncio worker — listens to MARKET_UPDATE and fires
    instant signals on fast price moves. Runs alongside SignalWorker.
    """

    def __init__(self) -> None:
        self._running = False
        self._stats = {"ticks": 0, "signals": 0, "suppressed": 0}

    async def run(self) -> None:
        if not cfg.tick_reactor_enabled:
            log.info("TickReactor: disabled")
            return
        self._running = True
        log.info(
            "TickReactor: starting  threshold=%.4f/s  horizon=%.1fs  kelly_scale=%.0f%%",
            cfg.tick_reactor_velocity_threshold,
            cfg.tick_reactor_forecast_horizon_s,
            cfg.tick_reactor_kelly_scale * 100,
        )
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while self._running:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                asyncio.create_task(self._handle_tick(event))
                self._stats["ticks"] += 1
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("TickReactor: loop error: %s", exc)

    async def _handle_tick(self, event: dict) -> None:
        market_id = event.get("market_id", "")
        price     = event.get("yes_price")
        if not market_id or price is None:
            return
        price = float(price)

        # Record tick for velocity computation (pure in-process, ~1μs)
        push_tick(market_id, price)

        # Velocity check — must exceed threshold to proceed
        vel = get_velocity(market_id)
        if vel is None or abs(vel.velocity) < cfg.tick_reactor_velocity_threshold:
            return

        # Debounce: prevent re-firing the same market too quickly
        now = time.monotonic()
        if now - _DEDUP.get(market_id, 0.0) < _MIN_REFIRE_S:
            return

        side = "YES" if vel.velocity > 0 else "NO"

        # Acceleration must not contradict direction (deceleration = impending reversal)
        accel_floor = -cfg.tick_reactor_velocity_threshold
        if side == "YES" and vel.accel < accel_floor:
            self._stats["suppressed"] += 1
            return
        if side == "NO" and vel.accel > -accel_floor:
            self._stats["suppressed"] += 1
            return

        # Forecast p_model from velocity × horizon (in-process, ~1μs)
        p_shift = abs(vel.velocity) * cfg.tick_reactor_forecast_horizon_s
        if side == "YES":
            p_model  = min(0.95, price + p_shift)
            p_market = price
        else:
            p_model  = max(0.05, price - p_shift)
            p_market = 1.0 - price

        raw_edge = abs(p_model - (price if side == "YES" else 1.0 - price))
        if raw_edge < cfg.tick_reactor_min_edge:
            self._stats["suppressed"] += 1
            return

        # OBI from in-process L2 book (~200μs)
        l2  = get_l2_book(market_id, price)
        obi = l2.obi() if l2._snapshot_confirmed else None

        # Signal age from event timestamp
        event_ts     = event.get("ts", time.time())
        signal_age_ms = max(0.0, (time.time() - float(event_ts)) * 1000)

        # Microstructure gate (all checks in-process, ~10μs)
        gate = microstructure_gate(
            market_id      = market_id,
            side           = side,
            edge           = raw_edge,
            p_win          = p_model,
            price          = price if side == "YES" else 1.0 - price,
            signal_age_ms  = signal_age_ms,
            obi            = obi,
            lambda_per_s   = lambda_for_category(event.get("category", "other")),
            obi_threshold  = cfg.obi_gate_threshold,
            vpin_threshold = cfg.vpin_adverse_threshold,
            ev_fee_rate    = cfg.ev_fee_rate,
        )
        if not gate.approved:
            self._stats["suppressed"] += 1
            return

        # Fetch market from Redis cache (TTL 300s — ~0.5ms on cache hit)
        market = await redis_state.get_market(market_id)
        if market is None:
            return

        signal = self._build_signal(market, side, p_model, p_market, gate.effective_edge, vel)

        _DEDUP[market_id] = now
        await redis_state.set_signal(signal)
        await bus.publish(Channel.SIGNAL_FAST, signal.model_dump())
        self._stats["signals"] += 1
        log.info(
            "TickReactor: %s %s  v=%.4f/s  edge=%.3f  age=%.0fms",
            side, market_id[:8], vel.velocity, gate.effective_edge, signal_age_ms,
        )

    @staticmethod
    def _build_signal(
        market: Market,
        side: str,
        p_model: float,
        p_market: float,
        edge: float,
        vel,
    ) -> Signal:
        direction = SignalDirection.BULLISH if side == "YES" else SignalDirection.BEARISH
        kelly = min(
            cfg.kelly_max * cfg.tick_reactor_kelly_scale,
            (edge / max(1e-6, p_model)) * cfg.kelly_base * cfg.tick_reactor_kelly_scale,
        )
        bankroll = cfg.initial_bankroll
        return Signal(
            market        = market,
            direction     = direction,
            p_model       = p_model,
            p_market      = p_market,
            edge          = edge,
            side          = side,
            approved_size = min(cfg.max_bet_usd, bankroll * kelly),
            kelly_fraction= kelly,
            reasoning     = f"tick_reactor:v={vel.velocity:.4f}/s span={vel.span_s:.1f}s",
        )

    def get_stats(self) -> dict:
        return dict(self._stats)


tick_reactor = TickReactor()
