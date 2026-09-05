"""
Order tracker — WebSocket-driven order state machine.

Subscribes to Polymarket user WebSocket channel for fill/cancel events.
Updates order state in Redis and notifies risk engine on fills.

State transitions:
  PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED
                      ↓
                   CANCELLED
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime, timezone

import websockets

from core.config import cfg
from core.events import Channel, bus
from core.models import Order, OrderStatus
from persist import db, redis_state
from risk import risk_engine

log = logging.getLogger(__name__)


class OrderTracker:
    """
    Connects to Polymarket user WebSocket and tracks fill/cancel events.
    Maintains idempotency via a seen-set to prevent duplicate processing.
    """

    def __init__(self) -> None:
        self._seen_events: set[str] = set()
        self._max_seen = 10_000

    async def run(self) -> None:
        """Long-running WS subscription loop with reconnect."""
        if not cfg.polymarket_api_key:
            log.info("OrderTracker: no API creds — fill tracking disabled")
            return

        backoff = [1, 2, 4, 8, 16, 30]
        attempt = 0

        while True:
            try:
                await self._connect_and_track()
                attempt = 0
            except Exception as exc:
                delay = backoff[min(attempt, len(backoff) - 1)]
                log.warning("OrderTracker: WS error (%s), retry in %ds", exc, delay)
                await asyncio.sleep(delay)
                attempt += 1

    async def _connect_and_track(self) -> None:
        async with websockets.connect(
            cfg.polymarket_ws_host,
            ping_interval=20,
            ping_timeout=15,
        ) as ws:
            # Subscribe to user channel for order events
            await ws.send(json.dumps({
                "type": "subscribe",
                "channel": "user",
                "auth": {
                    "apiKey": cfg.polymarket_api_key,
                    "secret": cfg.polymarket_api_secret,
                    "passphrase": cfg.polymarket_api_passphrase,
                },
            }))
            log.info("OrderTracker: WS user channel subscribed")

            async for raw in ws:
                try:
                    msgs = json.loads(raw)
                    if not isinstance(msgs, list):
                        msgs = [msgs]
                    for msg in msgs:
                        await self._handle_event(msg)
                except Exception as exc:
                    log.debug("OrderTracker: parse error: %s", exc)

    async def _handle_event(self, event: dict) -> None:
        event_type = event.get("event_type", event.get("type", ""))
        order_id = event.get("orderID", event.get("id", ""))

        # Idempotency: skip duplicate events
        event_key = f"{event_type}:{order_id}:{event.get('timestamp', '')}"
        if event_key in self._seen_events:
            return
        self._seen_events.add(event_key)
        if len(self._seen_events) > self._max_seen:
            self._seen_events = set(list(self._seen_events)[-5000:])

        if event_type == "order":
            await self._handle_order_event(event, order_id)
        elif event_type in ("trade", "fill"):
            await self._handle_fill_event(event, order_id)

    async def _handle_order_event(self, event: dict, order_id: str) -> None:
        """Handle order status update (filled, cancelled, etc.)."""
        status_str = event.get("status", event.get("outcome", "")).lower()
        status_map = {
            "matched": OrderStatus.FILLED,
            "mev": OrderStatus.FILLED,
            "live": OrderStatus.SUBMITTED,
            "cancelled": OrderStatus.CANCELLED,
            "partially matched": OrderStatus.PARTIALLY_FILLED,
        }
        new_status = status_map.get(status_str)
        if not new_status:
            return

        order = await redis_state.get_order(order_id)
        if order is None:
            return

        order = order.model_copy(update={"status": new_status})

        if new_status == OrderStatus.FILLED:
            fill_price = float(event.get("price", order.price))
            filled_size = float(event.get("size", event.get("originalSize", order.size)))
            order = order.model_copy(update={
                "fill_price": fill_price,
                "filled_size": filled_size,
                "filled_at": datetime.now(timezone.utc),
            })

            # Update PostgreSQL
            await db.update_trade_fill(order_id, fill_price, filled_size)

            # Update risk engine
            pnl_est = filled_size * (fill_price - order.price)
            await risk_engine.on_trade_filled(order.market_id, fill_price, filled_size, pnl_est)

            # Emit fill event
            await bus.publish(Channel.ORDER_FILLED, {
                "order_id": order_id,
                "market_id": order.market_id,
                "fill_price": fill_price,
                "filled_size": filled_size,
                "ts": time.time(),
            })
            log.info("FILLED: order=%s market=%s @ %.3f", order_id[:8], order.market_id[:8], fill_price)

        elif new_status == OrderStatus.CANCELLED:
            await db.update_trade_status(order_id, "cancelled")
            await risk_engine.on_trade_cancelled(order.market_id, order.size, order.price)
            await bus.publish(Channel.ORDER_CANCELLED, {"order_id": order_id, "ts": time.time()})

        await redis_state.set_order(order)

    async def _handle_fill_event(self, event: dict, order_id: str) -> None:
        """Handle explicit fill/trade event (alternative event format)."""
        fill_price = float(event.get("price", 0))
        filled_size = float(event.get("size", event.get("amount", 0)))
        if not fill_price or not filled_size:
            return

        order = await redis_state.get_order(order_id)
        if order is None:
            return

        order = order.model_copy(update={
            "status": OrderStatus.FILLED,
            "fill_price": fill_price,
            "filled_size": filled_size,
            "filled_at": datetime.now(timezone.utc),
        })
        await redis_state.set_order(order)
        await db.update_trade_fill(order_id, fill_price, filled_size)

        pnl_est = filled_size * (fill_price - order.price)
        await risk_engine.on_trade_filled(order.market_id, fill_price, filled_size, pnl_est)

        await bus.publish(Channel.ORDER_FILLED, {
            "order_id": order_id,
            "market_id": order.market_id,
            "fill_price": fill_price,
            "filled_size": filled_size,
            "ts": time.time(),
        })
