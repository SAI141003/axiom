"""
SWARM WORKER 3 — Execution Worker

Responsibilities:
  - Consume signals from signals.fast and signal.consensus channels
  - Run final risk check immediately before submission
  - Submit orders via ExecutionEngine singleton
  - Open positions on fills (via order_tracker events)
  - Enforce order deduplication (same market+side+direction within 60s = skip)
  - Heartbeat to Redis every 10s

Deduplication logic:
  - Maintain a dict: market_id+side → last_signal_ts
  - If < 60s since last signal for same market+side: skip (prevents stacking)

Communicates via:
  CONSUMES:   signal.fast, signal.consensus, order.filled
  PUBLISHES:  order.submitted, order.cancelled
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import OrderStatus, Signal
from execute.executor import ExecutionEngine
from persist import redis_state
from portfolio.positions import open_position

log = logging.getLogger(__name__)

_DEDUP_WINDOW_S = 60.0  # suppress duplicate signals within this window
_DEDUP_RECORD: dict[str, float] = {}  # "market_id:side" → last_submitted_ts


class ExecutionWorker:
    def __init__(self) -> None:
        self._running = False
        self._engine: Optional[ExecutionEngine] = None
        self._stats = {
            "signals_received": 0,
            "orders_submitted": 0,
            "orders_dry_run": 0,
            "orders_rejected": 0,
            "orders_deduped": 0,
        }

    async def run(self) -> None:
        self._running = True
        log.info("ExecutionWorker: starting")

        # Create singleton executor (derives CLOB creds once)
        self._engine = await ExecutionEngine.create()

        # Startup reconciliation: compare DB open orders vs CLOB
        await self._engine.reconcile_on_startup()

        # Subscribe to signal + arb opportunity channels
        q_fast = bus.subscribe_local(Channel.SIGNAL_FAST)
        q_consensus = bus.subscribe_local(Channel.SIGNAL_CONSENSUS)
        q_filled = bus.subscribe_local(Channel.ORDER_FILLED)
        q_arb = bus.subscribe_local(Channel.ARB_OPPORTUNITY)

        await asyncio.gather(
            self._consume_signals(q_fast, "fast"),
            self._consume_signals(q_consensus, "consensus"),
            self._consume_fills(q_filled),
            self._consume_arb_opportunities(q_arb),
            self._heartbeat_loop(),
        )

    async def _consume_signals(self, q: asyncio.Queue, channel_name: str) -> None:
        while self._running:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=5.0)
                self._stats["signals_received"] += 1
                # Process independently so one slow submission doesn't block the queue
                asyncio.create_task(self._handle_signal(raw, channel_name))
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("ExecutionWorker: consume error: %s", exc)

    async def _handle_signal(self, raw: dict, source: str) -> None:
        try:
            signal = Signal.model_validate(raw)
        except Exception as exc:
            log.debug("ExecutionWorker: signal parse error: %s", exc)
            return

        # Deduplication check
        dedup_key = f"{signal.market.condition_id}:{signal.side}"
        last_ts = _DEDUP_RECORD.get(dedup_key, 0.0)
        if (time.time() - last_ts) < _DEDUP_WINDOW_S:
            self._stats["orders_deduped"] += 1
            log.debug("ExecutionWorker: dedup skip %s:%s", signal.market.condition_id[:8], signal.side)
            return

        _DEDUP_RECORD[dedup_key] = time.time()

        # Submit
        result = await self._engine.submit(signal)

        if result.status == OrderStatus.SUBMITTED:
            self._stats["orders_submitted"] += 1
            await bus.publish(Channel.ORDER_SUBMITTED, {
                "order_id": result.order.order_id,
                "market_id": result.order.market_id,
                "side": result.order.side,
                "size": result.order.size,
                "price": result.order.price,
                "source": source,
                "ts": time.time(),
            })

        elif result.status == OrderStatus.DRY_RUN:
            self._stats["orders_dry_run"] += 1
            log.info(
                "DRY RUN: %s %s $%.2f (edge=%.3f, source=%s)",
                signal.side, signal.market.question[:40],
                signal.approved_size, signal.edge, source,
            )

        elif result.status in (OrderStatus.REJECTED, OrderStatus.STALE, OrderStatus.PRICE_MOVED):
            self._stats["orders_rejected"] += 1

        elif result.status == OrderStatus.ERROR:
            self._stats["orders_rejected"] += 1
            log.warning("ExecutionWorker: order error: %s", result.order.error_msg)

    async def _consume_arb_opportunities(self, q: asyncio.Queue) -> None:
        """Convert ARB_OPPORTUNITY events (crypto binary, oracle lag, etc.) to Signal and execute."""
        while self._running:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=5.0)
                strategy = raw.get("strategy", "")
                # Only single-leg directional strategies — complement needs two legs (not supported yet)
                if strategy not in ("crypto_binary", "oracle_lag", "resolution_proximity",
                                    "threshold_cascade", "deribit_iv_arb", "mean_reversion",
                                    "longshot_no", "smart_money"):
                    continue
                asyncio.create_task(self._handle_arb(raw))
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("ExecutionWorker: arb consume error: %s", exc)

    async def _handle_arb(self, opp: dict) -> None:
        from core.models import Signal, SignalDirection
        from risk import risk_engine as _re

        market_id = opp.get("market_a_id", "")
        if not market_id:
            return

        market = await redis_state.get_market(market_id)
        if market is None:
            return

        side       = opp.get("market_a_side", "YES")
        edge       = float(opp.get("edge", 0.0))
        model_prob = float(opp.get("model_prob", 0.5)) or float(opp.get("confidence", 0.5))
        confidence = float(opp.get("confidence", 0.5))
        p_market   = float(opp.get("market_a_price",
                                   market.yes_price if side == "YES" else market.no_price))

        if edge < cfg.edge_threshold:
            return

        direction = SignalDirection.BULLISH if side == "YES" else SignalDirection.BEARISH

        bankroll = getattr(_re, "_bankroll", cfg.initial_bankroll)
        q_upper  = opp.get("market_a_question", "")
        is_btc   = "BTC" in (opp.get("reason", "") + q_upper).upper()
        max_bet  = cfg.btc_max_bet_usd if is_btc else cfg.max_bet_usd

        # Prefer CVXPY-optimized size (QuantCalibrationWorker refreshes every 30s)
        from signals.portfolio_optimizer import get_cached_size as _get_opt_size
        cached = _get_opt_size(market_id)
        if cached >= 1.0:
            size  = round(min(cached, max_bet), 2)
            kelly = size / max(1.0, bankroll)
        else:
            # Fallback: conservative naive Kelly (0.5× — no LLM confirmation)
            kelly = min(cfg.kelly_max, edge / max(0.01, 1.0 - p_market) * cfg.kelly_base * 0.5)
            size  = round(min(bankroll * kelly, max_bet), 2)
        if size < 1.0:
            return

        signal = Signal(
            market=market,
            direction=direction,
            p_model=model_prob,
            p_market=p_market,
            edge=edge,
            materiality=confidence,
            approved_size=size,
            kelly_fraction=kelly,
            side=side,
            reasoning=f"arb[{opp.get('strategy','?')}]: {opp.get('reason', '')[:120]}",
        )

        # Publish to SIGNAL_FAST so paper_worker tracks this arb trade.
        # Execution worker's own _consume_signals will dedup it (key set below).
        await bus.publish(Channel.SIGNAL_FAST, signal.model_dump())
        await self._handle_signal(signal.model_dump(), f"arb_{opp.get('strategy','?')}")

    async def _consume_fills(self, q: asyncio.Queue) -> None:
        """Open position records when orders are confirmed filled."""
        while self._running:
            try:
                fill = await asyncio.wait_for(q.get(), timeout=5.0)
                order_id = fill.get("order_id")
                if not order_id:
                    continue

                order = await redis_state.get_order(order_id)
                if order and order.status == OrderStatus.FILLED:
                    # We need the market question — look it up from Redis
                    market = await redis_state.get_market(order.market_id)
                    question = market.question if market else order.market_id
                    await open_position(order, question)

            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("ExecutionWorker: fill handler error: %s", exc)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("execution")
            await asyncio.sleep(10)

    def get_stats(self) -> dict:
        return self._stats
