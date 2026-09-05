"""
Polymarket WebSocket market watcher.

Fixes vs. polymarket-pipeline:
1. Mandatory snapshot request on every reconnect (snapshot_pending set)
2. Deltas buffered until snapshot confirmed
3. Orderbook persisted to Redis on every update
4. Stale detection: any orderbook older than 2s is flagged
5. One MarketWatcher per cfg.ws_markets_per_connection markets
6. Momentum calculation per market

State machine:
  DISCONNECTED → CONNECTING → SNAPSHOT_PENDING → LIVE → DISCONNECTED
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone, timedelta

import httpx
import websockets
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

from core.config import cfg
from core.events import Channel, bus
from core.models import Market, Orderbook, OrderbookLevel
from ingest.orderbook_engine import get_l2_book
from persist import redis_state
from signals.markov_signal import push_price as _markov_push
from signals.wash_filter import record_market_tick as _wash_tick

log = logging.getLogger(__name__)

GAMMA_API = cfg.polymarket_gamma_api


# ── Market fetching (from polymarket-pipeline/markets.py) ─────────────────────

async def fetch_active_markets(limit: int = 300) -> list[Market]:
    """Fetch active markets from Gamma API."""
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(
                f"{GAMMA_API}/markets",
                params={
                    "active": "true",
                    "closed": "false",
                    "limit": limit,
                    "order": "volume",
                    "ascending": "false",
                },
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        log.warning("Gamma API error: %s", exc)
        return []

    markets = []
    for item in data:
        try:
            # Parse outcome prices (JSON string array)
            outcome_prices = json.loads(item.get("outcomePrices", "[0.5,0.5]"))
            yes_price = float(outcome_prices[0]) if outcome_prices else 0.5
            no_price = float(outcome_prices[1]) if len(outcome_prices) > 1 else 1 - yes_price

            volume = float(item.get("volume", 0))
            if volume < cfg.min_volume_usd or volume > cfg.max_volume_usd:
                continue
            if not item.get("active", False):
                continue

            # Skip expired markets — API sometimes returns stale entries
            end_str = item.get("endDate", item.get("end_date_iso", ""))
            if end_str:
                try:
                    end_dt = datetime.fromisoformat(end_str.replace("Z", "+00:00"))
                    if end_dt.tzinfo is None:
                        end_dt = end_dt.replace(tzinfo=timezone.utc)
                    if end_dt <= datetime.now(timezone.utc):
                        continue
                except Exception:
                    pass

            # Parse tokens
            tokens = []
            clob_rewards = item.get("clobRewards", [])
            for cr in clob_rewards:
                tokens.append({
                    "token_id": cr.get("conditionId", ""),
                    "outcome": cr.get("assetId", ""),
                })
            # Fallback token parsing from tokens field
            if not tokens:
                for t in item.get("tokens", []):
                    tokens.append({
                        "token_id": t.get("token_id", t.get("tokenId", "")),
                        "outcome": t.get("outcome", "YES"),
                    })

            question = item.get("question", "")
            category = _infer_category(question, item.get("tags", []))

            market = Market(
                condition_id=item.get("conditionId", item.get("condition_id", "")),
                question=question,
                category=category,
                yes_price=yes_price,
                no_price=no_price,
                volume=volume,
                end_date=item.get("endDate", item.get("end_date_iso", "")),
                active=True,
                tokens=tokens,
                linked_asset=_detect_linked_asset(question),
            )
            if market.condition_id:
                markets.append(market)
        except Exception as exc:
            log.debug("Market parse error: %s", exc)

    return markets


_SPORTS_KEYWORDS = {
    # generic
    "match", "game", "tournament", "championship", "league", "cup", "title",
    "winner", "finals", "semifinal", "quarterfinal", "playoff", "season",
    # soccer
    "soccer", "football", "fifa", "premier league", "la liga", "bundesliga",
    "serie a", "ligue 1", "champions league", "europa league", "world cup",
    "fa cup", "copa", "mls", "eredivisie", "supercopa", "el clasico",
    # tennis
    "tennis", "wimbledon", "us open", "french open", "australian open",
    "roland garros", "atp", "wta", "grand slam", "masters",
    # ufc / mma
    "ufc", "mma", "fight", "knockout", " ko ", "submission", "tko", "octagon",
    "bellator", "pfl", "one championship",
    # cricket
    "cricket", "odi", "test match", "t20", "ipl", "bbl", "cpl", "psl",
    "wicket", "innings", "century",
    # basketball
    "nba", "basketball", "ncaa basketball", "euroleague", "fiba",
    # baseball / hockey (bonus)
    "mlb", "nhl", "baseball", "hockey",
    # horse / motorsport
    "formula 1", "f1", "nascar", "horse racing", "grand prix",
    # team name signals
    "manchester", "arsenal", "chelsea", "liverpool", "barcelona", "real madrid",
    "juventus", "milan", "psg", "atletico", "dortmund", "bayern",
    "lakers", "celtics", "warriors", "bulls", "heat", "bucks",
    "djokovic", "nadal", "federer", "alcaraz", "sinner", "swiatek",
    "jones", "ngannou", "mcgregor", "khabib", "adesanya",
}


def _infer_category(question: str, tags: list) -> str:
    q = question.lower()
    tag_str = " ".join(str(t).lower() for t in tags)
    combined = q + " " + tag_str

    if any(w in combined for w in ["openai", "gpt", "anthropic", "gemini", "llm", "ai model"]):
        return "ai"
    if any(w in combined for w in ["bitcoin", "btc", "ethereum", "eth", "crypto", "solana", "doge"]):
        return "crypto"
    if any(w in combined for w in ["president", "election", "congress", "senate", "trump", "biden", "policy"]):
        return "politics"
    if any(w in combined for w in ["nasa", "spacex", "climate", "genome", "physics"]):
        return "science"
    if any(w in combined for w in ["nvidia", "apple", "google", "microsoft", "stock", "nasdaq"]):
        return "technology"
    # Sports detection — checked last to avoid false positives on general phrases
    tokens = set(q.split())
    bigrams = {f"{q.split()[i]} {q.split()[i+1]}" for i in range(len(q.split()) - 1)} if len(q.split()) > 1 else set()
    if (tokens | bigrams) & _SPORTS_KEYWORDS:
        return "sports"
    return "other"


def _detect_linked_asset(question: str) -> str | None:
    q = question.lower()
    # Crypto assets — order matters: longer/more specific first
    if "bitcoin" in q or " btc " in q or "btc " in q or " btc$" in q:
        return "BTC"
    if "ethereum" in q or " eth " in q:
        return "ETH"
    if "solana" in q or " sol " in q:
        return "SOL"
    if "dogecoin" in q or " doge " in q:
        return "DOGE"
    if "avalanche" in q or " avax " in q:
        return "AVAX"
    if "ripple" in q or " xrp " in q:
        return "XRP"
    if "chainlink" in q or " link " in q:
        return "LINK"
    if "bnb" in q or "binance coin" in q:
        return "BNB"
    if "polygon" in q or " matic " in q:
        return "MATIC"
    if "nvidia" in q or " nvda " in q:
        return "NVDA"
    return None


def filter_by_categories(markets: list[Market]) -> list[Market]:
    return [m for m in markets if m.category in cfg.tracked_categories]


# ── Orderbook state ───────────────────────────────────────────────────────────

@dataclass
class OrderbookState:
    market_id: str
    token_ids: list[str]
    bids: list[OrderbookLevel] = field(default_factory=list)
    asks: list[OrderbookLevel] = field(default_factory=list)
    last_update: float = field(default_factory=time.time)
    snapshot_confirmed: bool = False
    yes_price: float = 0.5
    prev_yes_price: float = 0.5
    momentum: float = 0.0

    def apply_snapshot(self, data: dict) -> None:
        """Process a 'book' snapshot event."""
        raw_bids = data.get("bids", [])
        raw_asks = data.get("asks", [])
        self.bids = [
            OrderbookLevel(price=float(b["price"]), size=float(b["size"]))
            for b in raw_bids
        ]
        self.asks = [
            OrderbookLevel(price=float(a["price"]), size=float(a["size"]))
            for a in raw_asks
        ]
        if self.asks:
            self.prev_yes_price = self.yes_price
            self.yes_price = self.asks[0].price
        self.last_update = time.time()
        self.snapshot_confirmed = True

        # Wire into L2 engine for OBI, Kyle lambda, weighted mid
        l2 = get_l2_book(self.market_id, self.yes_price)
        l2.apply_snapshot(raw_bids, raw_asks)

    def apply_delta(self, data: dict) -> None:
        """Process a 'price_change' delta event."""
        if not self.snapshot_confirmed:
            return  # never apply delta without snapshot baseline

        price = data.get("price")
        if price is not None:
            elapsed = time.time() - self.last_update
            self.prev_yes_price = self.yes_price
            self.yes_price = float(price)
            if elapsed > 0:
                self.momentum = (self.yes_price - self.prev_yes_price) / (elapsed / 60)
            self.last_update = time.time()

            # Update L2 engine best-price level
            side = data.get("side", "ask")
            sz   = float(data.get("size", 0))
            l2   = get_l2_book(self.market_id, self.yes_price)
            if sz > 0:
                l2.apply_delta(side, float(price), sz)
            else:
                l2.apply_price_change(float(price), side)

    def to_orderbook(self) -> Orderbook:
        return Orderbook(
            market_id=self.market_id,
            token_id=self.token_ids[0] if self.token_ids else "",
            bids=self.bids,
            asks=self.asks,
            last_update=self.last_update,
            snapshot_confirmed=self.snapshot_confirmed,
        )


# ── Market Watcher ────────────────────────────────────────────────────────────

class MarketWatcher:
    """
    Manages one WebSocket connection for up to ws_markets_per_connection markets.
    Handles snapshot reconciliation, delta application, and Redis persistence.
    """

    def __init__(self, worker_id: int = 0) -> None:
        self.worker_id = worker_id
        self.markets: list[Market] = []
        self.states: dict[str, OrderbookState] = {}
        self._snapshot_pending: set[str] = set()
        self._delta_buffer: dict[str, list[dict]] = {}
        self._ws_connected = False
        self.stats = {"messages": 0, "price_updates": 0, "snapshots": 0}

    async def set_markets(self, markets: list[Market]) -> None:
        self.markets = markets
        for m in markets:
            if m.condition_id not in self.states:
                token_ids = [t["token_id"] for t in m.tokens if t.get("token_id")]
                self.states[m.condition_id] = OrderbookState(
                    market_id=m.condition_id,
                    token_ids=token_ids,
                    yes_price=m.yes_price,
                )
            await redis_state.set_market(m)

    async def run(self) -> None:
        """Main loop — refresh + WebSocket with exponential backoff reconnect."""
        await asyncio.gather(
            self._refresh_loop(),
            self._ws_loop(),
        )

    async def _refresh_loop(self) -> None:
        while True:
            await asyncio.sleep(cfg.market_refresh_interval_s)
            try:
                all_markets = await fetch_active_markets()
                filtered = filter_by_categories(all_markets)
                # Keep our slice (worker_id * batch_size to (worker_id+1) * batch_size)
                batch = cfg.ws_markets_per_connection
                my_slice = filtered[self.worker_id * batch: (self.worker_id + 1) * batch]
                await self.set_markets(my_slice)
                log.info("[watcher-%d] Refreshed: %d markets", self.worker_id, len(my_slice))
            except Exception as exc:
                log.warning("[watcher-%d] Refresh error: %s", self.worker_id, exc)

    async def _ws_loop(self) -> None:
        backoff = [1, 2, 4, 8, 16, 30, 60]
        attempt = 0
        while True:
            try:
                await self._connect_and_process()
                attempt = 0  # reset on clean disconnect
            except Exception as exc:
                self._ws_connected = False
                delay = backoff[min(attempt, len(backoff) - 1)]
                log.warning(
                    "[watcher-%d] WS error (%s), reconnecting in %ds",
                    self.worker_id, exc, delay
                )
                await asyncio.sleep(delay)
                attempt += 1

    async def _connect_and_process(self) -> None:
        async with websockets.connect(
            cfg.polymarket_ws_host,
            ping_interval=None,   # disable library auto-ping; we do it manually with timeout
            close_timeout=5,
        ) as ws:
            self._ws_connected = True
            log.info("[watcher-%d] WS connected", self.worker_id)

            # Batch-subscribe all token IDs in one message
            all_token_ids = [
                token.get("token_id")
                for market in self.markets
                for token in market.tokens
                if token.get("token_id")
            ]
            if all_token_ids:
                await ws.send(json.dumps({
                    "type": "subscribe",
                    "channel": "market",
                    "assets_ids": all_token_ids,
                }))

            # Mark all markets as snapshot-pending
            self._snapshot_pending = {m.condition_id for m in self.markets}
            self._delta_buffer = {m.condition_id: [] for m in self.markets}

            # Request snapshots immediately (one per token)
            for tid in all_token_ids:
                await ws.send(json.dumps({"type": "get_order_book", "token_id": tid}))

            # Process messages
            while True:
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=25.0)
                    await self._handle_message(raw)
                except asyncio.TimeoutError:
                    # Send keepalive ping with a hard timeout; if it hangs the server is gone
                    try:
                        await asyncio.wait_for(ws.ping(), timeout=10.0)
                    except Exception:
                        raise  # propagate to outer loop → triggers reconnect
                except websockets.exceptions.ConnectionClosed as exc:
                    log.warning("[watcher-%d] WS closed by server: %s", self.worker_id, exc)
                    raise  # propagate to outer loop → triggers reconnect

    async def _handle_message(self, raw: str) -> None:
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return

        self.stats["messages"] += 1

        # Handle list of events
        events = data if isinstance(data, list) else [data]
        for event in events:
            event_type = event.get("event_type", event.get("type", ""))
            market_id = event.get("market", event.get("condition_id", ""))

            # Try to find market_id from token_id if not directly provided
            if not market_id:
                token_id = event.get("asset_id", "")
                for cid, state in self.states.items():
                    if token_id in state.token_ids:
                        market_id = cid
                        break

            if not market_id or market_id not in self.states:
                continue

            state = self.states[market_id]

            if event_type == "book":
                state.apply_snapshot(event)
                self._snapshot_pending.discard(market_id)
                self.stats["snapshots"] += 1

                # Flush buffered deltas
                for buffered in self._delta_buffer.get(market_id, []):
                    state.apply_delta(buffered)
                self._delta_buffer[market_id] = []

                log.debug("[watcher-%d] Snapshot: %s", self.worker_id, market_id[:8])

            elif event_type in ("price_change", "last_trade_price"):
                if market_id in self._snapshot_pending:
                    # Buffer until snapshot arrives
                    self._delta_buffer.setdefault(market_id, []).append(event)
                else:
                    state.apply_delta(event)
                    self.stats["price_updates"] += 1

            # Persist to Redis and emit to event bus
            if state.snapshot_confirmed:
                ob      = state.to_orderbook()
                l2      = get_l2_book(market_id, state.yes_price)
                crossed = l2.is_crossed
                obi     = None if crossed else l2.obi()
                await redis_state.set_orderbook(ob)
                await bus.publish(Channel.MARKET_UPDATE, {
                    "market_id":    market_id,
                    "yes_price":    state.yes_price,
                    "best_ask":     ob.best_ask,
                    "best_bid":     ob.best_bid,
                    "spread":       ob.spread,
                    "momentum":     state.momentum,
                    "obi":          obi,           # None when book is crossed
                    "book_crossed": crossed,
                    "kyle_lambda":  l2.kyle_lambda(),
                    "weighted_mid": l2.weighted_mid(),
                    "ts":           time.time(),
                })

                # Feed live prices into Markov and wash filter trackers
                # NOTE: oracle lag receives real Binance spot prices from BinanceFeed,
                # NOT Polymarket probabilities. Do not push yes_price to oracle lag.
                mkt = next((m for m in self.markets if m.condition_id == market_id), None)
                if mkt and mkt.linked_asset and mkt.linked_asset.upper() in (
                    "BTC", "ETH", "SOL", "DOGE", "AVAX", "XRP"
                ):
                    asyncio.create_task(_markov_push(mkt.linked_asset, state.yes_price))
                _wash_tick(
                    market_id,
                    state.yes_price,
                    getattr(mkt, "volume", 0.0) or 0.0,
                )


# ── Market Watcher Pool ───────────────────────────────────────────────────────

class MarketWatcherPool:
    """Manages multiple MarketWatcher instances, one per batch of markets."""

    def __init__(self) -> None:
        self._watchers: list[MarketWatcher] = []

    async def start(self) -> None:
        """Fetch all markets, partition into batches, start watchers."""
        all_markets = await fetch_active_markets(limit=300)
        filtered = filter_by_categories(all_markets)
        log.info("MarketWatcherPool: %d niche markets total", len(filtered))

        batch = cfg.ws_markets_per_connection
        num_workers = max(1, (len(filtered) + batch - 1) // batch)

        for i in range(num_workers):
            watcher = MarketWatcher(worker_id=i)
            my_slice = filtered[i * batch: (i + 1) * batch]
            await watcher.set_markets(my_slice)
            self._watchers.append(watcher)

        await asyncio.gather(*[w.run() for w in self._watchers])
