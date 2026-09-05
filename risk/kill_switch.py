"""
Kill switch — emergency shutdown mechanism.

Triggers on:
  1. STOP file created in project root
  2. SIGTERM signal
  3. Redis system.kill channel message
  4. Drawdown breach (called from risk engine)
  5. Manual activation via activate()

On activation:
  1. Set Redis kill flag
  2. Cancel all open orders via executor
  3. Persist final bankroll
  4. Emit system.kill event
  5. Log and exit
"""
from __future__ import annotations

import asyncio
import logging
import os
import signal
import sys
import time

from core.config import cfg
from core.events import Channel, bus
from persist import redis_state

log = logging.getLogger(__name__)

_ACTIVATED = False
_ACTIVATION_REASON = ""


async def activate(reason: str, cancel_orders: bool = True) -> None:
    """Activate kill switch. Idempotent."""
    global _ACTIVATED, _ACTIVATION_REASON
    if _ACTIVATED:
        return

    _ACTIVATED = True
    _ACTIVATION_REASON = reason
    log.critical("KILL SWITCH: %s", reason)

    # Set Redis flag (prevents new orders in risk engine)
    await redis_state.activate_kill_switch(reason)

    # Publish to event bus (notifies all workers)
    await bus.publish(Channel.SYSTEM_KILL, {"reason": reason, "ts": time.time()})

    if cancel_orders:
        await _cancel_all_open_orders()

    # Persist final state
    try:
        from persist import db
        from risk.risk_engine import get_current_bankroll
        bankroll = get_current_bankroll()
        await db.save_bankroll(bankroll, note=f"kill_switch: {reason}")
    except Exception as exc:
        log.error("Kill switch: failed to save bankroll: %s", exc)


async def _cancel_all_open_orders() -> None:
    """Cancel all known open orders via executor."""
    try:
        from execute.executor import ExecutionEngine
        engine = ExecutionEngine.get_instance()
        if engine:
            open_ids = await redis_state.get_open_order_ids()
            log.info("Kill switch: cancelling %d open orders", len(open_ids))
            tasks = [engine.cancel_order(oid) for oid in open_ids]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            cancelled = sum(1 for r in results if not isinstance(r, Exception))
            log.info("Kill switch: cancelled %d/%d orders", cancelled, len(open_ids))
    except Exception as exc:
        log.error("Kill switch: cancel orders error: %s", exc)


class KillSwitchMonitor:
    """
    Background monitor — checks STOP file and SIGTERM every second.
    Must be started as an asyncio task.
    """

    def __init__(self) -> None:
        self._stop_file = os.path.join(os.getcwd(), "STOP")

    def install_signal_handlers(self) -> None:
        """Install SIGTERM/SIGINT handlers."""
        loop = asyncio.get_running_loop()

        def _handle_signal(sig_name: str):
            log.warning("Received %s — activating kill switch", sig_name)
            asyncio.create_task(activate(f"signal:{sig_name}"))

        loop.add_signal_handler(signal.SIGTERM, lambda: _handle_signal("SIGTERM"))
        loop.add_signal_handler(signal.SIGINT, lambda: _handle_signal("SIGINT"))

    async def run(self) -> None:
        """Poll for STOP file and Redis kill signal."""
        self.install_signal_handlers()

        # Subscribe to Redis kill channel
        asyncio.create_task(self._watch_redis())

        while True:
            await asyncio.sleep(1.0)

            if _ACTIVATED:
                # Wait for graceful shutdown
                await asyncio.sleep(5)
                log.info("Kill switch: exiting process")
                sys.exit(0)

            # Check STOP file
            if os.path.exists(self._stop_file):
                await activate(f"STOP file at {self._stop_file}")

    async def _watch_redis(self) -> None:
        """Watch Redis for kill signal from another process."""
        try:
            await bus.wait_for_kill()
            if not _ACTIVATED:
                await activate("redis:system.kill", cancel_orders=False)
        except Exception as exc:
            log.debug("KillSwitch Redis watch error: %s", exc)
