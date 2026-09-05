"""
pytest fixtures — shared test infrastructure.
"""
from __future__ import annotations

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from core.models import (
    ClassifierOutput,
    Market,
    NewsEvent,
    Order,
    OrderStatus,
    Position,
    Signal,
    SignalDirection,
)


@pytest.fixture
def fake_market() -> Market:
    return Market(
        condition_id="0xABCD1234" * 4,
        question="Will Bitcoin exceed $100,000 by end of 2025?",
        yes_price=0.55,
        no_price=0.45,
        volume=250_000.0,
        active=True,
        category="crypto",
        linked_asset="BTC",
        tokens=[
            {"token_id": "yes_token_001", "outcome": "YES"},
            {"token_id": "no_token_001", "outcome": "NO"},
        ],
    )


@pytest.fixture
def fake_news() -> NewsEvent:
    return NewsEvent(
        headline="Bitcoin surges past $95,000 as institutional demand accelerates",
        source="reuters",
        published_at=time.time() - 1.0,
        received_at=time.time(),
        content="Bitcoin reached a new high today amid strong institutional buying.",
    )


@pytest.fixture
def fake_classification() -> ClassifierOutput:
    return ClassifierOutput(
        direction=SignalDirection.BULLISH,
        materiality=0.8,
        reasoning="Strong institutional demand directly relevant to BTC price target.",
    )


@pytest.fixture
def fake_signal(fake_market: Market, fake_news: NewsEvent) -> Signal:
    return Signal(
        market=fake_market,
        news=fake_news,
        direction=SignalDirection.BULLISH,
        p_model=0.65,
        p_market=0.55,
        edge=0.10,
        approved_size=20.0,
        kelly_fraction=0.25,
        side="YES",
        consensus_count=0,
    )


@pytest.fixture
def fake_order(fake_signal: Signal) -> Order:
    return Order(
        signal_id=fake_signal.id,
        market_id=fake_signal.market.condition_id,
        token_id="yes_token_001",
        side="YES",
        size=20.0,
        price=0.55,
        status=OrderStatus.FILLED,
        filled_size=20.0,
        fill_price=0.553,
        order_id="test-order-001",
    )


@pytest.fixture
def fake_position(fake_order: Order) -> Position:
    return Position(
        market_id=fake_order.market_id,
        market_question="Will Bitcoin exceed $100,000 by end of 2025?",
        token_id=fake_order.token_id,
        side=fake_order.side,
        size=fake_order.filled_size or 20.0,
        avg_price=fake_order.fill_price or 0.553,
        current_price=fake_order.fill_price or 0.553,
    )


@pytest.fixture
def mock_redis():
    """Patch all redis_state functions with AsyncMocks."""
    from contextlib import ExitStack
    patches = [
        patch("persist.redis_state.get_bankroll", new_callable=AsyncMock, return_value=1000.0),
        patch("persist.redis_state.set_bankroll", new_callable=AsyncMock),
        patch("persist.redis_state.get_daily_loss", new_callable=AsyncMock, return_value=0.0),
        patch("persist.redis_state.add_daily_loss", new_callable=AsyncMock, return_value=0.0),
        patch("persist.redis_state.get_peak_bankroll", new_callable=AsyncMock, return_value=1000.0),
        patch("persist.redis_state.update_peak_bankroll", new_callable=AsyncMock),
        patch("persist.redis_state.is_kill_switch_active", new_callable=AsyncMock, return_value=False),
        patch("persist.redis_state.set_position", new_callable=AsyncMock),
        patch("persist.redis_state.get_position", new_callable=AsyncMock, return_value=None),
        patch("persist.redis_state.get_all_positions", new_callable=AsyncMock, return_value=[]),
        patch("persist.redis_state.get_open_position_count", new_callable=AsyncMock, return_value=0),
        patch("persist.redis_state.get_market_exposure", new_callable=AsyncMock, return_value=0.0),
        patch("persist.redis_state.get_orderbook", new_callable=AsyncMock, return_value=None),
        patch("persist.redis_state.set_worker_heartbeat", new_callable=AsyncMock),
        patch("persist.redis_state.set_signal", new_callable=AsyncMock),
    ]
    with ExitStack() as stack:
        mocks = [stack.enter_context(p) for p in patches]
        yield mocks


@pytest.fixture
def mock_clob():
    mock = MagicMock()
    mock.post_order.return_value = {
        "orderID": "live-order-123",
        "status": "matched",
        "size": "20.0",
        "price": "0.550",
    }
    mock.cancel_order = MagicMock(return_value={"success": True})
    mock.get_orders = MagicMock(return_value=[])
    return mock
