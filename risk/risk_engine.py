"""
Risk engine — all 7 checks evaluated synchronously from in-memory state
loaded from Redis. Zero I/O in the critical approval path.

Seven checks (all must pass):
  1. Edge threshold          signal.edge > cfg.edge_threshold
  2. Daily loss limit        abs(daily_loss) / bankroll < 0.15
  3. Max drawdown            (peak - current) / peak < cfg.max_drawdown_pct
  4. Market concentration    open_exposure[market_id] < bankroll * cfg.max_single_market_pct
  5. Concurrent positions    open_position_count < cfg.max_concurrent_positions
  6. Signal staleness        signal.age_ms < cfg.signal_stale_ms
  7. CVaR breach             mean(worst 5% trade outcomes) / bankroll < cfg.cvar_breach_pct
     (Inspired by Fincept Terminal's portfolio-level tail-risk monitoring)
     Only active once 20+ trades have been recorded in the rolling window.

Critical fix vs polymarket-pipeline:
  - Bankroll is loaded from PostgreSQL on startup, persisted on every fill
  - Never reads from config defaults in approval path (would reset on restart)
  - All risk state is atomically cached in Redis and refreshed every 5s
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Optional

from core.config import cfg
from core.models import RiskDecision, RiskRejectReason, Signal
from persist import db, redis_state

log = logging.getLogger(__name__)

# In-memory cache of risk state (refreshed every 5s)
_bankroll: float = cfg.initial_bankroll
_peak_bankroll: float = cfg.initial_bankroll
_daily_loss: float = 0.0
_open_position_count: int = 0
_open_exposure: dict[str, float] = {}  # market_id → exposure USD
_kill_active: bool = False
_last_refresh: float = 0.0
_REFRESH_INTERVAL_S = 5.0
_pnl_history: deque[float] = deque(maxlen=100)  # rolling window for CVaR (7th check)
_CVAR_MIN_TRADES = 50                           # need 50 trades for reliable 5% tail (5 samples)


async def initialize() -> None:
    """Load authoritative state from PostgreSQL + Redis on startup."""
    global _bankroll, _peak_bankroll, _daily_loss

    # Load bankroll from PostgreSQL (authoritative, never from config)
    _bankroll = await db.get_current_bankroll()
    log.info("RiskEngine: bankroll loaded from DB: $%.2f", _bankroll)

    # Load daily loss from Redis (resets when Redis restarts — acceptable,
    # PostgreSQL has the authoritative daily P&L if needed)
    _daily_loss = await redis_state.get_daily_loss()

    # Set peak bankroll
    _peak_bankroll = await redis_state.get_peak_bankroll()
    if _peak_bankroll < _bankroll:
        await redis_state.update_peak_bankroll(_bankroll)
        _peak_bankroll = _bankroll

    await _refresh()
    log.info("RiskEngine: initialized (bankroll=$%.2f, daily_loss=$%.2f)", _bankroll, _daily_loss)


async def _refresh() -> None:
    """Refresh in-memory risk state from Redis."""
    global _daily_loss, _open_position_count, _open_exposure, _kill_active, _last_refresh

    _daily_loss = await redis_state.get_daily_loss()
    _kill_active = await redis_state.is_kill_switch_active()
    _open_position_count = await redis_state.get_open_position_count()

    positions = await redis_state.get_all_positions()
    _open_exposure = {
        p.market_id: p.size * p.avg_price
        for p in positions
    }

    _last_refresh = time.time()


async def _ensure_fresh() -> None:
    """Refresh if state is older than REFRESH_INTERVAL_S."""
    if (time.time() - _last_refresh) > _REFRESH_INTERVAL_S:
        await _refresh()


def approve_sync(signal: Signal) -> RiskDecision:
    """
    Synchronous risk check using cached in-memory state.
    This is the hot path — zero I/O, called from execution worker.

    Must call ensure_fresh() before this in the async context.
    """
    global _bankroll

    # Kill switch
    if _kill_active:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.KILL_SWITCH,
            message="Kill switch is active",
        )

    # 1. Edge threshold
    if signal.edge < cfg.edge_threshold:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.EDGE_TOO_SMALL,
            message=f"edge={signal.edge:.4f} < threshold={cfg.edge_threshold}",
        )

    # 2. Daily loss limit (_daily_loss accumulates P&L: negative = net loss)
    daily_loss_pct = max(0.0, -_daily_loss) / max(_bankroll, 1.0)
    if daily_loss_pct >= 0.15:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.DAILY_LOSS_LIMIT,
            message=f"daily_loss_pct={daily_loss_pct:.1%} >= 15%",
        )

    # 3. Max drawdown
    drawdown = (_peak_bankroll - _bankroll) / max(_peak_bankroll, 1.0)
    if drawdown >= cfg.max_drawdown_pct:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.MAX_DRAWDOWN,
            message=f"drawdown={drawdown:.1%} >= {cfg.max_drawdown_pct:.1%}",
        )

    # 4. Market concentration
    current_exposure = _open_exposure.get(signal.market.condition_id, 0.0)
    max_exposure = _bankroll * cfg.max_single_market_pct
    if current_exposure + signal.approved_size > max_exposure:
        adjusted_size = max(0.0, max_exposure - current_exposure)
        if adjusted_size < 1.0:
            return RiskDecision(
                approved=False,
                reason=RiskRejectReason.MARKET_CONCENTRATION,
                message=f"exposure=${current_exposure:.0f} + ${signal.approved_size:.0f} > max=${max_exposure:.0f}",
            )
        # Reduce size to fit within limit
        signal = signal.model_copy(update={"approved_size": adjusted_size})

    # 5. Concurrent positions
    if _open_position_count >= cfg.max_concurrent_positions:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.MAX_CONCURRENT,
            message=f"open_positions={_open_position_count} >= max={cfg.max_concurrent_positions}",
        )

    # 6. Signal staleness
    if signal.age_ms > cfg.signal_stale_ms:
        return RiskDecision(
            approved=False,
            reason=RiskRejectReason.STALE_SIGNAL,
            message=f"signal.age_ms={signal.age_ms:.0f} > {cfg.signal_stale_ms}ms",
        )

    # 7. CVaR tail-risk check (active once we have enough trade history)
    if len(_pnl_history) >= _CVAR_MIN_TRADES:
        sorted_pnl = sorted(_pnl_history)
        tail_n     = max(2, len(sorted_pnl) // 20)   # worst 5% (≥2 samples)
        cvar       = sum(sorted_pnl[:tail_n]) / tail_n
        cvar_pct   = abs(cvar) / max(_bankroll, 1.0)
        if cvar_pct > cfg.cvar_breach_pct:
            return RiskDecision(
                approved=False,
                reason=RiskRejectReason.VaR_BREACH,
                message=(
                    f"CVaR_5pct={cvar:.2f} ({cvar_pct:.1%} of bankroll) "
                    f"> limit={cfg.cvar_breach_pct:.1%}"
                ),
            )

    return RiskDecision(
        approved=True,
        approved_size=signal.approved_size,
        kelly_fraction=signal.kelly_fraction,
        message="all checks passed",
    )


async def approve(signal: Signal) -> RiskDecision:
    """Async wrapper — refreshes state then runs synchronous checks."""
    await _ensure_fresh()
    return approve_sync(signal)


async def on_trade_submitted(market_id: str, size: float, price: float) -> None:
    """Update exposure tracking when an order is submitted."""
    global _open_position_count, _open_exposure
    exposure = size * price
    _open_exposure[market_id] = _open_exposure.get(market_id, 0.0) + exposure
    _open_position_count = await redis_state.get_open_position_count()


async def on_trade_filled(market_id: str, fill_price: float, size: float, pnl: float = 0.0) -> None:
    """Update bankroll and loss tracking when a trade fills."""
    global _bankroll, _daily_loss

    # Record P&L
    if pnl != 0.0:
        _daily_loss += pnl
        _bankroll   += pnl
        _pnl_history.append(pnl)   # feed CVaR rolling window
        await redis_state.add_daily_loss(pnl)
        await redis_state.set_bankroll(_bankroll)
        await redis_state.update_peak_bankroll(_bankroll)
        await db.save_bankroll(_bankroll, note=f"fill market={market_id}")


async def on_trade_cancelled(market_id: str, size: float, price: float) -> None:
    """Release exposure when an order is cancelled."""
    global _open_exposure
    exposure = size * price
    current = _open_exposure.get(market_id, 0.0)
    _open_exposure[market_id] = max(0.0, current - exposure)


def get_current_bankroll() -> float:
    return _bankroll


def get_daily_loss() -> float:
    return _daily_loss
