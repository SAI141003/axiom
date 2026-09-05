"""
SWARM WORKER 1 — Ingestion Worker

Responsibilities:
  - Run MarketWatcherPool (WebSocket orderbook streams for all tracked markets)
  - Run NewsAggregator (Twitter, Telegram, RSS, WorldMonitor relay)
  - Forward market.update events to Redis and local event bus
  - Update position prices when market prices change
  - Heartbeat to Redis every 10s

Communicates via:
  PUBLISHES:  market.update, news.raw
  SUBSCRIBES: system.kill
"""
from __future__ import annotations

import asyncio
import logging
import time

from core.config import cfg
from core.events import Channel, bus
from core.models import NewsEvent
from ingest.binance_feed import BinanceFeed
from ingest.market_watcher import MarketWatcherPool
from ingest.news_stream import NewsAggregator
from persist import redis_state
from portfolio.positions import update_position_price

log = logging.getLogger(__name__)


class IngestionWorker:
    """Runs all data ingestion concurrently."""

    def __init__(self) -> None:
        self._market_pool = MarketWatcherPool()
        self._news_agg = NewsAggregator()
        self._binance_feed = BinanceFeed()
        self._running = False

    async def run(self) -> None:
        self._running = True
        log.info("IngestionWorker: starting")

        await asyncio.gather(
            self._market_pool.start(),
            self._news_agg.run(),
            self._binance_feed.run(),
            self._position_price_updater(),
            self._heartbeat_loop(),
        )

    async def _position_price_updater(self) -> None:
        """
        Listen for market.update events and refresh unrealized P&L
        on open positions. Non-blocking — skips if queue is empty.
        """
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while self._running:
            try:
                update = await asyncio.wait_for(q.get(), timeout=5.0)
                market_id = update.get("market_id")
                yes_price = update.get("yes_price")
                if market_id and yes_price is not None:
                    await update_position_price(market_id, float(yes_price))
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("IngestionWorker: price updater error: %s", exc)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("ingestion")
            await asyncio.sleep(10)
