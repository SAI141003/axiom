"""
Unit tests for execute/executor.py — order submission, dedup, staleness.
"""
from __future__ import annotations

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

import pytest

from core.models import Order, OrderStatus, RiskDecision, RiskRejectReason, Signal


class TestExecutionDedup:
    """Deduplication prevents same market+side within 60s."""

    @pytest.mark.asyncio
    async def test_dedup_skips_duplicate_signal(self, fake_signal: Signal, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        worker = ExecutionWorker()

        # Prime the dedup record with a recent entry
        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD[dedup_key] = time.time()  # just now

        # Mock the engine to ensure it's never called
        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock()

        await worker._handle_signal(fake_signal.model_dump(), "fast")

        # Engine should not have been called (dedup blocked it)
        worker._engine.submit.assert_not_called()
        assert worker._stats["orders_deduped"] == 1

    @pytest.mark.asyncio
    async def test_dedup_allows_signal_after_window(self, fake_signal: Signal, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        worker = ExecutionWorker()

        # Set last signal 61s ago (outside 60s window)
        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD[dedup_key] = time.time() - 61.0

        mock_result = MagicMock()
        mock_result.status = OrderStatus.DRY_RUN

        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock(return_value=mock_result)

        with patch("workers.execution_worker.bus") as mock_bus:
            mock_bus.publish = AsyncMock()
            await worker._handle_signal(fake_signal.model_dump(), "fast")

        worker._engine.submit.assert_called_once()
        assert worker._stats["orders_deduped"] == 0


class TestExecutionOrderStatus:
    """Order status handling: SUBMITTED, DRY_RUN, REJECTED, ERROR."""

    @pytest.mark.asyncio
    async def test_submitted_order_publishes_event(self, fake_signal: Signal, fake_order: Order, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        # Clear dedup so signal is not blocked
        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD.pop(dedup_key, None)

        # Return a recent signal (clear created_at_ms to now)
        fresh_signal = fake_signal.model_copy(update={"created_at_ms": time.time() * 1000})

        mock_result = MagicMock()
        mock_result.status = OrderStatus.SUBMITTED
        mock_result.order = fake_order

        worker = ExecutionWorker()
        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock(return_value=mock_result)

        with patch("workers.execution_worker.bus") as mock_bus:
            mock_bus.publish = AsyncMock()
            await worker._handle_signal(fresh_signal.model_dump(), "consensus")

        mock_bus.publish.assert_called_once()
        call_args = mock_bus.publish.call_args
        assert call_args[0][1]["order_id"] == fake_order.order_id
        assert worker._stats["orders_submitted"] == 1

    @pytest.mark.asyncio
    async def test_dry_run_order_logs_not_publishes(self, fake_signal: Signal, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD.pop(dedup_key, None)

        fresh_signal = fake_signal.model_copy(update={"created_at_ms": time.time() * 1000})

        mock_result = MagicMock()
        mock_result.status = OrderStatus.DRY_RUN

        worker = ExecutionWorker()
        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock(return_value=mock_result)

        with patch("workers.execution_worker.bus") as mock_bus:
            mock_bus.publish = AsyncMock()
            await worker._handle_signal(fresh_signal.model_dump(), "fast")

        mock_bus.publish.assert_not_called()
        assert worker._stats["orders_dry_run"] == 1

    @pytest.mark.asyncio
    async def test_rejected_order_increments_stat(self, fake_signal: Signal, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD.pop(dedup_key, None)

        fresh_signal = fake_signal.model_copy(update={"created_at_ms": time.time() * 1000})

        mock_result = MagicMock()
        mock_result.status = OrderStatus.REJECTED

        worker = ExecutionWorker()
        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock(return_value=mock_result)

        with patch("workers.execution_worker.bus") as mock_bus:
            mock_bus.publish = AsyncMock()
            await worker._handle_signal(fresh_signal.model_dump(), "fast")

        assert worker._stats["orders_rejected"] == 1


class TestExecutionStaleness:
    """Executor should reject stale signals at submission time."""

    @pytest.mark.asyncio
    async def test_stale_signal_results_in_stale_status(self, fake_signal: Signal, mock_redis):
        from workers.execution_worker import ExecutionWorker, _DEDUP_RECORD

        dedup_key = f"{fake_signal.market.condition_id}:{fake_signal.side}"
        _DEDUP_RECORD.pop(dedup_key, None)

        # Age the signal by 10s (> 5s threshold)
        stale_signal = fake_signal.model_copy(
            update={"created_at_ms": time.time() * 1000 - 10_000}
        )

        mock_result = MagicMock()
        mock_result.status = OrderStatus.STALE

        worker = ExecutionWorker()
        worker._engine = AsyncMock()
        worker._engine.submit = AsyncMock(return_value=mock_result)

        with patch("workers.execution_worker.bus") as mock_bus:
            mock_bus.publish = AsyncMock()
            await worker._handle_signal(stale_signal.model_dump(), "fast")

        assert worker._stats["orders_rejected"] == 1
