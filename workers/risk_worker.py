"""
SWARM WORKER 4 — Risk Worker

Responsibilities:
  - Continuous risk monitoring independent of execution path
  - Monitor daily P&L against loss limit every 30s
  - Monitor drawdown against peak bankroll every 30s
  - Monitor market concentration (single market > 20% of bankroll)
  - Trigger kill switch on any limit breach
  - Emit RISK_BREACH events for dashboard/alerting
  - Heartbeat to Redis every 10s

Kill switch triggers:
  - Daily loss >= DAILY_LOSS_LIMIT_USD
  - Drawdown >= MAX_DRAWDOWN_PCT from peak
  - Bankroll < MIN_BANKROLL_USD (absolute floor)

Communicates via:
  CONSUMES:   order.filled, order.submitted
  PUBLISHES:  risk.breach
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import RiskRejectReason
from persist import redis_state
from persist.db import get_daily_pnl, get_current_bankroll
from risk.kill_switch import activate as activate_kill_switch

log = logging.getLogger(__name__)

_CHECK_INTERVAL_S = 30.0
_CONCENTRATION_THRESHOLD = 0.20  # single market > 20% of bankroll triggers warning


class RiskWorker:
    def __init__(self) -> None:
        self._running = False
        self._last_breach: Optional[str] = None
        self._breach_count = 0
        self._stats = {
            "checks_run": 0,
            "breaches_detected": 0,
            "kill_switch_activations": 0,
            "warnings_issued": 0,
        }

    async def run(self) -> None:
        self._running = True
        log.info("RiskWorker: starting")

        await asyncio.gather(
            self._risk_monitor_loop(),
            self._concentration_monitor_loop(),
            self._heartbeat_loop(),
        )

    async def _risk_monitor_loop(self) -> None:
        """Core risk check: daily loss, drawdown, absolute floor."""
        while self._running:
            await asyncio.sleep(_CHECK_INTERVAL_S)
            try:
                await self._run_risk_checks()
                self._stats["checks_run"] += 1
            except Exception as exc:
                log.debug("RiskWorker: risk check error: %s", exc)

    async def _run_risk_checks(self) -> None:
        # Get current state from Redis (fast) and PostgreSQL (authoritative)
        daily_loss = await redis_state.get_daily_loss()
        bankroll = await redis_state.get_bankroll()
        peak_bankroll = await redis_state.get_peak_bankroll()

        if bankroll is None:
            # Fall back to PostgreSQL
            bankroll = await get_current_bankroll()

        if bankroll is None or bankroll <= 0:
            log.warning("RiskWorker: could not determine bankroll, skipping checks")
            return

        # Check 1: Daily loss limit
        # NOTE: redis_state.get_daily_loss() returns accumulated net P&L, not a loss magnitude.
        # Positive = net gain, negative = net loss. We only fire if we've *lost* money.
        # max(0, -daily_loss) converts: profit→0 (no trip), loss→positive (trips at limit).
        net_loss = max(0.0, -daily_loss) if daily_loss is not None else 0.0
        if net_loss >= cfg.daily_loss_limit_usd:
            await self._trigger_kill_switch(
                reason=RiskRejectReason.DAILY_LOSS,
                details=f"net_loss=${net_loss:.2f} >= limit=${cfg.daily_loss_limit_usd:.2f}",
            )
            return

        # Check 2: Drawdown from peak
        if peak_bankroll and peak_bankroll > 0:
            drawdown_pct = (peak_bankroll - bankroll) / peak_bankroll
            if drawdown_pct >= cfg.max_drawdown_pct:
                await self._trigger_kill_switch(
                    reason=RiskRejectReason.DRAWDOWN,
                    details=f"drawdown={drawdown_pct:.1%} >= limit={cfg.max_drawdown_pct:.1%}",
                )
                return

        # Check 3: Absolute floor (bankroll < $100 or < 10% of initial)
        min_bankroll = max(100.0, cfg.initial_bankroll * 0.10)
        if bankroll < min_bankroll:
            await self._trigger_kill_switch(
                reason=RiskRejectReason.DAILY_LOSS,  # reuse closest enum
                details=f"bankroll=${bankroll:.2f} below floor=${min_bankroll:.2f}",
            )
            return

        # Soft warning: approaching limits
        # net_loss is already computed above: max(0, -daily_loss)
        if net_loss > 0:
            loss_pct = net_loss / cfg.daily_loss_limit_usd
            if loss_pct >= 0.80:
                self._stats["warnings_issued"] += 1
                log.warning(
                    "RiskWorker: approaching daily loss limit (%.0f%% used: $%.2f/$%.2f)",
                    loss_pct * 100, net_loss, cfg.daily_loss_limit_usd,
                )
                await bus.publish(Channel.RISK_BREACH, {
                    "type": "warning",
                    "reason": "approaching_daily_loss_limit",
                    "loss_pct": round(loss_pct, 3),
                    "net_loss": round(net_loss, 2),
                    "daily_limit": cfg.daily_loss_limit_usd,
                    "ts": time.time(),
                })

    async def _concentration_monitor_loop(self) -> None:
        """Monitor single-market concentration every 60s."""
        while self._running:
            await asyncio.sleep(60.0)
            try:
                await self._check_concentration()
            except Exception as exc:
                log.debug("RiskWorker: concentration check error: %s", exc)

    async def _check_concentration(self) -> None:
        bankroll = await redis_state.get_bankroll()
        if not bankroll or bankroll <= 0:
            return

        positions = await redis_state.get_all_positions()
        if not positions:
            return

        for pos in positions:
            exposure = pos.size * pos.avg_price
            concentration = exposure / bankroll
            if concentration >= _CONCENTRATION_THRESHOLD:
                self._stats["warnings_issued"] += 1
                log.warning(
                    "RiskWorker: high concentration in %s: %.1f%% of bankroll ($%.2f)",
                    pos.market_id[:8], concentration * 100, exposure,
                )
                await bus.publish(Channel.RISK_BREACH, {
                    "type": "warning",
                    "reason": "concentration",
                    "market_id": pos.market_id,
                    "concentration_pct": round(concentration * 100, 1),
                    "exposure_usd": round(exposure, 2),
                    "ts": time.time(),
                })

    async def _trigger_kill_switch(self, reason: RiskRejectReason, details: str) -> None:
        if self._last_breach == details:
            # Already triggered for this exact breach — don't spam
            return

        self._last_breach = details
        self._stats["breaches_detected"] += 1
        self._stats["kill_switch_activations"] += 1

        log.critical("RiskWorker: KILL SWITCH — %s — %s", reason.value, details)

        await bus.publish(Channel.RISK_BREACH, {
            "type": "kill_switch",
            "reason": reason.value,
            "details": details,
            "ts": time.time(),
        })

        await activate_kill_switch(reason=details)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("risk")
            await asyncio.sleep(10)

    def get_stats(self) -> dict:
        return self._stats
