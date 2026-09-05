"""
WebSocket Bridge — Redis pub/sub → Browser WebSocket

Runs as a standalone process alongside main.py.
Listens on port 8765. Subscribes to all Redis channels and forwards
events to every connected browser client.

Also accepts messages from the browser:
  - ping → pong (latency measurement)
  - kill_switch → publishes to Redis system.kill
  - manual_order → publishes to signal.manual for ExecutionWorker
  - subscribe → acknowledges channel subscription

Usage:
  python ws_bridge.py

Env:
  REDIS_URL         (default: redis://localhost:6379/0)
  WS_BRIDGE_PORT    (default: 8765)
  WS_BRIDGE_HOST    (default: 0.0.0.0)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Set

import websockets
from websockets.server import WebSocketServerProtocol
import redis.asyncio as aioredis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s ws_bridge: %(message)s")
log = logging.getLogger("ws_bridge")

REDIS_URL   = os.getenv("REDIS_URL",      "redis://localhost:6379/0")
BRIDGE_HOST = os.getenv("WS_BRIDGE_HOST", "0.0.0.0")
BRIDGE_PORT = int(os.getenv("WS_BRIDGE_PORT", "8765"))

# Redis channels to forward to all browser clients
FORWARD_CHANNELS = [
    "market.update",
    "signal.fast",
    "signal.consensus",
    "order.submitted",
    "order.filled",
    "order.cancelled",
    "risk.breach",
    "system.heartbeat",
    "system.kill",
    "arb.opportunity",
]

_clients: Set[WebSocketServerProtocol] = set()


async def broadcast(message: str) -> None:
    if not _clients:
        return
    # Fire-and-forget to all connected browsers
    await asyncio.gather(
        *[client.send(message) for client in _clients],
        return_exceptions=True,
    )


async def redis_forwarder(redis: aioredis.Redis) -> None:
    """Subscribe to Redis and forward all events to browser clients."""
    pubsub = redis.pubsub()
    await pubsub.subscribe(*FORWARD_CHANNELS)
    log.info("Subscribed to %d Redis channels", len(FORWARD_CHANNELS))

    async for msg in pubsub.listen():
        if msg["type"] != "message":
            continue
        try:
            data = msg["data"]
            if isinstance(data, bytes):
                data = data.decode()

            raw = json.loads(data)
            channel = msg["channel"]
            if isinstance(channel, bytes):
                channel = channel.decode()

            # Map channel → WS message type
            type_map = {
                "market.update":     "market_update",
                "signal.fast":       "signal",
                "signal.consensus":  "signal",
                "order.submitted":   "order_submitted",
                "order.filled":      "order_filled",
                "order.cancelled":   "order_cancelled",
                "risk.breach":       "risk_update",
                "system.heartbeat":  "heartbeat",
                "system.kill":       "kill_switch",
                "arb.opportunity":   "arb_opportunity",
            }
            ws_type = type_map.get(channel, channel)
            raw["type"] = ws_type
            raw["_channel"] = channel

            await broadcast(json.dumps(raw))

        except Exception as exc:
            log.debug("Forward error: %s", exc)


async def stats_pusher(redis: aioredis.Redis) -> None:
    """Push portfolio stats to all clients every 5s."""
    while True:
        await asyncio.sleep(5)
        try:
            bankroll_raw    = await redis.get("bankroll")
            daily_loss_raw  = await redis.get("risk:daily_loss")
            peak_raw        = await redis.get("risk:peak_bankroll")

            bankroll   = float(bankroll_raw)   if bankroll_raw   else 0.0
            daily_loss = float(daily_loss_raw) if daily_loss_raw else 0.0
            peak       = float(peak_raw)       if peak_raw       else bankroll

            # Collect positions
            pos_keys = await redis.keys("position:*")
            positions = []
            for key in pos_keys:
                raw = await redis.get(key)
                if raw:
                    try:
                        positions.append(json.loads(raw))
                    except Exception:
                        pass

            total_exposure = sum(
                p.get("size", 0) * p.get("avg_price", 0) for p in positions
            )

            msg = {
                "type": "risk_update",
                "bankroll": bankroll,
                "peak_bankroll": peak,
                "daily_loss": daily_loss,
                "daily_loss_limit": 150.0,
                "drawdown_pct": (peak - bankroll) / max(peak, 1),
                "max_drawdown_pct": 0.08,
                "open_positions": len(positions),
                "total_exposure": total_exposure,
                "kill_switch_active": bool(await redis.get("system:kill")),
            }
            await broadcast(json.dumps(msg))

            # Push position list too
            pos_msg = {
                "type": "positions_update",
                "positions": positions,
            }
            await broadcast(json.dumps(pos_msg))

        except Exception as exc:
            log.debug("Stats pusher error: %s", exc)


async def heartbeat_pusher(redis: aioredis.Redis) -> None:
    """Push worker health every 10s."""
    while True:
        await asyncio.sleep(10)
        try:
            workers = {}
            for w in ["ingestion", "signal", "execution", "risk"]:
                ts_raw = await redis.get(f"health:{w}")
                workers[w] = float(ts_raw) * 1000 if ts_raw else 0
            await broadcast(json.dumps({"type": "heartbeat", "workers": workers}))
        except Exception as exc:
            log.debug("Heartbeat pusher error: %s", exc)


async def handle_browser_message(ws: WebSocketServerProtocol, raw: str, redis: aioredis.Redis) -> None:
    try:
        msg = json.loads(raw)
    except Exception:
        return

    msg_type = msg.get("type")

    if msg_type == "ping":
        await ws.send(json.dumps({"type": "pong", "ts": time.time()}))

    elif msg_type == "kill_switch":
        reason = msg.get("reason", "manual_dashboard")
        await redis.set("system:kill", reason)
        await redis.publish("system.kill", json.dumps({"reason": reason, "source": "dashboard"}))
        log.warning("Kill switch activated from dashboard: %s", reason)

    elif msg_type == "manual_order":
        await redis.publish("signal.manual", json.dumps({**msg, "source": "dashboard"}))
        log.info("Manual order from dashboard: %s %s $%.2f", msg.get("side"), msg.get("market_id", "")[:8], msg.get("size", 0))

    elif msg_type == "subscribe":
        # Acknowledgement only — subscription is automatic
        await ws.send(json.dumps({"type": "subscribed", "channels": FORWARD_CHANNELS}))


async def client_handler(ws: WebSocketServerProtocol, redis: aioredis.Redis) -> None:
    _clients.add(ws)
    remote = ws.remote_address
    log.info("Client connected: %s (total: %d)", remote, len(_clients))

    try:
        # Send initial state
        await send_initial_state(ws, redis)

        async for raw in ws:
            await handle_browser_message(ws, str(raw), redis)

    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as exc:
        log.debug("Client error %s: %s", remote, exc)
    finally:
        _clients.discard(ws)
        log.info("Client disconnected: %s (total: %d)", remote, len(_clients))


async def send_initial_state(ws: WebSocketServerProtocol, redis: aioredis.Redis) -> None:
    """Send current snapshot to a newly connected browser client."""
    try:
        # Markets
        market_keys = await redis.keys("market:*")
        markets = []
        for k in market_keys[:50]:
            raw = await redis.get(k)
            if raw:
                try:
                    markets.append(json.loads(raw))
                except Exception:
                    pass
        if markets:
            await ws.send(json.dumps({"type": "markets_snapshot", "markets": markets}))

        # Positions
        pos_keys = await redis.keys("position:*")
        positions = []
        for k in pos_keys:
            raw = await redis.get(k)
            if raw:
                try:
                    positions.append(json.loads(raw))
                except Exception:
                    pass
        await ws.send(json.dumps({"type": "positions_update", "positions": positions}))

    except Exception as exc:
        log.debug("Initial state error: %s", exc)


async def main() -> None:
    log.info("WebSocket bridge starting on %s:%d", BRIDGE_HOST, BRIDGE_PORT)
    log.info("Connecting to Redis: %s", REDIS_URL)

    redis = aioredis.from_url(REDIS_URL, decode_responses=False)
    await redis.ping()
    log.info("Redis connected")

    async def handler(ws: WebSocketServerProtocol) -> None:
        await client_handler(ws, redis)

    server = await websockets.serve(handler, BRIDGE_HOST, BRIDGE_PORT)
    log.info("WebSocket bridge listening on ws://%s:%d", BRIDGE_HOST, BRIDGE_PORT)

    await asyncio.gather(
        server.wait_closed(),
        redis_forwarder(redis),
        stats_pusher(redis),
        heartbeat_pusher(redis),
    )


if __name__ == "__main__":
    asyncio.run(main())
