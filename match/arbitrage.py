"""
Arbitrage Scanner — detects cross-market price inconsistencies on Polymarket.

Strategy 1: Threshold Cascade
  Markets for the same asset with different price thresholds must be monotonic:
  P("asset > $X") >= P("asset > $Y") when X < Y (lower threshold is more likely).
  If P("BTC > $80K YES") < P("BTC > $100K YES"), the lower-threshold market is
  mispriced — buy it, since it logically must resolve the same or better.

Strategy 2: Complement Sum
  On a single market, YES + NO ideally sums to ~1 plus a small spread vig.
  If YES + NO < 0.96 (arbitrarily mispriced), buying both legs guarantees a
  risk-free profit on resolution.

Strategy 3: Resolution Proximity
  Markets with YES > 0.78 resolving within 48h offer near-guaranteed short-term
  returns. The gap to $1.00 is pure time/uncertainty premium — buy to collect it.

Strategy 4: Crypto Binary Option
  For markets asking "Will BTC be above $X at [time]?", compare the log-normal
  binary option model probability N(d₂) against the devigged Polymarket price.
  Edge = model_prob − market_prob. Runs every 15 s (faster cadence than structural).
  Uses live Binance spot + realized vol — no auth required.

Publishes to: arb.opportunity (Redis + local event bus)
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

from core.events import Channel, bus
from core.models import Market
from persist import redis_state
from signals.microstructure import decayed_edge, ev_is_positive, lambda_for_category, obi_confirms

# Minimum relative price move to trigger an immediate crypto binary re-scan
# Prevents spam-scanning on tiny noise
_FAST_TRIGGER_THRESHOLD = 0.005   # 0.5% move

log = logging.getLogger(__name__)

_MIN_EDGE              = 0.02    # ignore opportunities with edge < 2 cents
_COMPLEMENT_MAX_SUM    = 0.96    # flag when YES + NO falls below this
_RESOLUTION_MAX_H      = 48.0    # look-back window for resolution proximity
_RESOLUTION_MIN_YES    = 0.78    # minimum YES price to be worth chasing
_STRUCTURAL_INTERVAL   = 8.0     # structural scan cadence (cascade / complement / resolution)
_CRYPTO_INTERVAL       = 2.0     # binary option scan cadence (faster — tracks live spot price)
_CRYPTO_MIN_EDGE       = 0.03    # slightly higher bar for binary option signal
_KALSHI_INTERVAL       = 15.0    # Kalshi cross-platform scan cadence
_NEGRISK_INTERVAL      = 1.0     # NegRisk Dutch Book — 1s (avg window = 2.7s)
_DERIBIT_INTERVAL      = 8.0     # Deribit IV surface comparison (surface rebuilt at 30s TTL)
_LATENCY_DECAY_LAMBDA  = 0.15    # edge half-life ≈ 4.6s (e^(-0.15*t))
_OBI_THRESHOLD         = 0.10    # OBI alignment required for directional signals


@dataclass
class ArbOpportunity:
    id: str                   = field(default_factory=lambda: str(uuid.uuid4())[:8])
    strategy: str             = ""
    market_a_id: str          = ""
    market_a_question: str    = ""
    market_a_side: str        = "YES"
    market_a_price: float     = 0.0    # devigged market probability for crypto_binary
    market_b_id: str          = ""
    market_b_question: str    = ""
    market_b_side: str        = "YES"
    market_b_price: float     = 0.0
    edge: float               = 0.0    # expected profit per dollar after ~1 % fee
    confidence: float         = 0.0    # 0–1 estimated signal reliability
    reason: str               = ""     # human-readable explanation
    action: str               = ""     # trade instruction
    ts: float                 = field(default_factory=time.time)
    # Binary option fields — populated for crypto_binary strategy only
    spot_price: float         = 0.0
    strike_price: float       = 0.0
    tau_hours: float          = 0.0
    realized_vol: float       = 0.0
    model_prob: float         = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _extract_usd_threshold(question: str) -> Optional[float]:
    """Extract a USD price threshold from a market question string."""
    q = question.lower().replace(",", "")
    # "$100k", "$100K"
    m = re.search(r'\$\s*(\d+(?:\.\d+)?)\s*[kK](?!\w)', q)
    if m:
        return float(m.group(1)) * 1_000
    # "$1.5m", "$2M"
    m = re.search(r'\$\s*(\d+(?:\.\d+)?)\s*[mM](?!\w)', q)
    if m:
        return float(m.group(1)) * 1_000_000
    # "$1b"
    m = re.search(r'\$\s*(\d+(?:\.\d+)?)\s*[bB](?!\w)', q)
    if m:
        return float(m.group(1)) * 1_000_000_000
    # "$50000"
    m = re.search(r'\$\s*(\d{4,}(?:\.\d+)?)', q)
    if m:
        return float(m.group(1))
    return None


def _fmt_k(value: float) -> str:
    if value >= 1_000_000:
        return f"${value/1_000_000:.1f}M"
    if value >= 1_000:
        return f"${value/1_000:.0f}K"
    return f"${value:.0f}"


# ── Scanner ────────────────────────────────────────────────────────────────────

class ArbitrageScanner:
    """
    Scans all tracked markets for exploitable price inconsistencies.

    Three scan modes:
    1. Structural timer (60s)        — cascade / complement / resolution
    2. Crypto binary timer (15s)     — full market sweep with Heston model
    3. Event-driven fast path (<1s)  — immediately re-prices a market on price update
       Subscribes to Channel.MARKET_UPDATE; triggers when price moves > 0.5%
    """

    def __init__(self) -> None:
        self._seen: set[str] = set()   # de-dup within session
        self._fast_queue: asyncio.Queue[str] = asyncio.Queue(maxsize=500)
        self._last_prices: dict[str, float] = {}    # market_id → last seen yes_price
        self._last_obi: dict[str, float] = {}        # market_id → last OBI from MARKET_UPDATE

    async def run(self) -> None:
        """
        Eleven concurrent loops:
          - Event-driven fast path (<1s): re-prices any market on MARKET_UPDATE
          - Structural timer (8s):        cascade / complement / resolution
          - Crypto binary timer (2s):     full Heston sweep of all crypto markets
          - Kalshi cross timer (15s):     cross-platform price divergence
          - NegRisk Dutch Book (1s):      multi-outcome sum violation — $29M/year
          - Deribit IV surface (8s):      options-implied probability vs Polymarket
          - Longshot NO bias (10s):       YES optimism tax (64pp EV gap at extremes)
          - Oracle lag (2s):              Chainlink end-of-window entry
          - UMA dispute (15s):            89.6% LLM accuracy post-filing
          - Smart Money scan:             depth spike detector (separate worker)
          - Mean reversion scan:          18-33% CAR on noise overreaction
        """
        log.info("ArbitrageScanner: starting 12 concurrent loops")
        from match.smart_money import scanner as sm_scanner
        from signals.mean_reversion import scanner as mr_scanner
        from match.uma_dispute import scanner as uma_scanner
        await asyncio.gather(
            self._price_update_listener(),
            self._fast_scan_worker(),
            self._structural_loop(),
            self._crypto_binary_loop(),
            self._kalshi_loop(),
            self._negrisk_loop(),
            self._deribit_loop(),
            self._longshot_loop(),
            self._oracle_lag_loop(),
            self._strike_monotone_loop(),
            sm_scanner.run(),
            mr_scanner.run(),
            uma_scanner.run(),
        )

    # ── Event-driven fast path ─────────────────────────────────────────────────

    async def _price_update_listener(self) -> None:
        """
        Subscribes to Channel.MARKET_UPDATE. On every crypto market price tick,
        if price moved ≥ 0.5% since last scan, enqueue for immediate re-pricing.
        This cuts latency from 15s timer to sub-second on live price moves.
        """
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                market_id = event.get("market_id", "")
                new_price = event.get("yes_price")
                if not market_id or new_price is None:
                    continue

                last = self._last_prices.get(market_id)
                if last is None:
                    self._last_prices[market_id] = new_price
                    continue

                if last > 0 and abs(new_price - last) / last >= _FAST_TRIGGER_THRESHOLD:
                    self._last_prices[market_id] = new_price
                    # Cache OBI for gate check in fast scan worker
                    obi = event.get("obi")
                    if obi is not None:
                        self._last_obi[market_id] = float(obi)
                    if not self._fast_queue.full():
                        await self._fast_queue.put(market_id)
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("ArbitrageScanner: price listener error: %s", exc)

    async def _fast_scan_worker(self) -> None:
        """
        Drains the fast_queue. For each market_id received, immediately runs
        the Heston binary option pricer and publishes any edge found.
        Batches up to 10 pending market_ids per iteration to avoid lock-step.
        """
        from signals.crypto_binary_signal import forecast as cb_forecast
        from core.models import CryptoBinaryOutput

        while True:
            try:
                market_id = await asyncio.wait_for(self._fast_queue.get(), timeout=2.0)
            except asyncio.TimeoutError:
                continue

            # Drain any other queued IDs for this batch
            batch: set[str] = {market_id}
            while not self._fast_queue.empty() and len(batch) < 10:
                batch.add(self._fast_queue.get_nowait())

            markets = await redis_state.get_all_markets()
            market_map = {m.condition_id: m for m in markets}

            for mid in batch:
                m = market_map.get(mid)
                if m is None or m.category != "crypto":
                    continue
                try:
                    result = await asyncio.wait_for(cb_forecast(m), timeout=4.0)
                except Exception:
                    continue

                if not isinstance(result, CryptoBinaryOutput):
                    continue
                if abs(result.edge) < _CRYPTO_MIN_EDGE:
                    continue

                side   = "YES" if result.edge > 0 else "NO"

                # Signal age = time since underlying price was observed (not compute time).
                # price_age_ms: age of price data in the L2 book for this market.
                # result.latency_ms: time to run Heston + Binance fetch.
                # Total = both combined — the edge was computed from stale price data.
                from ingest.orderbook_engine import get_l2_book as _get_l2
                _l2_fast = _get_l2(mid, m.yes_price)
                price_age  = _l2_fast.price_age_ms
                compute_ms = result.latency_ms if hasattr(result, "latency_ms") else 200.0
                signal_age_ms = price_age + compute_ms
                lam = lambda_for_category(m.category)
                eff_edge = decayed_edge(abs(result.edge), signal_age_ms, lam)
                if eff_edge < _CRYPTO_MIN_EDGE:
                    log.debug("ArbitrageScanner [FAST]: decay killed edge for %s", mid[:8])
                    continue

                # EV filter: must be positive after fees
                entry_price = result.devigged_market_prob
                if not ev_is_positive(result.model_prob, entry_price):
                    continue

                # OBI gate: order-book imbalance must agree with direction
                obi = self._last_obi.get(mid)
                if obi is not None and not obi_confirms(obi, side, _OBI_THRESHOLD):
                    log.debug(
                        "ArbitrageScanner [FAST]: OBI=%.3f disagrees with %s on %s",
                        obi, side, mid[:8]
                    )
                    continue

                bucket = int(result.spot_price / max(1, result.strike_price * 0.001))
                key    = f"cb_{mid[:10]}_{bucket}"
                if key in self._seen:
                    continue

                opp = ArbOpportunity(
                    id=key[:20],
                    strategy="crypto_binary",
                    market_a_id=mid,
                    market_a_question=m.question,
                    market_a_side=side,
                    market_a_price=entry_price,
                    edge=round(eff_edge, 4),
                    confidence=result.confidence,
                    reason=(
                        f"[FAST] {result.asset} SPOT ${result.spot_price:,.0f}  "
                        f"STRIKE ${result.strike_price:,.0f} | "
                        f"τ={result.tau_hours:.1f}h  σ={result.realized_vol_ann*100:.0f}%"
                        + (f"  OBI={obi:+.2f}" if obi is not None else "")
                    ),
                    action=(
                        f"BUY {side} @ {entry_price:.3f}  "
                        f"(model: {result.model_prob:.3f}  eff_edge: {eff_edge:+.3f})"
                    ),
                    spot_price=result.spot_price,
                    strike_price=result.strike_price,
                    tau_hours=result.tau_hours,
                    realized_vol=result.realized_vol_ann,
                    model_prob=result.model_prob,
                )
                self._seen.add(opp.id)
                await bus.publish(Channel.ARB_OPPORTUNITY, opp.to_dict())
                log.debug(
                    "ArbitrageScanner [FAST]: %s eff_edge=%+.1f%% (raw=%.1f%% age=%.0fms)",
                    m.question[:50], eff_edge * 100, result.edge * 100, signal_age_ms
                )

    # ── Strategy 6: NegRisk Dutch Book ────────────────────────────────────────

    async def _negrisk_loop(self) -> None:
        """
        Scan NegRisk events every 5 seconds for Dutch book violations.
        Median window: 2.7 seconds — requires sub-5s scan cadence.
        """
        from match.negrisk_arb import scan_all
        while True:
            await asyncio.sleep(_NEGRISK_INTERVAL)
            try:
                opps = await scan_all()
                for opp in opps:
                    d = opp.to_dict()
                    opp_id = f"nr_{opp.event_id[:12]}_{opp.direction}"
                    if opp_id in self._seen:
                        continue
                    self._seen.add(opp_id)
                    # Map to standard ArbOpportunity format for bus consumers
                    await bus.publish(Channel.ARB_OPPORTUNITY, {
                        **d,
                        "id": opp_id[:20],
                        "market_a_id": opp.legs[0].market_id if opp.legs else "",
                        "market_a_question": opp.event_title,
                        "market_a_side": "YES",
                        "market_a_price": opp.sum_ask,
                        "market_b_id": "",
                        "market_b_question": "",
                        "market_b_side": "YES",
                        "market_b_price": 0.0,
                        "spot_price": 0.0,
                        "strike_price": 0.0,
                        "tau_hours": 0.0,
                        "realized_vol": 0.0,
                        "model_prob": 0.0,
                    })
                    log.info(
                        "NegRisk Dutch Book: %s | %s edge=+%.1f%% legs=%d",
                        opp.event_title[:40], opp.direction,
                        opp.edge * 100, len(opp.legs),
                    )
            except Exception as exc:
                log.debug("ArbitrageScanner: negrisk error: %s", exc)

    # ── Strategy 7: Deribit IV Surface Comparison ─────────────────────────────

    async def _deribit_loop(self) -> None:
        """
        Refresh Deribit IV surface and compare against all BTC/ETH Polymarket markets.
        Runs every cfg.deribit_scan_interval seconds (30s default).
        """
        from signals.deribit_signal import refresh_surfaces, get_surface, compare_market
        from signals.crypto_binary_signal import _parse_strike_and_expiry
        while True:
            await asyncio.sleep(_DERIBIT_INTERVAL)
            if not cfg.use_deribit:
                continue
            try:
                await refresh_surfaces()
                markets = await redis_state.get_all_markets()
                crypto = [m for m in markets if m.category == "crypto" and m.linked_asset]

                for m in crypto:
                    surface = get_surface(m.linked_asset or "BTC")
                    if surface is None:
                        continue

                    # Parse strike and expiry from market question
                    parsed = _parse_strike_and_expiry(m.question)
                    if parsed is None:
                        continue
                    strike, expiry_ts = parsed

                    # Get live spot price from our Binance cache
                    from signals.crypto_binary_signal import _get_spot_price
                    spot = await _get_spot_price(m.linked_asset or "BTC")
                    if spot is None or spot <= 0:
                        continue

                    sig = await compare_market(
                        market_id=m.condition_id,
                        question=m.question,
                        yes_price=m.yes_price,
                        no_price=m.no_price,
                        strike=strike,
                        expiry_ts=expiry_ts,
                        spot=spot,
                        asset=m.linked_asset or "BTC",
                        surface=surface,
                    )
                    if sig is None:
                        continue

                    opp_id = f"drvb_{m.condition_id[:10]}_{int(spot/1000)}"
                    if opp_id in self._seen:
                        continue
                    self._seen.add(opp_id)

                    await bus.publish(Channel.ARB_OPPORTUNITY, {
                        "id":               opp_id[:20],
                        "strategy":         "deribit_iv_arb",
                        "market_a_id":      m.condition_id,
                        "market_a_question": m.question,
                        "market_a_side":    "YES" if sig.edge > 0 else "NO",
                        "market_a_price":   sig.poly_prob,
                        "market_b_id":      "deribit",
                        "market_b_question": f"Deribit {sig.asset} {int(sig.strike_price):,} {sig.tau_hours:.0f}h",
                        "market_b_side":    "YES",
                        "market_b_price":   sig.model_prob,
                        "edge":             round(abs(sig.edge), 4),
                        "confidence":       min(0.90, abs(sig.edge) * 4),
                        "reason": (
                            f"Deribit IV={sig.deribit_iv*100:.0f}%  "
                            f"N(d₂)={sig.model_prob:.3f}  poly={sig.poly_prob:.3f}  "
                            f"edge={sig.edge:+.3f}  τ={sig.tau_hours:.1f}h  "
                            f"spot=${sig.spot_price:,.0f}"
                        ),
                        "action": f"{sig.direction} @ {sig.poly_prob:.3f} (Deribit model: {sig.model_prob:.3f})",
                        "ts": time.time(),
                        "spot_price":   sig.spot_price,
                        "strike_price": sig.strike_price,
                        "tau_hours":    sig.tau_hours,
                        "realized_vol": sig.deribit_iv,
                        "model_prob":   sig.model_prob,
                    })
                    log.info(
                        "DeribitIV: %s edge=%+.1f%% IV=%.0f%% τ=%.1fh",
                        m.question[:45], sig.edge * 100,
                        sig.deribit_iv * 100, sig.tau_hours,
                    )
            except Exception as exc:
                log.debug("ArbitrageScanner: deribit loop error: %s", exc)

    # ── Strategy 8: Longshot NO Bias (YES Optimism Tax) ──────────────────────

    async def _longshot_loop(self) -> None:
        """
        Scan for longshot YES markets where retail over-bets YES.
        Documented 64pp EV gap at extremes (jbecker.dev / Stanford).
        """
        from match.longshot_no import scan_longshot_no
        while True:
            await asyncio.sleep(cfg.longshot_scan_interval)
            try:
                markets = await redis_state.get_all_markets()
                opps = await scan_longshot_no(markets)
                for opp in opps:
                    opp_obj = ArbOpportunity(**{
                        k: v for k, v in opp.items()
                        if k in ArbOpportunity.__dataclass_fields__
                    })
                    if opp_obj.id not in self._seen:
                        self._seen.add(opp_obj.id)
                        await bus.publish(Channel.ARB_OPPORTUNITY, opp)
            except Exception as exc:
                log.debug("LongshotNO: loop error: %s", exc)

    # ── Strategy 9: Chainlink Oracle Lag ─────────────────────────────────────

    async def _oracle_lag_loop(self) -> None:
        """
        Scan 5/15-min crypto binary markets in their final window.
        Enter when Binance spot moved decisively before Chainlink confirms.
        """
        from match.oracle_lag import scan_oracle_lag
        while True:
            await asyncio.sleep(cfg.oracle_lag_scan_interval)
            try:
                markets = await redis_state.get_all_markets()
                opps = await scan_oracle_lag(markets)
                for opp in opps:
                    opp_obj = ArbOpportunity(**{
                        k: v for k, v in opp.items()
                        if k in ArbOpportunity.__dataclass_fields__
                    })
                    if opp_obj.id not in self._seen:
                        self._seen.add(opp_obj.id)
                        await bus.publish(Channel.ARB_OPPORTUNITY, opp)
            except Exception as exc:
                log.debug("OracleLag: loop error: %s", exc)

    async def _strike_monotone_loop(self) -> None:
        """
        Model-free arb: scan for cross-strike monotonicity violations.
        P(S>K_low) < P(S>K_high) is a logical impossibility — free edge.
        Runs every 10s (same markets, cheap scan, no external I/O).
        """
        from match.strike_monotone import scan_strike_monotonicity
        while True:
            await asyncio.sleep(10.0)
            try:
                markets = await redis_state.get_all_markets()
                opps = scan_strike_monotonicity(markets)
                for opp in opps:
                    opp_obj = ArbOpportunity(**{
                        k: v for k, v in opp.items()
                        if k in ArbOpportunity.__dataclass_fields__
                    })
                    if opp_obj.id not in self._seen:
                        self._seen.add(opp_obj.id)
                        await bus.publish(Channel.ARB_OPPORTUNITY, opp)
            except Exception as exc:
                log.debug("StrikeMonotone: loop error: %s", exc)

    # ── Strategy 5: Kalshi Cross-Platform ────────────────────────────────────

    async def _kalshi_loop(self) -> None:
        while True:
            await asyncio.sleep(_KALSHI_INTERVAL)
            try:
                await self._kalshi_scan()
            except Exception as exc:
                log.debug("ArbitrageScanner: kalshi scan error: %s", exc)

    async def _kalshi_scan(self) -> None:
        from match.kalshi_arb import fetch_kalshi_markets, find_cross_platform_opps

        markets = await redis_state.get_all_markets()
        if not markets:
            return

        kalshi_markets = await fetch_kalshi_markets(200)
        if not kalshi_markets:
            return

        opps_raw = find_cross_platform_opps(markets, kalshi_markets)
        new_opps = [o for o in opps_raw if o["id"] not in self._seen]
        for opp in new_opps:
            self._seen.add(opp["id"])
            await bus.publish(Channel.ARB_OPPORTUNITY, opp)

    async def _structural_loop(self) -> None:
        while True:
            await asyncio.sleep(_STRUCTURAL_INTERVAL)
            try:
                await self._structural_scan()
            except Exception as exc:
                log.warning("ArbitrageScanner: structural scan error: %s", exc)

    async def _structural_scan(self) -> None:
        markets = await redis_state.get_all_markets()
        if not markets:
            return

        opps: list[ArbOpportunity] = []
        opps.extend(self._threshold_cascade(markets))
        opps.extend(self._complement_sum(markets))
        opps.extend(self._resolution_proximity(markets))

        new_opps = [o for o in opps if o.id not in self._seen]
        for opp in new_opps:
            self._seen.add(opp.id)
            await bus.publish(Channel.ARB_OPPORTUNITY, opp.to_dict())

        if new_opps:
            log.info(
                "ArbitrageScanner: %d structural opps (cascade=%d complement=%d resolution=%d)",
                len(new_opps),
                sum(1 for o in new_opps if o.strategy == "threshold_cascade"),
                sum(1 for o in new_opps if o.strategy == "complement"),
                sum(1 for o in new_opps if o.strategy == "resolution_proximity"),
            )

        if len(self._seen) > 2_000:
            self._seen = set(list(self._seen)[-1_000:])

    # ── Strategy 4: Crypto Binary Option ──────────────────────────────────────

    async def _crypto_binary_loop(self) -> None:
        while True:
            await asyncio.sleep(_CRYPTO_INTERVAL)
            try:
                await self._crypto_binary_scan()
            except Exception as exc:
                log.debug("ArbitrageScanner: crypto scan error: %s", exc)

    async def _crypto_binary_scan(self) -> None:
        """
        For every active crypto market with a parseable strike + expiry,
        price it as a binary call/put option using live Binance data and
        publish any opportunity where |edge| > _CRYPTO_MIN_EDGE.

        De-dup key encodes the spot price bucket so opportunities regenerate
        as price moves (prevents stale de-dup after a large price move).
        """
        from signals.crypto_binary_signal import forecast as cb_forecast

        markets = await redis_state.get_all_markets()
        crypto_markets = [m for m in markets if m.category == "crypto"]
        if not crypto_markets:
            return

        tasks = [cb_forecast(m) for m in crypto_markets]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        opps: list[ArbOpportunity] = []
        for market, result in zip(crypto_markets, results):
            if not isinstance(result, object) or isinstance(result, Exception) or result is None:
                continue
            # type narrow
            from core.models import CryptoBinaryOutput
            if not isinstance(result, CryptoBinaryOutput):
                continue
            if abs(result.edge) < _CRYPTO_MIN_EDGE:
                continue

            side = "YES" if result.edge > 0 else "NO"
            # Spot-bucketed key — refreshes every $100 move in BTC, $5 in ETH, etc.
            bucket = int(result.spot_price / max(1, result.strike_price * 0.001))
            key = f"cb_{market.condition_id[:10]}_{bucket}"
            if key in self._seen:
                continue

            opp = ArbOpportunity(
                id=key[:20],
                strategy="crypto_binary",
                market_a_id=market.condition_id,
                market_a_question=market.question,
                market_a_side=side,
                market_a_price=result.devigged_market_prob,
                edge=round(abs(result.edge), 4),
                confidence=result.confidence,
                reason=(
                    f"{result.asset} SPOT ${result.spot_price:,.0f}  STRIKE ${result.strike_price:,.0f} | "
                    f"τ={result.tau_hours:.1f}h  σ={result.realized_vol_ann*100:.0f}%  d₂={result.d2:.2f}"
                ),
                action=(
                    f"BUY {side} @ {result.devigged_market_prob:.3f}  "
                    f"(model: {result.model_prob:.3f}  edge: {result.edge:+.3f})"
                ),
                spot_price=result.spot_price,
                strike_price=result.strike_price,
                tau_hours=result.tau_hours,
                realized_vol=result.realized_vol_ann,
                model_prob=result.model_prob,
            )
            opps.append(opp)

        for opp in opps:
            self._seen.add(opp.id)
            await bus.publish(Channel.ARB_OPPORTUNITY, opp.to_dict())

        if opps:
            log.info(
                "ArbitrageScanner: %d crypto binary opps | "
                "avg edge=+%.1f%%  avg conf=%.0f%%",
                len(opps),
                sum(o.edge for o in opps) / len(opps) * 100,
                sum(o.confidence for o in opps) / len(opps) * 100,
            )

    # ── Strategy 1: Threshold Cascade ─────────────────────────────────────────

    def _threshold_cascade(self, markets: list[Market]) -> list[ArbOpportunity]:
        opps: list[ArbOpportunity] = []

        # Group by linked_asset
        by_asset: dict[str, list[Market]] = {}
        for m in markets:
            if m.linked_asset:
                by_asset.setdefault(m.linked_asset, []).append(m)

        for asset, group in by_asset.items():
            # Build (threshold, market) pairs — skip markets without a threshold
            pairs: list[tuple[float, Market]] = []
            for m in group:
                t = _extract_usd_threshold(m.question)
                if t is not None:
                    pairs.append((t, m))
            if len(pairs) < 2:
                continue

            pairs.sort(key=lambda x: x[0])  # ascending threshold

            for i in range(len(pairs) - 1):
                t_low,  m_low  = pairs[i]
                t_high, m_high = pairs[i + 1]

                # Violation: lower threshold has LOWER YES price than higher threshold
                gap = m_high.yes_price - m_low.yes_price
                if gap > _MIN_EDGE:
                    edge = gap - 0.01   # subtract assumed 1 % taker fee
                    if edge > _MIN_EDGE:
                        key = f"tc_{m_low.condition_id}_{m_high.condition_id}"
                        opp = ArbOpportunity(
                            id=key[:16],
                            strategy="threshold_cascade",
                            market_a_id=m_low.condition_id,
                            market_a_question=m_low.question,
                            market_a_side="YES",
                            market_a_price=m_low.yes_price,
                            market_b_id=m_high.condition_id,
                            market_b_question=m_high.question,
                            market_b_side="YES",
                            market_b_price=m_high.yes_price,
                            edge=round(edge, 4),
                            confidence=min(0.92, edge * 6),
                            reason=(
                                f"{asset}: {_fmt_k(t_low)} @ {m_low.yes_price:.3f} "
                                f"< {_fmt_k(t_high)} @ {m_high.yes_price:.3f} — logical violation"
                            ),
                            action=(
                                f"BUY {asset}>{_fmt_k(t_low)} YES @ {m_low.yes_price:.3f}  "
                                f"(should be ≥ {m_high.yes_price:.3f})"
                            ),
                        )
                        opps.append(opp)
        return opps

    # ── Strategy 2: Complement Sum ─────────────────────────────────────────────
    # Uses best_ask from live orderbook when available (we're price takers, not
    # mid-price). This is more conservative and avoids false positives from
    # stale mid-price data. Falls back to yes_price if no orderbook.

    def _complement_sum(self, markets: list[Market]) -> list[ArbOpportunity]:
        opps: list[ArbOpportunity] = []
        for m in markets:
            # Use effective ask prices we'd actually pay (most conservative estimate)
            yes_cost = getattr(m, "_best_ask_yes", m.yes_price)
            no_cost  = getattr(m, "_best_ask_no",  m.no_price)
            total    = yes_cost + no_cost
            if total < _COMPLEMENT_MAX_SUM:
                edge = (1.0 - total) - 0.02   # subtract 2 % for two-leg fees
                if edge > _MIN_EDGE:
                    key = f"cp_{m.condition_id}"
                    opp = ArbOpportunity(
                        id=key[:16],
                        strategy="complement",
                        market_a_id=m.condition_id,
                        market_a_question=m.question,
                        market_a_side="YES",
                        market_a_price=yes_cost,
                        market_b_id=m.condition_id,
                        market_b_question=m.question,
                        market_b_side="NO",
                        market_b_price=no_cost,
                        edge=round(edge, 4),
                        confidence=0.95,
                        reason=(
                            f"YES({yes_cost:.3f}) + NO({no_cost:.3f}) = {total:.3f} "
                            f"— guaranteed profit on resolution"
                        ),
                        action=(
                            f"BUY YES @ {yes_cost:.3f}  +  BUY NO @ {no_cost:.3f}"
                        ),
                    )
                    opps.append(opp)
        return opps

    # ── Strategy 3: Resolution Proximity ──────────────────────────────────────

    def _resolution_proximity(self, markets: list[Market]) -> list[ArbOpportunity]:
        """
        Near-certainty resolution arbitrage.
        Annualized return formula (from research):
          ann_return = (1.0 - p) / p / (T_days / 365)
        Only trade when estimated YES confidence > 90% AND ann_return > 50% APY.
        """
        opps: list[ArbOpportunity] = []
        now = datetime.now(timezone.utc)

        for m in markets:
            if not m.end_date or m.yes_price < _RESOLUTION_MIN_YES:
                continue
            try:
                end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
                hours_left = (end_dt - now).total_seconds() / 3600
                if not (0 < hours_left < _RESOLUTION_MAX_H):
                    continue

                # Dynamic fee using CLOB v2 curve
                from match.negrisk_arb import clob_taker_fee
                fee = clob_taker_fee(m.yes_price, m.category)
                raw_edge = 1.0 - m.yes_price - fee
                if raw_edge <= _MIN_EDGE:
                    continue

                # Annualized return check
                T_days = hours_left / 24.0
                ann_return = (1.0 - m.yes_price) / m.yes_price / (T_days / 365.0)
                if ann_return < 0.50:  # must exceed 50% APY
                    continue

                key = f"rp_{m.condition_id}"
                opp = ArbOpportunity(
                    id=key[:16],
                    strategy="resolution_proximity",
                    market_a_id=m.condition_id,
                    market_a_question=m.question,
                    market_a_side="YES",
                    market_a_price=m.yes_price,
                    edge=round(raw_edge, 4),
                    confidence=m.yes_price * 0.88,
                    reason=(
                        f"YES={m.yes_price:.3f}  resolves in {hours_left:.1f}h  "
                        f"annualized={ann_return:.0f}%  fee={fee:.3f}"
                    ),
                    action=f"BUY YES @ {m.yes_price:.3f}  (closes in {hours_left:.1f}h, ann={ann_return:.0f}%)",
                )
                opps.append(opp)
            except Exception:
                continue

        return opps


# Module-level singleton
scanner = ArbitrageScanner()
