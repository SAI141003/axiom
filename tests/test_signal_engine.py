"""
Unit tests for signal layer — classifier output, ensemble logic, edge detection.
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, patch

import pytest

from core.models import ClassifierOutput, KronosOutput, Market, NewsEvent, Signal, SignalDirection


class TestClassifierOutput:
    """Validates that classifier output maps to correct directional signal."""

    def test_bullish_classification_structure(self, fake_classification: ClassifierOutput):
        assert fake_classification.direction == SignalDirection.BULLISH
        assert 0.0 <= fake_classification.materiality <= 1.0
        assert isinstance(fake_classification.reasoning, str)

    def test_neutral_classification_produces_no_edge(self, fake_market: Market, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        neutral = ClassifierOutput(
            direction=SignalDirection.NEUTRAL,
            materiality=0.9,
            reasoning="No directional information.",
        )
        # Neutral direction should not produce actionable signal
        signal = build_signal(
            market=fake_market,
            news=fake_news,
            classification=neutral,
            bankroll=1000.0,
        )
        assert signal is None


class TestEnsembleEdgeDetection:
    """Edge must exceed threshold (default 0.04) for signal to be emitted."""

    def test_high_materiality_bullish_produces_signal(
        self, fake_market: Market, fake_news: NewsEvent
    ):
        from signals.ensemble import build_signal
        high_mat = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.85,
            reasoning="Very strong bullish signal.",
        )
        # yes_price=0.55 — bullish push should raise p_model well above market
        signal = build_signal(
            market=fake_market,
            news=fake_news,
            classification=high_mat,
            bankroll=1000.0,
        )
        assert signal is not None
        assert signal.edge > 0.04
        assert signal.side == "YES"

    def test_low_materiality_suppressed(self, fake_market: Market, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        low_mat = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.1,  # below materiality_threshold (default 0.6)
            reasoning="Marginal mention of Bitcoin.",
        )
        signal = build_signal(
            market=fake_market,
            news=fake_news,
            classification=low_mat,
            bankroll=1000.0,
        )
        assert signal is None

    def test_adverse_selection_guard_blocks_overpriced(self, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        # Market already priced at 0.87 (above 0.85 adverse selection guard)
        expensive_market = Market(
            condition_id="0xABCD" * 8,
            question="Will X happen?",
            yes_price=0.87,
            no_price=0.13,
            volume=100_000.0,
            category="other",
        )
        strong_bull = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.9,
            reasoning="Very bullish.",
        )
        signal = build_signal(
            market=expensive_market,
            news=fake_news,
            classification=strong_bull,
            bankroll=1000.0,
        )
        # Should be blocked by adverse selection guard
        assert signal is None


class TestKronosEnsemble:
    """Kronos output modifies ensemble probability."""

    def test_kronos_agreeing_produces_valid_signal(self, fake_market: Market, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        classification = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.75,
            reasoning="Strong bullish signal.",
        )
        kronos = KronosOutput(
            asset="BTC",
            current_price=95_000.0,
            predicted_price=105_000.0,
            forecast_horizon_minutes=60,
            threshold_probability=0.72,
            confidence=0.80,
            direction=SignalDirection.BULLISH,
        )
        signal_with_kronos = build_signal(
            market=fake_market,
            news=fake_news,
            classification=classification,
            bankroll=1000.0,
            kronos=kronos,
        )
        # Kronos agreeing with Haiku should still produce a bullish signal with positive edge
        assert signal_with_kronos is not None
        assert signal_with_kronos.side == "YES"
        assert signal_with_kronos.edge > 0.04
        assert "Kronos" in signal_with_kronos.reasoning


class TestKellySizing:
    """Kelly fraction must be bounded and approved_size must be within limits."""

    def test_kelly_bounded_by_max(self, fake_market: Market, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        from core.config import cfg
        classification = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.9,
            reasoning="High confidence.",
        )
        signal = build_signal(
            market=fake_market,
            news=fake_news,
            classification=classification,
            bankroll=1000.0,
        )
        if signal:
            assert signal.kelly_fraction <= cfg.kelly_max
            assert signal.approved_size <= cfg.max_bet_usd

    def test_size_zero_bankroll_returns_none(self, fake_market: Market, fake_news: NewsEvent):
        from signals.ensemble import build_signal
        classification = ClassifierOutput(
            direction=SignalDirection.BULLISH,
            materiality=0.9,
            reasoning="Strong signal.",
        )
        signal = build_signal(
            market=fake_market,
            news=fake_news,
            classification=classification,
            bankroll=0.0,  # no bankroll
        )
        assert signal is None
