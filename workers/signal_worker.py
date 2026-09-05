"""
SWARM WORKER 2 — Signal Worker

Responsibilities:
  - Consume raw news events from bus (news.raw)
  - Match each news event to tracked markets
  - For each match:
      PATH A (fast, always): Gemma 4 (NVIDIA NIM) classification
      PATH B (medium, parallel): Kronos price forecast (if market has linked_asset)
      PATH C (pre-staged, cache check): MiroFish report lookup (no blocking)
      PATH D (parallel with B): TimesFM quantile price forecast (if linked_asset)
      PATH E (parallel): Sports statistical model (if market.category == "sports")
      PATH F (parallel): Crypto binary option model (if market.category == "crypto")
  - Build ensemble Signal
  - Publish to AI-Trader for consensus tracking (non-blocking, fire-and-forget)
  - Emit final signal to signal.fast or signal.consensus channel
  - Heartbeat to Redis every 10s

Concurrency: asyncio.Semaphore limits concurrent LLM calls to 10

Communicates via:
  CONSUMES:   news.raw
  PUBLISHES:  signal.fast, signal.consensus
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import Market, NewsEvent, Signal
from execute.latency_tracker import Stage, tracker as latency_tracker
from match.arbitrage import scanner as arb_scanner
from match.matcher import matcher
from persist import redis_state
from signals.classifier import classify
from signals.crypto_binary_signal import forecast as crypto_binary_forecast
from signals.ensemble import build_signal
from signals.kronos_signal import forecast
from signals.markov_signal import forecast as markov_forecast
from signals.microstructure import get_vpin_tracker, lambda_for_category, microstructure_gate
from signals.mirofish_client import get_report as get_mirofish
from signals.sports_signal import forecast as sports_forecast
from signals.timesfm_signal import forecast as timesfm_forecast
from consensus.ai_trader_client import publish_signal, wait_for_consensus

log = logging.getLogger(__name__)


async def _check_position_exit(market, new_p_model: float, current_price: float) -> None:
    """
    Check whether a new signal warrants exiting an existing position.
    Publishes ORDER_CANCELLED event if exit is triggered; execution worker
    handles the actual CLOB cancel/close.
    """
    try:
        from portfolio.positions import check_for_exit
        reason = await check_for_exit(
            market_id            = market.condition_id,
            new_p_model          = new_p_model,
            current_market_price = current_price,
            category             = market.category,
        )
        if reason:
            log.info(
                "EXIT triggered: %s — %s",
                market.condition_id[:8], reason,
            )
            await bus.publish(Channel.ORDER_CANCELLED, {
                "market_id": market.condition_id,
                "reason":    reason,
                "ts":        time.time(),
            })
    except Exception as exc:
        log.debug("Exit check error for %s: %s", market.condition_id[:8], exc)

_LLM_SEMAPHORE = asyncio.Semaphore(10)  # max 10 concurrent Haiku calls
_API_COST_TRACKER: dict[str, float] = {"usd": 0.0, "calls": 0}
_COST_PER_HAIKU_CALL = 0.003  # ~$0.003 per classification call estimate
_DAILY_API_BUDGET = 50.0


class SignalWorker:
    def __init__(self) -> None:
        self._running = False
        self._stats = {
            "news_processed": 0,
            "markets_matched": 0,
            "signals_generated": 0,
            "signals_suppressed": 0,
        }

    async def run(self) -> None:
        self._running = True
        log.info("SignalWorker: starting")

        # Pre-compute market embeddings for semantic matching
        markets = await redis_state.get_all_markets()
        if markets:
            await matcher.initialize(markets)
            log.info("SignalWorker: embeddings for %d markets pre-computed", len(markets))

        # Subscribe to raw news
        q = bus.subscribe_local(Channel.NEWS_RAW)

        await asyncio.gather(
            self._process_news_loop(q),
            self._vpin_update_loop(),
            self._market_refresh_loop(),
            self._heartbeat_loop(),
            arb_scanner.run(),
        )

    async def _process_news_loop(self, q: asyncio.Queue) -> None:
        while self._running:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=5.0)
                news = NewsEvent.model_validate(raw)
                asyncio.create_task(self._process_news_event(news))
                self._stats["news_processed"] += 1
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("SignalWorker: consume error: %s", exc)

    async def _process_news_event(self, news: NewsEvent) -> None:
        """Process one news event end-to-end. Runs as independent task."""
        t_start = time.time()

        # Budget guard
        if _API_COST_TRACKER["usd"] >= _DAILY_API_BUDGET:
            log.warning("SignalWorker: daily API budget exhausted ($%.2f)", _DAILY_API_BUDGET)
            return

        # Get all tracked markets
        markets = await redis_state.get_all_markets()
        if not markets:
            return

        # Match news to markets
        matches = await matcher.match(news, markets, top_n=5, min_score=0.1)
        if not matches:
            return

        self._stats["markets_matched"] += len(matches)

        # BTC priority: sort BTC/crypto markets to front so they process first
        def _btc_priority(pair: tuple) -> int:
            m = pair[0]
            if m.linked_asset in ("BTC", "BITCOIN") or (
                m.category == "crypto" and "btc" in m.question.lower()
            ):
                return 0
            return 1 if m.category == "crypto" else 2

        matches_sorted = sorted(matches, key=_btc_priority)

        # Process each match concurrently
        tasks = [
            self._build_signal_for_match(news, market, score)
            for market, score in matches_sorted
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        valid_signals = [r for r in results if isinstance(r, Signal)]
        self._stats["signals_generated"] += len(valid_signals)

        t_elapsed = (time.time() - t_start) * 1000
        if valid_signals:
            log.info(
                "SignalWorker: %d signals from '%s...' in %.0fms",
                len(valid_signals), news.headline[:50], t_elapsed
            )

    async def _build_signal_for_match(
        self,
        news: NewsEvent,
        market: Market,
        match_score: float,
    ) -> Optional[Signal]:
        """
        Build a signal for one (news, market) pair.
        PATH A (Gemma 4) always runs.
        PATH B (Kronos) runs in parallel if market has linked_asset.
        PATH C (MiroFish) is a cache-only lookup, no blocking.
        PATH D (TimesFM) runs in parallel with PATH B if asset-linked.
        PATH E (Sports) runs for sports-category markets.
        PATH F (CryptoBinary) runs for crypto markets.
        PATH G (Markov) runs for BTC/crypto markets — persistence gate.
        """
        # PATH H: Wash trading filter — skip markets with suspicious volume patterns
        from signals.wash_filter import is_wash_suspicious
        if is_wash_suspicious(market):
            log.debug("WashFilter: skipping %s (suspicious volume)", market.condition_id[:8])
            return None

        async with _LLM_SEMAPHORE:
            t0 = time.time()
            latency_tracker.start(market.condition_id)

            # Increment API cost tracker
            _API_COST_TRACKER["usd"] += _COST_PER_HAIKU_CALL
            _API_COST_TRACKER["calls"] += 1

            # PATH A: Gemma 4 (NVIDIA NIM) classification (always)
            classification_task = asyncio.create_task(classify(news, market))

            # PATH B: Kronos (parallel, only if asset-linked)
            kronos_task = None
            if cfg.use_kronos and market.linked_asset:
                kronos_task = asyncio.create_task(forecast(market))

            # PATH D: TimesFM (parallel with Kronos, only if asset-linked)
            timesfm_task = None
            if cfg.use_timesfm and market.linked_asset:
                timesfm_task = asyncio.create_task(timesfm_forecast(market))

            # PATH E: Sports statistical model (parallel, only for sports markets)
            sports_task = None
            if cfg.use_sports and market.category == "sports":
                sports_task = asyncio.create_task(sports_forecast(market))

            # PATH F: Crypto binary option model (parallel, only for crypto markets)
            crypto_binary_task = None
            if market.category == "crypto":
                crypto_binary_task = asyncio.create_task(crypto_binary_forecast(market))

            # PATH G: Markov State Transition (BTC/crypto — parallel, very fast, cached)
            markov_task = None
            if cfg.use_markov and market.category == "crypto":
                markov_task = asyncio.create_task(markov_forecast(market))

            # Await Gemma first (usually finishes first)
            classification = await classification_task

            # Await Kronos if running (with tight timeout)
            kronos = None
            if kronos_task:
                try:
                    kronos = await asyncio.wait_for(asyncio.shield(kronos_task), timeout=2.0)
                except asyncio.TimeoutError:
                    log.debug("SignalWorker: Kronos timeout for %s", market.linked_asset)
                    kronos_task.cancel()

            # Await TimesFM if running (longer timeout — larger model)
            timesfm = None
            if timesfm_task:
                try:
                    timesfm = await asyncio.wait_for(asyncio.shield(timesfm_task), timeout=12.0)
                except asyncio.TimeoutError:
                    log.debug("SignalWorker: TimesFM timeout for %s", market.linked_asset)
                    timesfm_task.cancel()

            # Await Sports if running (uses cfg.sports_timeout_s — external HTTP)
            sports = None
            if sports_task:
                try:
                    sports = await asyncio.wait_for(
                        asyncio.shield(sports_task),
                        timeout=cfg.sports_timeout_s,
                    )
                except asyncio.TimeoutError:
                    log.debug("SignalWorker: Sports timeout for %s", market.condition_id[:8])
                    sports_task.cancel()

            # Await Crypto Binary if running (fast external call — 5s timeout)
            crypto_binary = None
            if crypto_binary_task:
                try:
                    crypto_binary = await asyncio.wait_for(
                        asyncio.shield(crypto_binary_task),
                        timeout=5.0,
                    )
                except asyncio.TimeoutError:
                    log.debug("SignalWorker: CryptoBinary timeout for %s", market.condition_id[:8])
                    crypto_binary_task.cancel()

            # Await Markov (very fast — reads Redis cache or in-process buffer, <2ms)
            markov = None
            if markov_task:
                try:
                    markov = await asyncio.wait_for(asyncio.shield(markov_task), timeout=2.0)
                except asyncio.TimeoutError:
                    log.debug("SignalWorker: Markov timeout for %s", market.condition_id[:8])
                    markov_task.cancel()

            # PATH C: MiroFish cache lookup (non-blocking, instant)
            mirofish = None
            if cfg.use_mirofish:
                mirofish = await get_mirofish(market)

            # Get current bankroll for Kelly sizing
            bankroll = await redis_state.get_bankroll()

            # Build ensemble signal
            signal = build_signal(
                market=market,
                news=news,
                classification=classification,
                bankroll=bankroll,
                kronos=kronos,
                mirofish=mirofish,
                timesfm=timesfm,
                sports=sports,
                crypto_binary=crypto_binary,
                markov=markov,
                consensus_count=0,  # will be updated by consensus tracking
                order_flow_vpin=crypto_binary.vpin if crypto_binary is not None else 0.0,
            )

            elapsed = (time.time() - t0) * 1000
            latency_tracker.record(Stage.SIGNAL, elapsed)
            latency_tracker.finish(market.condition_id)

            if signal is None:
                self._stats["signals_suppressed"] += 1
                return None

            # Microstructure gate: OBI + latency decay + EV filter + VPIN
            from ingest.orderbook_engine import get_l2_book
            l2  = get_l2_book(market.condition_id, market.yes_price)
            obi = l2.obi() if l2._snapshot_confirmed else None
            # Total signal age = price data age + LLM compute time
            total_age_ms = l2.price_age_ms + elapsed
            gate = microstructure_gate(
                market_id     = market.condition_id,
                side          = signal.side,
                edge          = signal.edge,
                p_win         = signal.p_model,
                price         = signal.target_price,
                signal_age_ms = total_age_ms,
                obi           = obi,
                lambda_per_s  = lambda_for_category(market.category),
                obi_threshold = cfg.obi_gate_threshold,
                vpin_threshold = cfg.vpin_adverse_threshold,
                ev_fee_rate   = cfg.ev_fee_rate,
            )
            if not gate.approved:
                log.debug(
                    "SignalWorker: microstructure gate blocked %s — %s",
                    market.condition_id[:8], gate.reason,
                )
                self._stats["signals_suppressed"] += 1
                return None

            # Use effective (decayed) edge for downstream sizing
            signal = signal.model_copy(update={"edge": gate.effective_edge})

            # Store signal in Redis (TTL 60s)
            await redis_state.set_signal(signal)

            # Publish to AI-Trader (fire-and-forget, non-blocking)
            if cfg.use_ai_trader_consensus:
                asyncio.create_task(self._track_consensus(signal))
            else:
                # Emit directly to fast signal channel
                await bus.publish(Channel.SIGNAL_FAST, signal.model_dump())

            # Exit check: does this new signal warrant closing an existing position?
            # Non-blocking — failures are logged and ignored.
            asyncio.create_task(
                _check_position_exit(market, signal.p_model, signal.target_price)
            )

            log.debug(
                "Signal: %s %s edge=%.3f eff_edge=%.3f (%.0fms)",
                signal.side, market.condition_id[:8], signal.edge,
                gate.effective_edge, elapsed,
            )
            return signal

    async def _track_consensus(self, signal: Signal) -> None:
        """
        Publish to AI-Trader and wait up to 30s for consensus.
        Then emit to signal.fast or signal.consensus.
        """
        published = await publish_signal(signal)
        if not published:
            # Fallback: emit immediately without consensus
            await bus.publish(Channel.SIGNAL_FAST, signal.model_dump())
            return

        # Wait for consensus window (30s)
        consensus_count = await wait_for_consensus(signal, timeout_s=30.0)

        # Update signal with consensus count
        updated_signal = signal.model_copy(update={"consensus_count": consensus_count})

        channel = Channel.SIGNAL_CONSENSUS if consensus_count >= 3 else Channel.SIGNAL_FAST
        await bus.publish(channel, updated_signal.model_dump())

    async def _vpin_update_loop(self) -> None:
        """
        Listen to MARKET_UPDATE events and feed prices into per-market VPIN trackers.
        VPIN helps detect adverse selection: high VPIN → informed flow → skip entry.
        """
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while self._running:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                mid    = event.get("market_id", "")
                price  = event.get("yes_price")
                if mid and price is not None:
                    tracker_v = get_vpin_tracker(mid)
                    tracker_v.update(float(price))
            except asyncio.TimeoutError:
                pass
            except Exception:
                pass

    async def _market_refresh_loop(self) -> None:
        """Refresh matcher's market embeddings when market list changes."""
        while self._running:
            await asyncio.sleep(cfg.market_refresh_interval_s)
            try:
                markets = await redis_state.get_all_markets()
                if markets:
                    await matcher.update_markets(markets)
            except Exception as exc:
                log.debug("SignalWorker: market refresh error: %s", exc)

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("signal")
            await asyncio.sleep(10)

    def get_stats(self) -> dict:
        return {
            **self._stats,
            "api_cost_usd": round(_API_COST_TRACKER["usd"], 3),
            "api_calls": _API_COST_TRACKER["calls"],
        }
