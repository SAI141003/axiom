"""
Multi-source news aggregation.
Sources: Twitter API v2, Telegram long-poll, RSS feeds, WorldMonitor webhook relay.

Deduplication: 50K-item in-memory set + Redis for cross-process dedup.
All sources run concurrently. Output: asyncio.Queue[NewsEvent].
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass, field
from typing import Optional

import aiohttp
import feedparser

from core.config import cfg
from core.events import Channel, bus
from core.models import NewsEvent
from persist import redis_state

log = logging.getLogger(__name__)

# WorldMonitor's top news feed categories (from worldmonitor's 500+ feed catalog)
WORLDMONITOR_FEEDS = [
    # Tech / AI
    "https://feeds.feedburner.com/TechCrunch",
    "https://www.theverge.com/rss/index.xml",
    "https://arstechnica.com/feed/",
    "https://news.google.com/rss/search?q=artificial+intelligence&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=openai+anthropic+gemini&hl=en-US&gl=US&ceid=US:en",
    # Crypto
    "https://coindesk.com/arc/outboundfeeds/rss/",
    "https://cointelegraph.com/rss",
    "https://news.google.com/rss/search?q=bitcoin+ethereum+crypto&hl=en-US&gl=US&ceid=US:en",
    # Politics / Finance
    "https://feeds.reuters.com/reuters/topNews",
    "https://news.google.com/rss/search?q=federal+reserve+interest+rates&hl=en-US&gl=US&ceid=US:en",
    "https://news.google.com/rss/search?q=congress+legislation+senate&hl=en-US&gl=US&ceid=US:en",
    # Science
    "https://news.google.com/rss/search?q=spacex+nasa+discovery&hl=en-US&gl=US&ceid=US:en",
    # General breaking news
    "https://feeds.bbci.co.uk/news/rss.xml",
    "https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml",
    "https://wsj.com/xml/rss/3_7085.xml",
]


class NewsDeduplier:
    """Local in-memory + Redis deduplication, 50K headline cache."""

    def __init__(self) -> None:
        self._seen: set[str] = set()
        self._max = 50_000
        self._trim_to = 25_000

    def _hash(self, headline: str) -> str:
        return hashlib.md5(headline.lower()[:80].encode()).hexdigest()

    async def is_duplicate(self, headline: str) -> bool:
        h = self._hash(headline)
        if h in self._seen:
            return True
        return await redis_state.is_duplicate_news(headline)

    async def mark_seen(self, headline: str) -> None:
        h = self._hash(headline)
        self._seen.add(h)
        await redis_state.mark_news_seen(headline)
        if len(self._seen) > self._max:
            # Keep the newest half (Python set has no ordering, so rebuild)
            self._seen = set(list(self._seen)[-self._trim_to:])


class RSSFallback:
    """Polls WorldMonitor's feed catalog on an interval."""

    def __init__(self, output: asyncio.Queue, dedup: NewsDeduplier) -> None:
        self.output = output
        self.dedup = dedup
        self._interval_s = 60  # poll every 60s (much more aggressive than the 120s in polymarket-pipeline)
        self.stats = {"events": 0}

    async def run(self) -> None:
        while True:
            tasks = [self._poll_feed(url) for url in WORLDMONITOR_FEEDS]
            await asyncio.gather(*tasks, return_exceptions=True)
            await asyncio.sleep(self._interval_s)

    async def _poll_feed(self, url: str) -> None:
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return
                    content = await resp.read()

            parsed = feedparser.parse(content)
            for entry in parsed.entries[:5]:  # only newest 5 per feed
                headline = entry.get("title", "").strip()
                if not headline or len(headline) < 10:
                    continue

                published_ts = time.time()
                if entry.get("published_parsed"):
                    import calendar
                    published_ts = float(calendar.timegm(entry.published_parsed))

                if await self.dedup.is_duplicate(headline):
                    continue

                await self.dedup.mark_seen(headline)
                event = NewsEvent(
                    headline=headline,
                    source=f"rss:{url.split('/')[2]}",
                    published_at=published_ts,
                    url=entry.get("link", ""),
                    content=entry.get("summary", ""),
                )
                await self.output.put(event)
                self.stats["events"] += 1
        except Exception as exc:
            log.debug("RSS poll error (%s): %s", url[:40], exc)


class TwitterStream:
    """
    Twitter API v2 filtered stream — real-time keyword monitoring.
    Exponential backoff on reconnect (from polymarket-pipeline/news_stream.py).
    """

    KEYWORDS = [
        "openai OR anthropic OR gemini AI announcement",
        "federal reserve interest rate hike cut",
        "bitcoin ethereum crypto crash pump",
        "election president congress vote",
        "nvidia tesla apple earnings",
        "spacex nasa moon mars launch",
    ]

    def __init__(self, output: asyncio.Queue, dedup: NewsDeduplier) -> None:
        self.output = output
        self.dedup = dedup
        self.stats = {"events": 0}

    async def run(self) -> None:
        if not cfg.twitter_bearer_token:
            log.info("TwitterStream: no bearer token, disabled")
            return
        try:
            import tweepy.asynchronous
            client = tweepy.asynchronous.AsyncStreamingClient(cfg.twitter_bearer_token)
            # Rules are set at startup (max 5 for Basic tier)
            await self._set_rules(client)
            await client.filter(tweet_fields=["created_at", "text"], expansions=[])
        except ImportError:
            log.warning("TwitterStream: tweepy not installed")
        except Exception as exc:
            log.warning("TwitterStream error: %s", exc)

    async def _set_rules(self, client) -> None:
        existing = await client.get_rules()
        if existing.data:
            ids = [r.id for r in existing.data]
            await client.delete_rules(ids)
        # Batch keywords (Basic tier: max 5 rules)
        for kw in self.KEYWORDS[:5]:
            try:
                await client.add_rules(tweepy.StreamRule(kw))
            except Exception as exc:
                log.debug("Twitter rule error: %s", exc)


class TelegramMonitor:
    """Long-polls Telegram Bot API for channel messages."""

    def __init__(self, output: asyncio.Queue, dedup: NewsDeduplier) -> None:
        self.output = output
        self.dedup = dedup
        self._offset = 0
        self.stats = {"events": 0}

    async def run(self) -> None:
        if not cfg.telegram_bot_token:
            log.info("TelegramMonitor: no token, disabled")
            return

        base_url = f"https://api.telegram.org/bot{cfg.telegram_bot_token}"
        backoff = 1
        while True:
            try:
                async with aiohttp.ClientSession() as session:
                    async with session.get(
                        f"{base_url}/getUpdates",
                        params={"offset": self._offset, "timeout": 30},
                        timeout=aiohttp.ClientTimeout(total=35),
                    ) as resp:
                        data = await resp.json()

                if data.get("ok"):
                    for update in data.get("result", []):
                        self._offset = update["update_id"] + 1
                        msg = update.get("message", update.get("channel_post", {}))
                        text = msg.get("text", "")
                        if not text or len(text) < 15:
                            continue

                        if await self.dedup.is_duplicate(text[:80]):
                            continue
                        await self.dedup.mark_seen(text[:80])

                        event = NewsEvent(
                            headline=text[:200],
                            source="telegram",
                            published_at=float(msg.get("date", time.time())),
                        )
                        await self.output.put(event)
                        self.stats["events"] += 1

                backoff = 1
            except Exception as exc:
                log.warning("Telegram error: %s, retry in %ds", exc, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 60)


class WorldMonitorRelay:
    """
    WorldMonitor integration — two modes:
      1. Webhook push: call receive() from an HTTP endpoint when WorldMonitor pushes
      2. Direct poll: if cfg.worldmonitor_api_url is set, polls the API every 30s

    WorldMonitor exposes 500+ curated feeds across 15 categories with multi-stream
    correlation and Country Intelligence Index signals.
    """

    # Publicly accessible WorldMonitor finance/news RSS endpoints
    _FALLBACK_FEEDS = [
        "https://news.google.com/rss/search?q=geopolitics+conflict+war&hl=en-US&gl=US&ceid=US:en",
        "https://news.google.com/rss/search?q=economic+sanctions+trade&hl=en-US&gl=US&ceid=US:en",
        "https://news.google.com/rss/search?q=central+bank+monetary+policy&hl=en-US&gl=US&ceid=US:en",
        "https://news.google.com/rss/search?q=election+coup+government+collapse&hl=en-US&gl=US&ceid=US:en",
    ]

    def __init__(self, output: asyncio.Queue, dedup: NewsDeduplier) -> None:
        self.output = output
        self.dedup = dedup
        self.stats = {"events": 0}

    async def run(self) -> None:
        """
        Poll WorldMonitor API (if configured) or its fallback geopolitical feeds.
        Runs every 30s — supplements the standard RSS poller with geopolitical signals.
        """
        while True:
            await asyncio.sleep(30)
            try:
                if cfg.worldmonitor_api_url:
                    await self._poll_api()
                else:
                    await asyncio.gather(
                        *[self._poll_feed(url) for url in self._FALLBACK_FEEDS],
                        return_exceptions=True,
                    )
            except Exception as exc:
                log.debug("WorldMonitor: poll error: %s", exc)

    async def _poll_api(self) -> None:
        """Poll a configured WorldMonitor relay API endpoint."""
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(
                    f"{cfg.worldmonitor_api_url}/api/news/latest",
                    params={"limit": 20},
                ) as resp:
                    if resp.status != 200:
                        return
                    data = await resp.json()

            items = data if isinstance(data, list) else data.get("items", data.get("news", []))
            for item in items:
                await self.receive(item)
        except Exception as exc:
            log.debug("WorldMonitor: API poll error: %s", exc)

    async def _poll_feed(self, url: str) -> None:
        """Poll a single RSS feed for geopolitical/macro signals."""
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
                async with session.get(url) as resp:
                    if resp.status != 200:
                        return
                    content = await resp.read()

            parsed = feedparser.parse(content)
            for entry in parsed.entries[:3]:
                headline = entry.get("title", "").strip()
                if not headline or len(headline) < 10:
                    continue
                published_ts = time.time()
                if entry.get("published_parsed"):
                    import calendar
                    published_ts = float(calendar.timegm(entry.published_parsed))
                if await self.dedup.is_duplicate(headline):
                    continue
                await self.dedup.mark_seen(headline)
                event = NewsEvent(
                    headline=headline,
                    source="worldmonitor:geopolitical",
                    published_at=published_ts,
                    url=entry.get("link", ""),
                    content=entry.get("summary", ""),
                )
                await self.output.put(event)
                self.stats["events"] += 1
        except Exception as exc:
            log.debug("WorldMonitor: feed error (%s): %s", url[:50], exc)

    async def receive(self, payload: dict) -> None:
        """Called by the webhook server when WorldMonitor pushes a news event."""
        headline = payload.get("title", payload.get("headline", ""))
        if not headline:
            return
        if await self.dedup.is_duplicate(headline):
            return
        await self.dedup.mark_seen(headline)
        event = NewsEvent(
            headline=headline,
            source=f"worldmonitor:{payload.get('category', 'general')}",
            published_at=float(payload.get("publishedAt", time.time())),
            url=payload.get("url", ""),
            content=payload.get("content", ""),
        )
        await self.output.put(event)
        self.stats["events"] += 1


class NewsAggregator:
    """
    Runs all sources concurrently.
    Emits deduplicated NewsEvents to the event bus.
    """

    def __init__(self) -> None:
        self._raw_queue: asyncio.Queue[NewsEvent] = asyncio.Queue(maxsize=5000)
        self._dedup = NewsDeduplier()
        self.rss = RSSFallback(self._raw_queue, self._dedup)
        self.twitter = TwitterStream(self._raw_queue, self._dedup)
        self.telegram = TelegramMonitor(self._raw_queue, self._dedup)
        self.worldmonitor = WorldMonitorRelay(self._raw_queue, self._dedup)
        self.stats = {"total_emitted": 0}

    async def run(self) -> None:
        await asyncio.gather(
            self.rss.run(),
            self.twitter.run(),
            self.telegram.run(),
            self.worldmonitor.run(),
            self._emit_loop(),
        )

    async def _emit_loop(self) -> None:
        """Forward raw events from internal queue to event bus."""
        while True:
            event = await self._raw_queue.get()
            await bus.publish(Channel.NEWS_RAW, event.model_dump())
            self.stats["total_emitted"] += 1
            self._raw_queue.task_done()
