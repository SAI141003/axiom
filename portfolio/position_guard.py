"""
POSITION GUARD — Real-time adverse velocity exit.

Supplements check_for_exit() (signal-reversal based) with a pure
price-velocity exit that fires on every MARKET_UPDATE tick.

Exit condition (all required):
  1. Adverse velocity: position side is being priced against at > guard_adverse_velocity
  2. Position age >= guard_min_age_s (avoid whipsawing fresh entries)
  3. Unrealized loss > 1% of position size (skip noise-level moves)
  4. Cooldown: same market not re-triggered within _EXIT_COOLDOWN_S

Publishes ORDER_CANCELLED — ExecutionWorker and OrderTracker handle the close.
"""
from __future__ import annotations

import asyncio
import logging
import time

from core.config import cfg
from core.events import Channel, bus
from persist import redis_state
from signals.velocity import get_velocity

log = logging.getLogger(__name__)

_LAST_EXIT: dict[str, float] = {}   # market_id → last exit monotonic timestamp
_EXIT_COOLDOWN_S = 30.0


class PositionGuard:
    """
    Independent asyncio worker — listens to MARKET_UPDATE and triggers
    rapid exits when an open position faces adverse velocity.
    """

    def __init__(self) -> None:
        self._running = False
        self._stats = {"checks": 0, "exits_triggered": 0}

    async def run(self) -> None:
        if not cfg.position_guard_enabled:
            log.info("PositionGuard: disabled")
            return
        self._running = True
        log.info(
            "PositionGuard: starting  adverse_velocity=%.4f/s  min_age=%.0fs",
            cfg.position_guard_adverse_velocity,
            cfg.position_guard_min_age_s,
        )
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while self._running:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                market_id = event.get("market_id", "")
                price     = event.get("yes_price")
                if market_id and price is not None:
                    asyncio.create_task(self._check_position(market_id, float(price)))
                    self._stats["checks"] += 1
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("PositionGuard: loop error: %s", exc)

    async def _check_position(self, market_id: str, current_price: float) -> None:
        pos = await redis_state.get_position(market_id)
        if pos is None:
            return

        # Don't touch freshly opened positions — avoid whipsaw
        age_s = time.time() - pos.opened_at.timestamp()
        if age_s < cfg.position_guard_min_age_s:
            return

        # Cooldown: don't hammer exit on the same market
        now = time.monotonic()
        if now - _LAST_EXIT.get(market_id, 0.0) < _EXIT_COOLDOWN_S:
            return

        vel = get_velocity(market_id)
        if vel is None:
            return

        adverse_yes = pos.side == "YES" and vel.velocity < -cfg.position_guard_adverse_velocity
        adverse_no  = pos.side == "NO"  and vel.velocity >  cfg.position_guard_adverse_velocity
        if not (adverse_yes or adverse_no):
            return

        # Require meaningful loss — skip noise-level adverse moves
        unrealized = pos.size * (current_price - pos.avg_price)
        if pos.side == "NO":
            unrealized = -unrealized
        if unrealized > -0.01 * pos.size:
            return

        reason = (
            f"velocity_exit: v={vel.velocity:.4f}/s side={pos.side} "
            f"unrealized=${unrealized:.2f}"
        )
        _LAST_EXIT[market_id] = now
        self._stats["exits_triggered"] += 1
        log.info("PositionGuard: EXIT %s — %s", market_id[:8], reason)
        await bus.publish(Channel.ORDER_CANCELLED, {
            "market_id": market_id,
            "reason":    reason,
            "ts":        time.time(),
        })

    def get_stats(self) -> dict:
        return dict(self._stats)


position_guard = PositionGuard()
