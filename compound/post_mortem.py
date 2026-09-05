"""
Compound Layer — Post-Mortem Failure Classifier

Classifies why a trade lost money into one of 4 categories:
  1. BAD_PREDICTION  — model edge was wrong (p_model was far from outcome)
  2. BAD_TIMING      — signal was right but entered/exited at wrong price
  3. BAD_EXECUTION   — price slippage, partial fill, or stale order
  4. EXTERNAL_SHOCK  — unpredictable event (market resolved unexpectedly)

Used to improve signal quality over time via feedback loop:
  - BAD_PREDICTION → recalibrate classifier weights
  - BAD_TIMING     → adjust signal staleness threshold
  - BAD_EXECUTION  → tighten price tolerance in executor
  - EXTERNAL_SHOCK → no model fix available, mark as noise
"""
from __future__ import annotations

import asyncio
import logging
import time
from enum import Enum
from typing import Optional

from core.models import Order, OrderStatus
from persist.db import get_brier_score

log = logging.getLogger(__name__)


class FailureClass(str, Enum):
    BAD_PREDICTION = "bad_prediction"
    BAD_TIMING = "bad_timing"
    BAD_EXECUTION = "bad_execution"
    EXTERNAL_SHOCK = "external_shock"
    WIN = "win"


def classify_trade(
    p_model: float,
    p_market_at_entry: float,
    fill_price: float,
    resolved_price: float,
    signal_age_ms: float,
    pnl: float,
) -> FailureClass:
    """
    Classify a resolved trade's outcome.

    Args:
        p_model: our model's probability estimate at signal time
        p_market_at_entry: market's implied probability at entry
        fill_price: actual fill price (may differ from signal price)
        resolved_price: 1.0 (YES) or 0.0 (NO) at resolution
        signal_age_ms: milliseconds between signal creation and order submission
        pnl: realized P&L from this trade
    """
    if pnl >= 0:
        return FailureClass.WIN

    # Slippage: fill was significantly worse than market price at entry
    slippage = abs(fill_price - p_market_at_entry)
    if slippage > 0.03:
        return FailureClass.BAD_EXECUTION

    # Stale signal: more than 5 seconds between signal and submission
    if signal_age_ms > 5000:
        return FailureClass.BAD_TIMING

    # Model was directionally wrong: predicted wrong side
    model_was_bullish = p_model > p_market_at_entry
    outcome_was_yes = resolved_price > 0.5

    if model_was_bullish != outcome_was_yes:
        # Check magnitude: if model was very confident but wrong, bad prediction
        model_confidence = abs(p_model - p_market_at_entry)
        if model_confidence > 0.10:
            return FailureClass.BAD_PREDICTION
        else:
            # Low confidence, unexpected resolution = external shock
            return FailureClass.EXTERNAL_SHOCK

    # Model was directionally correct but still lost — timing
    return FailureClass.BAD_TIMING


class PostMortemAnalyzer:
    def __init__(self) -> None:
        self._running = False
        self._failure_counts: dict[FailureClass, int] = {fc: 0 for fc in FailureClass}
        self._recent_failures: list[dict] = []
        self._max_recent = 100

    async def analyze_trade(
        self,
        trade_id: str,
        p_model: float,
        p_market_at_entry: float,
        fill_price: float,
        resolved_price: float,
        signal_age_ms: float,
        pnl: float,
    ) -> FailureClass:
        failure = classify_trade(
            p_model=p_model,
            p_market_at_entry=p_market_at_entry,
            fill_price=fill_price,
            resolved_price=resolved_price,
            signal_age_ms=signal_age_ms,
            pnl=pnl,
        )

        self._failure_counts[failure] += 1

        record = {
            "trade_id": trade_id,
            "failure_class": failure.value,
            "p_model": round(p_model, 4),
            "p_market": round(p_market_at_entry, 4),
            "fill_price": round(fill_price, 4),
            "resolved_price": resolved_price,
            "pnl": round(pnl, 4),
            "signal_age_ms": round(signal_age_ms, 0),
            "ts": time.time(),
        }
        self._recent_failures.append(record)
        if len(self._recent_failures) > self._max_recent:
            self._recent_failures.pop(0)

        if failure != FailureClass.WIN:
            log.info(
                "PostMortem: %s → %s (pnl=%.3f, p_model=%.3f, p_market=%.3f)",
                trade_id[:8], failure.value, pnl, p_model, p_market_at_entry,
            )

        return failure

    def get_summary(self) -> dict:
        total = sum(self._failure_counts.values())
        return {
            "total_resolved": total,
            "win_rate": round(self._failure_counts[FailureClass.WIN] / max(total, 1), 3),
            "failure_breakdown": {
                fc.value: self._failure_counts[fc]
                for fc in FailureClass
                if fc != FailureClass.WIN
            },
            "recent": self._recent_failures[-10:],
        }


# Module-level singleton
post_mortem = PostMortemAnalyzer()
