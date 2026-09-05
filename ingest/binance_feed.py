"""
Binance Real-Time Spot Price Feed

Connects to Binance combined WebSocket stream for BTC/ETH/SOL/DOGE/AVAX/XRP.
Pushes live USD prices to oracle_lag.push_spot_tick() — the ONLY correct
source for oracle lag calculations.

This replaces the broken approach in market_watcher.py which was pushing
Polymarket YES probabilities (0.0–1.0) as "spot prices" to oracle lag,
causing oracle_lag.scan() to always fail the `spot_now > strike` guard
(0.84 > 95000 is always False).

Stream: wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/...
Message: {"data": {"e": "24hrMiniTicker", "s": "BTCUSDT", "c": "95000.12", ...}}

Reconnects automatically on failure with exponential backoff.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Optional

import websockets

from match.oracle_lag import push_spot_tick

log = logging.getLogger(__name__)

_BINANCE_WS = "wss://stream.binance.com:9443/stream"

# Binance perpetual symbols → oracle asset names
_STREAMS: dict[str, str] = {
    "BTCUSDT":  "BTC",
    "ETHUSDT":  "ETH",
    "SOLUSDT":  "SOL",
    "DOGEUSDT": "DOGE",
    "AVAXUSDT": "AVAX",
    "XRPUSDT":  "XRP",
}

_STREAM_PATH = "/".join(f"{sym.lower()}@miniTicker" for sym in _STREAMS)

# Last known spot prices (USD) — available to other modules via get_spot()
_LAST_PRICES: dict[str, float] = {}


def get_spot(symbol: str) -> Optional[float]:
    """Return last known Binance spot price for a Binance symbol (e.g. 'BTCUSDT')."""
    return _LAST_PRICES.get(symbol.upper())


def get_spot_by_asset(asset: str) -> Optional[float]:
    """Return last known spot price by asset name (e.g. 'BTC')."""
    for sym, name in _STREAMS.items():
        if name == asset.upper():
            return _LAST_PRICES.get(sym)
    return None


class BinanceFeed:
    """
    Binance combined miniTicker WebSocket feed.
    Pushes real-time USD spot prices to oracle_lag for oracle lag arbitrage.

    Usage in IngestionWorker:
        asyncio.create_task(BinanceFeed().run())
    """

    async def run(self) -> None:
        backoff = [1, 2, 4, 8, 16, 30, 60]
        attempt = 0
        while True:
            try:
                await self._connect()
                attempt = 0
            except asyncio.CancelledError:
                return
            except Exception as exc:
                delay = backoff[min(attempt, len(backoff) - 1)]
                log.warning(
                    "BinanceFeed: disconnected (%s), reconnect in %ds", exc, delay
                )
                await asyncio.sleep(delay)
                attempt += 1

    async def _connect(self) -> None:
        url = f"{_BINANCE_WS}?streams={_STREAM_PATH}"
        async with websockets.connect(
            url,
            ping_interval=20,
            ping_timeout=10,
            close_timeout=5,
        ) as ws:
            log.info("BinanceFeed: connected (%d symbols)", len(_STREAMS))
            async for raw in ws:
                try:
                    msg = json.loads(raw)
                    data = msg.get("data", {})
                    symbol = data.get("s", "")
                    close_str = data.get("c", "")
                    if symbol in _STREAMS and close_str:
                        price = float(close_str)
                        asset = _STREAMS[symbol]
                        _LAST_PRICES[symbol] = price
                        push_spot_tick(asset, price)
                except Exception as exc:
                    log.debug("BinanceFeed: parse error %s", exc)
