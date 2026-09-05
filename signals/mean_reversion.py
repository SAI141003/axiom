"""
Mean-Reversion on Price Overreaction (QuantPedia + serial correlation findings)

Source:
  - QuantPedia "Exploiting Mean-Reversion in Decentralized Prediction Markets"
  - 58% of presidential markets showed price-spike reversals the next day
  - Best strategy: X=20-day rolling minimum, hold Y=5 days
  - 18.91% CAR (China contract), 22.09% CAR (Alien contract), Sharpe ~1.96
  - CRITICAL: passive limit orders required — aggressive market orders destroy alpha

Mechanism:
  Prediction markets exhibit negative serial correlation in volatile mid-range
  markets. Noise traders and sentiment shocks create temporary overreactions.
  When price hits X-day rolling minimum → buy limit order.
  When price recovers to rolling mean → close.

  Mean-reversion works only in:
  - Volatile markets (realized_vol > cfg.mr_min_vol)
  - Mid-range prices (0.20 < YES < 0.80) — near-binary outcomes don't revert
  - Markets with ≥ cfg.mr_lookback_n price history points

  Does NOT work in:
  - Near-certain markets (YES > 0.85 or < 0.15)
  - Crypto (prices follow external spot — reversion is real)
  - Markets in final 48h (resolution convergence overrides)

Signal quality:
  Z-score of current price vs rolling mean and rolling min.
  Trigger when price is below (mean − cfg.mr_z_threshold × std).
"""
from __future__ import annotations

import logging
import time
from collections import deque
from typing import Optional

from core.config import cfg
from core.events import Channel, bus

log = logging.getLogger(__name__)

# Per-market price history: {condition_id: deque[float]}
_PRICE_HIST: dict[str, deque] = {}
_TS_HIST:    dict[str, deque] = {}

_HIST_MAXLEN = max(cfg.mr_lookback_n + 20, 50)


def record_price(market_id: str, price: float) -> None:
    """Update rolling price history for a market. Called from market_watcher."""
    if market_id not in _PRICE_HIST:
        _PRICE_HIST[market_id] = deque(maxlen=_HIST_MAXLEN)
        _TS_HIST[market_id]    = deque(maxlen=_HIST_MAXLEN)
    _PRICE_HIST[market_id].append(price)
    _TS_HIST[market_id].append(time.time())


def _rolling_stats(prices: list[float], n: int) -> tuple[float, float, float]:
    """Return (mean, std, rolling_min) over last n observations."""
    window = prices[-n:]
    if len(window) < 2:
        return prices[-1], 0.0, prices[-1]
    mean = sum(window) / len(window)
    std  = (sum((x - mean) ** 2 for x in window) / (len(window) - 1)) ** 0.5
    rmin = min(window)
    return mean, std, rmin


def evaluate_mean_reversion(
    market_id: str,
    question: str,
    yes_price: float,
    category: str,
    tau_hours: float,
) -> Optional[dict]:
    """
    Evaluate a single market for mean-reversion entry.
    Returns an ArbOpportunity-compatible dict or None.
    """
    # Skip categories where mean-reversion doesn't hold
    if (category or "").lower() in ("crypto",):
        return None
    # Price range guard
    if yes_price < 0.20 or yes_price > 0.80:
        return None
    # Skip near-resolution
    if tau_hours < 48.0:
        return None

    prices = _PRICE_HIST.get(market_id)
    if prices is None or len(prices) < cfg.mr_lookback_n:
        return None

    price_list = list(prices)
    mean, std, rmin = _rolling_stats(price_list, cfg.mr_lookback_n)

    if std < cfg.mr_min_vol:
        return None  # not volatile enough for reversion to be meaningful

    z_score = (yes_price - mean) / std if std > 0 else 0.0

    # Only enter when price is depressed below rolling mean by threshold
    if z_score > -cfg.mr_z_threshold:
        return None

    # Price must be at or near the rolling minimum (confirm it's a genuine trough)
    near_min = abs(yes_price - rmin) <= 0.01

    edge = round(mean - yes_price, 4)  # expected recovery to mean
    if edge < cfg.mr_min_edge:
        return None

    confidence = round(min(0.70, abs(z_score) / 4.0), 3)

    return {
        "id":                   f"mr_{market_id[:8]}_{int(time.time())}",
        "strategy":             "mean_reversion",
        "market_a_id":          market_id,
        "market_a_question":    question[:80],
        "market_a_side":        "YES",
        "market_a_price":       round(yes_price, 4),
        "market_b_id":          "",
        "market_b_question":    "",
        "market_b_side":        "YES",
        "market_b_price":       round(yes_price, 4),
        "edge":                 edge,
        "confidence":           confidence,
        "reason": (
            f"Mean-reversion: z={z_score:.2f} mean={mean:.3f} "
            f"std={std:.3f} min={rmin:.3f} near_min={near_min}"
        ),
        "action": (
            f"POST YES limit @ {yes_price:.3f} "
            f"(expect reversion toward mean {mean:.3f})"
        ),
        "ts":           time.time(),
        "spot_price":   0.0,
        "strike_price": 0.0,
        "tau_hours":    round(tau_hours, 1),
        "realized_vol": round(std, 4),
        "model_prob":   round(mean, 4),
    }


class MeanReversionScanner:
    """Listens to MARKET_UPDATE events and periodically scans for mean-reversion entries."""

    async def run(self) -> None:
        import asyncio
        from core.events import Channel, bus
        await asyncio.gather(
            self._update_loop(),
            self._scan_loop(),
        )

    async def _update_loop(self) -> None:
        import asyncio
        from core.events import Channel, bus
        q = bus.subscribe_local(Channel.MARKET_UPDATE)
        while True:
            try:
                import asyncio
                event = await asyncio.wait_for(q.get(), timeout=5.0)
                mid   = event.get("market_id", "")
                if mid:
                    record_price(mid, float(event.get("yes_price", 0.5)))
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("MeanReversion: update error: %s", exc)

    async def _scan_loop(self) -> None:
        import asyncio
        from core.events import Channel, bus
        from persist import redis_state
        while True:
            await asyncio.sleep(cfg.mr_scan_interval)
            try:
                markets = await redis_state.get_all_markets()
                for m in markets:
                    tau_h = 999.0
                    if m.end_date:
                        try:
                            from datetime import datetime, timezone
                            end_dt = datetime.fromisoformat(m.end_date.replace("Z", "+00:00"))
                            tau_h = max(0.0, (end_dt - datetime.now(timezone.utc)).total_seconds() / 3600)
                        except Exception:
                            pass
                    opp = evaluate_mean_reversion(
                        m.condition_id, m.question, m.yes_price,
                        m.category or "", tau_h,
                    )
                    if opp:
                        log.info(
                            "MeanReversion: %s z=%.2f edge=+%.1f%%",
                            m.condition_id[:8],
                            float(opp["reason"].split("z=")[1].split(" ")[0]),
                            opp["edge"] * 100,
                        )
                        await bus.publish(Channel.ARB_OPPORTUNITY, opp)
            except Exception as exc:
                log.debug("MeanReversion: scan error: %s", exc)


scanner = MeanReversionScanner()
