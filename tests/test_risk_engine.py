"""
Unit tests for risk/risk_engine.py — all 6 checks.

Tests run against the in-memory state cache, patching Redis/DB calls.
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.models import OrderStatus, RiskRejectReason, Signal, SignalDirection
from risk import risk_engine


# ── Helpers ───────────────────────────────────────────────────────────────────

def _set_engine_state(
    bankroll: float = 1000.0,
    peak_bankroll: float = 1000.0,
    daily_loss: float = 0.0,
    open_position_count: int = 0,
    kill_active: bool = False,
    open_exposure: dict | None = None,
):
    """Directly set the module-level in-memory cache."""
    risk_engine._bankroll = bankroll
    risk_engine._peak_bankroll = peak_bankroll
    risk_engine._daily_loss = daily_loss
    risk_engine._open_position_count = open_position_count
    risk_engine._kill_active = kill_active
    risk_engine._open_exposure = open_exposure or {}
    risk_engine._last_refresh = time.time()  # mark cache as fresh


# ── Tests ──────────────────────────────────────────────────────────────────────

class TestRiskEngineKillSwitch:
    def test_kill_switch_rejects_all_orders(self, fake_signal: Signal):
        _set_engine_state(kill_active=True)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.KILL_SWITCH


class TestRiskEngineEdge:
    def test_insufficient_edge_rejected(self, fake_signal: Signal):
        _set_engine_state()
        # Set edge below threshold (cfg.edge_threshold default = 0.04)
        low_edge_signal = fake_signal.model_copy(update={"edge": 0.01})
        decision = risk_engine.approve_sync(low_edge_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.EDGE_TOO_SMALL

    def test_sufficient_edge_passes(self, fake_signal: Signal):
        _set_engine_state()
        # fake_signal has edge=0.10 > threshold=0.04
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is True


class TestRiskEngineDailyLoss:
    def test_daily_loss_limit_blocks_new_orders(self, fake_signal: Signal):
        # _daily_loss is signed net P&L (negative = loss). A $155 net loss on a
        # $1000 bankroll is 15.5% >= the 15% limit → must block.
        _set_engine_state(daily_loss=-155.0)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.DAILY_LOSS_LIMIT

    def test_partial_daily_loss_allows_orders(self, fake_signal: Signal):
        # $50 net loss = 5% < 15% limit → allowed
        _set_engine_state(daily_loss=-50.0)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is True


class TestRiskEngineDrawdown:
    def test_max_drawdown_blocks_orders(self, fake_signal: Signal):
        # 10% drawdown from peak, threshold is 8%
        _set_engine_state(bankroll=900.0, peak_bankroll=1000.0)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.MAX_DRAWDOWN

    def test_acceptable_drawdown_passes(self, fake_signal: Signal):
        # 5% drawdown < 8% threshold
        _set_engine_state(bankroll=950.0, peak_bankroll=1000.0)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is True


class TestRiskEngineConcentration:
    def test_max_concentration_reduces_size(self, fake_signal: Signal):
        # Already have $100 in this market out of $1000 bankroll = 10%
        # max_single_market_pct = 5% → $50 max
        # So existing exposure already exceeds limit
        _set_engine_state(
            open_exposure={fake_signal.market.condition_id: 55.0},
        )
        decision = risk_engine.approve_sync(fake_signal)
        # Should either be rejected or have reduced size
        if decision.approved:
            assert decision.approved_size < fake_signal.approved_size
        else:
            assert decision.reason == RiskRejectReason.MARKET_CONCENTRATION


class TestRiskEngineConcurrentPositions:
    def test_max_concurrent_blocks_new_position(self, fake_signal: Signal):
        # Default max_concurrent_positions = 15
        _set_engine_state(open_position_count=15)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.MAX_CONCURRENT

    def test_under_limit_allows_new_position(self, fake_signal: Signal):
        _set_engine_state(open_position_count=5)
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is True


class TestRiskEngineStaleness:
    def test_stale_signal_rejected(self, fake_signal: Signal):
        _set_engine_state()
        # Artificially age the signal by overriding created_at_ms
        stale_signal = fake_signal.model_copy(
            update={"created_at_ms": time.time() * 1000 - 10_000}  # 10s ago > 5s threshold
        )
        decision = risk_engine.approve_sync(stale_signal)
        assert decision.approved is False
        assert decision.reason == RiskRejectReason.STALE_SIGNAL

    def test_fresh_signal_passes(self, fake_signal: Signal):
        _set_engine_state()
        # fake_signal was just created → age_ms ≈ 0
        decision = risk_engine.approve_sync(fake_signal)
        assert decision.approved is True
