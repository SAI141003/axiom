"""
Redis state manager — all volatile in-flight state.

Key schema:
  orderbook:{condition_id}    → JSON Orderbook
  order:{order_id}            → JSON Order
  position:{market_id}        → JSON Position
  risk:state                  → JSON risk metrics
  bankroll                    → float (authoritative copy from PostgreSQL)
  signal:{signal_id}          → JSON Signal (TTL: 60s)
  news:dedup                  → Set of recent headline hashes
  market:{condition_id}       → JSON Market (TTL: 300s)
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Optional

import redis.asyncio as aioredis

from core.config import cfg
from core.models import Market, Order, Orderbook, Position, Signal

log = logging.getLogger(__name__)

_REDIS: aioredis.Redis | None = None


async def connect() -> None:
    global _REDIS
    _REDIS = await aioredis.from_url(
        cfg.redis_url,
        encoding="utf-8",
        decode_responses=True,
        socket_connect_timeout=5,
        socket_keepalive=True,
    )
    log.info("Redis: connected at %s", cfg.redis_url)


async def disconnect() -> None:
    if _REDIS:
        await _REDIS.aclose()


def _r() -> aioredis.Redis:
    if _REDIS is None:
        raise RuntimeError("Redis not connected — call persist.redis_state.connect() first")
    return _REDIS


# ── Orderbook ─────────────────────────────────────────────────────────────────

async def set_orderbook(ob: Orderbook, ttl_s: int = 10) -> None:
    await _r().setex(f"orderbook:{ob.market_id}", ttl_s, ob.model_dump_json())


async def get_orderbook(market_id: str) -> Optional[Orderbook]:
    raw = await _r().get(f"orderbook:{market_id}")
    if raw is None:
        return None
    return Orderbook.model_validate_json(raw)


async def get_best_ask(market_id: str) -> Optional[float]:
    ob = await get_orderbook(market_id)
    if ob is None or ob.is_stale:
        return None
    return ob.best_ask


# ── Orders ────────────────────────────────────────────────────────────────────

async def set_order(order: Order, ttl_s: int = 86400) -> None:
    if order.order_id:
        await _r().setex(f"order:{order.order_id}", ttl_s, order.model_dump_json())
    # Also track by internal id
    await _r().setex(f"order:internal:{order.id}", ttl_s, order.model_dump_json())


async def get_order(order_id: str) -> Optional[Order]:
    raw = await _r().get(f"order:{order_id}")
    if raw is None:
        return None
    return Order.model_validate_json(raw)


async def get_open_order_ids() -> list[str]:
    keys = await _r().keys("order:*")
    open_ids = []
    for k in keys:
        if k.startswith("order:internal:"):
            continue
        raw = await _r().get(k)
        if raw:
            try:
                order = Order.model_validate_json(raw)
                if order.status in ("pending", "submitted", "partially_filled"):
                    open_ids.append(order.order_id or order.id)
            except Exception:
                pass
    return open_ids


# ── Positions ─────────────────────────────────────────────────────────────────

async def set_position(pos: Position) -> None:
    await _r().set(f"position:{pos.market_id}", pos.model_dump_json())


async def get_position(market_id: str) -> Optional[Position]:
    raw = await _r().get(f"position:{market_id}")
    if raw is None:
        return None
    return Position.model_validate_json(raw)


async def get_all_positions() -> list[Position]:
    keys = await _r().keys("position:*")
    positions = []
    for k in keys:
        raw = await _r().get(k)
        if raw:
            try:
                positions.append(Position.model_validate_json(raw))
            except Exception:
                pass
    return positions


async def delete_position(market_id: str) -> None:
    await _r().delete(f"position:{market_id}")


async def get_open_position_count() -> int:
    keys = await _r().keys("position:*")
    return len(keys)


async def get_market_exposure(market_id: str) -> float:
    pos = await get_position(market_id)
    if pos is None:
        return 0.0
    return pos.size * pos.avg_price


# ── Risk State ────────────────────────────────────────────────────────────────

async def get_daily_loss() -> float:
    val = await _r().get("risk:daily_loss")
    return float(val) if val else 0.0


async def add_daily_loss(amount: float) -> float:
    """Atomic increment — returns new total. `amount` is SIGNED P&L (negative
    for a loss); the risk engine tracks NET daily P&L, so profits offset losses.
    A misuse passing a positive loss magnitude would silently disable the limit."""
    result = await _r().incrbyfloat("risk:daily_loss", amount)
    # Set TTL to end of day (86400s max, resets each day via db load)
    await _r().expire("risk:daily_loss", 86400)
    return float(result)


async def get_bankroll() -> float:
    val = await _r().get("bankroll")
    return float(val) if val else cfg.initial_bankroll


async def set_bankroll(amount: float) -> None:
    await _r().set("bankroll", str(amount))


async def get_peak_bankroll() -> float:
    val = await _r().get("risk:peak_bankroll")
    return float(val) if val else cfg.initial_bankroll


async def update_peak_bankroll(current: float) -> None:
    peak = await get_peak_bankroll()
    if current > peak:
        await _r().set("risk:peak_bankroll", str(current))


# ── Kill Switch ───────────────────────────────────────────────────────────────

async def is_kill_switch_active() -> bool:
    val = await _r().get("system:kill")
    return val is not None


async def activate_kill_switch(reason: str) -> None:
    await _r().set("system:kill", reason)
    await _r().publish("system.kill", reason)
    log.critical("KILL SWITCH ACTIVATED: %s", reason)


# ── News Deduplication ────────────────────────────────────────────────────────

def _headline_hash(headline: str) -> str:
    return hashlib.md5(headline.lower()[:80].encode()).hexdigest()


async def is_duplicate_news(headline: str) -> bool:
    h = _headline_hash(headline)
    exists = await _r().sismember("news:dedup", h)
    return bool(exists)


async def mark_news_seen(headline: str) -> None:
    h = _headline_hash(headline)
    pipe = _r().pipeline()
    pipe.sadd("news:dedup", h)
    # Keep set bounded — use a sorted set with timestamp for TTL-like behavior
    pipe.expire("news:dedup", 3600 * 6)
    await pipe.execute()


# ── Market Cache ──────────────────────────────────────────────────────────────

async def set_market(market: Market, ttl_s: int = 300) -> None:
    await _r().setex(f"market:{market.condition_id}", ttl_s, market.model_dump_json())


async def get_market(condition_id: str) -> Optional[Market]:
    raw = await _r().get(f"market:{condition_id}")
    if raw is None:
        return None
    return Market.model_validate_json(raw)


async def get_all_markets() -> list[Market]:
    keys = await _r().keys("market:*")
    markets = []
    for k in keys:
        raw = await _r().get(k)
        if raw:
            try:
                markets.append(Market.model_validate_json(raw))
            except Exception:
                pass
    return markets


# ── Signal Cache ──────────────────────────────────────────────────────────────

async def set_signal(signal: Signal, ttl_s: int = 60) -> None:
    await _r().setex(f"signal:{signal.id}", ttl_s, signal.model_dump_json())


async def get_signal(signal_id: str) -> Optional[Signal]:
    raw = await _r().get(f"signal:{signal_id}")
    if raw is None:
        return None
    return Signal.model_validate_json(raw)


# ── Health Heartbeat ──────────────────────────────────────────────────────────

async def set_worker_heartbeat(worker_name: str) -> None:
    await _r().setex(f"health:{worker_name}", 60, str(time.time()))


async def get_worker_health() -> dict[str, float]:
    keys = await _r().keys("health:*")
    health = {}
    for k in keys:
        name = k.replace("health:", "")
        val = await _r().get(k)
        health[name] = float(val) if val else 0.0
    return health


# ── Lightweight signal-level cache helpers ────────────────────────────────────
# Shared by crypto_binary_signal, onchain_signal, and kalshi_arb.
# Each caller creates a short-lived connection; this avoids circular imports
# when both callers need the same Redis primitives.

async def cache_get(key: str) -> Optional[str]:
    """
    Get a cached string value.
    Uses the shared _REDIS pool when connected (<0.1ms).
    Falls back to an ephemeral connection during startup or after disconnect.
    """
    if _REDIS is not None:
        try:
            return await _REDIS.get(key)
        except Exception:
            return None
    # Pre-connect fallback (startup race or unit tests)
    try:
        r = aioredis.from_url(cfg.redis_url, decode_responses=True)
        val = await r.get(key)
        await r.aclose()
        return val
    except Exception:
        return None


async def cache_set(key: str, value: str, ttl: int) -> None:
    """
    Set a cached string value with an expiry.
    Uses the shared _REDIS pool when connected (<0.1ms).
    Falls back to an ephemeral connection during startup or after disconnect.
    """
    if _REDIS is not None:
        try:
            await _REDIS.set(key, value, ex=ttl)
            return
        except Exception:
            return
    try:
        r = aioredis.from_url(cfg.redis_url, decode_responses=True)
        await r.set(key, value, ex=ttl)
        await r.aclose()
    except Exception:
        pass
