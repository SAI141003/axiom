"""
Portfolio — position tracking, P&L calculation, and exit management.

Positions are stored in Redis (volatile, for fast lookup during risk checks)
and reconstructed from PostgreSQL trade history on startup.

A position represents a currently open bet:
  - opened when an order fills
  - updated on partial fills
  - closed when market resolves, position is sold, or signal reverses

Signal reversal exit: when a new ensemble signal for the same market flips
direction (e.g., we hold YES but new p_model < exit_reversal_threshold),
the position is flagged for exit. The exit worker calls check_for_exit().
"""
from __future__ import annotations

import logging
from typing import Optional

from core.models import Order, Position
from persist import redis_state

log = logging.getLogger(__name__)


async def open_position(order: Order, market_question: str) -> Position:
    """Create a new position from a filled order."""
    pos = Position(
        market_id=order.market_id,
        market_question=market_question,
        token_id=order.token_id,
        side=order.side,
        size=order.filled_size or order.size,
        avg_price=order.fill_price or order.price,
        current_price=order.fill_price or order.price,
        signal_id=order.signal_id,
    )
    await redis_state.set_position(pos)
    log.debug("Position opened: %s %.2f @ %.3f", order.market_id[:8], pos.size, pos.avg_price)
    return pos


async def update_position_price(market_id: str, current_price: float) -> None:
    """Update unrealized P&L when market price moves."""
    pos = await redis_state.get_position(market_id)
    if pos is None:
        return
    pos = pos.model_copy(update={
        "current_price": current_price,
        "unrealized_pnl": pos.size * (current_price - pos.avg_price),
    })
    await redis_state.set_position(pos)


async def close_position(market_id: str, exit_price: float) -> Optional[float]:
    """Close a position and return realized P&L."""
    pos = await redis_state.get_position(market_id)
    if pos is None:
        return None
    pnl = pos.size * (exit_price - pos.avg_price)
    await redis_state.delete_position(market_id)
    log.info("Position closed: %s pnl=%.2f", market_id[:8], pnl)
    return pnl


async def resolve_position(market_id: str, resolved_yes: bool) -> float:
    """
    Handle market resolution (binary: YES resolves to $1, NO to $0).
    Returns realized P&L.
    """
    pos = await redis_state.get_position(market_id)
    if pos is None:
        return 0.0

    # Binary payout: YES token = $1 if resolved YES, $0 otherwise
    resolution_price = 1.0 if resolved_yes else 0.0
    pnl = pos.size * (resolution_price - pos.avg_price)

    await redis_state.delete_position(market_id)
    log.info(
        "Position resolved: %s resolved_yes=%s pnl=%.2f",
        market_id[:8], resolved_yes, pnl
    )
    return pnl


async def check_for_exit(
    market_id:   str,
    new_p_model: float,
    current_market_price: float,
    category:    str = "other",
) -> Optional[str]:
    """
    Evaluate whether an open position should be exited based on signal reversal.

    Exit triggers (any one sufficient):
      1. Signal reversal: position is YES but new p_model < reversal_threshold
         (model now believes probability is low — conviction flipped)
      2. Profit lock: unrealized P&L > lock_profit_threshold × entry price
         (take profit before it reverses)
      3. Stop loss: unrealized loss > stop_loss_threshold × entry price

    Returns a string reason if exit is warranted, None otherwise.
    The caller is responsible for actually submitting the exit order.
    """
    from core.config import cfg
    try:
        pos = await redis_state.get_position(market_id)
    except RuntimeError:
        return None   # Redis not connected (tests / startup race)
    if pos is None:
        return None

    # Per-category reversal thresholds (how far model must flip before we exit)
    _REVERSAL_THRESHOLD = {
        "crypto":   0.40,   # crypto: exit YES if p_model < 0.40
        "sports":   0.38,
        "politics": 0.35,
        "other":    0.38,
    }
    _PROFIT_LOCK_MULT   = 1.5   # exit if unrealized P&L > 150% of entry cost
    _STOP_LOSS_MULT     = 0.35  # exit if unrealized loss > 35% of entry cost

    reversal_thresh = _REVERSAL_THRESHOLD.get(category, 0.38)
    entry_cost      = pos.avg_price * pos.size

    # Update current price first
    updated = pos.model_copy(update={
        "current_price": current_market_price,
        "unrealized_pnl": pos.size * (current_market_price - pos.avg_price),
    })
    await redis_state.set_position(updated)

    unrealized = updated.unrealized_pnl

    # 1. Signal reversal
    if pos.side == "YES" and new_p_model < reversal_thresh:
        return (
            f"signal_reversal: p_model={new_p_model:.3f} < threshold={reversal_thresh} "
            f"(was YES @ {pos.avg_price:.3f})"
        )
    if pos.side == "NO" and new_p_model > (1.0 - reversal_thresh):
        return (
            f"signal_reversal: p_model={new_p_model:.3f} > {1-reversal_thresh:.3f} "
            f"(was NO @ {pos.avg_price:.3f})"
        )

    # 2. Profit lock
    if entry_cost > 0 and unrealized > _PROFIT_LOCK_MULT * entry_cost:
        return f"profit_lock: unrealized={unrealized:.2f} > {_PROFIT_LOCK_MULT}x cost={entry_cost:.2f}"

    # 3. Stop loss
    if entry_cost > 0 and unrealized < -_STOP_LOSS_MULT * entry_cost:
        return f"stop_loss: unrealized={unrealized:.2f} < -{_STOP_LOSS_MULT}x cost={entry_cost:.2f}"

    return None


async def get_portfolio_summary() -> dict:
    """Return portfolio snapshot for dashboard."""
    positions = await redis_state.get_all_positions()
    total_exposure = sum(p.size * p.avg_price for p in positions)
    total_unrealized = sum(p.unrealized_pnl for p in positions)

    return {
        "open_positions": len(positions),
        "total_exposure_usd": round(total_exposure, 2),
        "total_unrealized_pnl": round(total_unrealized, 2),
        "positions": [
            {
                "market": p.market_question[:50],
                "side": p.side,
                "size": round(p.size, 2),
                "avg_price": round(p.avg_price, 3),
                "current_price": round(p.current_price, 3),
                "unrealized_pnl": round(p.unrealized_pnl, 2),
            }
            for p in positions
        ],
    }
