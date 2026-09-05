"""
Event bus — Redis pub/sub for inter-worker messaging.
asyncio.Queue for intra-process fast path.

Channel naming convention:
  news.raw          — raw NewsEvent from ingest workers
  news.matched      — (NewsEvent, [Market]) pairs
  signal.fast       — Claude Haiku signals
  signal.medium     — Kronos + ensemble signals
  signal.consensus  — AI-Trader confirmed signals
  order.submitted   — order submitted to exchange
  order.filled      — fill confirmed
  order.cancelled   — order cancelled
  risk.breach       — risk engine rejections
  market.update     — live orderbook deltas from WebSocket
  system.kill       — kill switch trigger
  system.heartbeat  — worker health pings
"""
from __future__ import annotations

import asyncio
import json
import logging
from enum import Enum
from typing import Any, Callable, Coroutine

import redis.asyncio as aioredis

from core.config import cfg

log = logging.getLogger(__name__)


class Channel(str, Enum):
    NEWS_RAW = "news.raw"
    NEWS_MATCHED = "news.matched"
    SIGNAL_FAST = "signal.fast"
    SIGNAL_MEDIUM = "signal.medium"
    SIGNAL_CONSENSUS = "signal.consensus"
    ORDER_SUBMITTED = "order.submitted"
    ORDER_FILLED = "order.filled"
    ORDER_CANCELLED = "order.cancelled"
    RISK_BREACH = "risk.breach"
    MARKET_UPDATE = "market.update"
    SYSTEM_KILL = "system.kill"
    SYSTEM_HEARTBEAT = "system.heartbeat"
    ARB_OPPORTUNITY = "arb.opportunity"


class EventBus:
    """
    Thread-safe async event bus.
    Intra-process: asyncio.Queue (zero-copy, sub-ms).
    Inter-process: Redis pub/sub (~1ms, serialized JSON).
    """

    def __init__(self) -> None:
        self._redis: aioredis.Redis | None = None
        self._local_queues: dict[str, list[asyncio.Queue]] = {}
        self._handlers: dict[str, list[Callable]] = {}

    async def connect(self) -> None:
        self._redis = await aioredis.from_url(
            cfg.redis_url,
            encoding="utf-8",
            decode_responses=True,
            socket_connect_timeout=5,
            socket_keepalive=True,
        )
        log.info("EventBus: Redis connected")

    async def disconnect(self) -> None:
        if self._redis:
            await self._redis.aclose()

    # ── Local (intra-process) ─────────────────────────────────────────────────

    def subscribe_local(self, channel: Channel) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._local_queues.setdefault(channel.value, []).append(q)
        return q

    async def publish_local(self, channel: Channel, payload: Any) -> None:
        for q in self._local_queues.get(channel.value, []):
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                log.warning("EventBus: local queue full on %s, dropping event", channel.value)

    # ── Redis (inter-process) ─────────────────────────────────────────────────

    async def publish(self, channel: Channel, payload: Any) -> None:
        """Publish to both local queues and Redis."""
        await self.publish_local(channel, payload)
        if self._redis:
            try:
                serialized = json.dumps(payload) if not isinstance(payload, str) else payload
                await self._redis.publish(channel.value, serialized)
            except Exception as exc:
                log.warning("EventBus: Redis publish failed on %s: %s", channel.value, exc)

    async def subscribe_redis(
        self,
        channel: Channel,
        callback: Callable[[Any], Coroutine],
    ) -> None:
        """Subscribe to a Redis channel and invoke callback for each message."""
        if not self._redis:
            log.warning("EventBus: Redis not connected, cannot subscribe to %s", channel.value)
            return

        pubsub = self._redis.pubsub()
        await pubsub.subscribe(channel.value)
        log.info("EventBus: Redis subscribed to %s", channel.value)

        async for message in pubsub.listen():
            if message["type"] != "message":
                continue
            try:
                data = json.loads(message["data"])
                await callback(data)
            except json.JSONDecodeError:
                await callback(message["data"])
            except Exception as exc:
                log.error("EventBus: callback error on %s: %s", channel.value, exc)

    # ── Convenience helpers ───────────────────────────────────────────────────

    async def wait_for_kill(self) -> None:
        """Block until system.kill is published."""
        if not self._redis:
            return
        pubsub = self._redis.pubsub()
        await pubsub.subscribe(Channel.SYSTEM_KILL.value)
        async for message in pubsub.listen():
            if message["type"] == "message":
                log.critical("EventBus: KILL signal received — %s", message["data"])
                return


# Module-level singleton — created at import, connected in main.py
bus = EventBus()
