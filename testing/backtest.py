"""
Backtest crypto binary signal on recently-closed Polymarket markets.

Workflow:
  1. Fetch closed BNB/SOL/ETH "Up or Down" markets from Gamma API (last 48h)
  2. For each, fetch Binance klines at the time T-5min before expiry
  3. Run BS/Heston model as-if we were pricing it 5 min before close
  4. Determine actual outcome from Binance close price at expiry
  5. Log to tracker.py SQLite → run print_report()

Usage:
  python testing/backtest.py
  python testing/backtest.py --hours 24 --min-tau-min 1 --max-tau-min 15
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import math
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import aiohttp
import numpy as np

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("backtest")

RST = "\033[0m"; GRN = "\033[92m"; RED = "\033[91m"; YLW = "\033[93m"
CYN = "\033[96m"; BLD = "\033[1m"; DIM = "\033[2m"
def _c(col, txt): return f"{col}{txt}{RST}"


# ── Fetch closed markets ───────────────────────────────────────────────────────

async def fetch_closed_crypto_markets(
    session: aiohttp.ClientSession,
    limit: int = 300,
) -> list[dict]:
    """
    Fetch resolved fixed-strike crypto markets from Polymarket CLOB API.
    These have confirmed YES/NO outcomes and known expiry timestamps.
    """
    KEYWORDS = ("btc", "bitcoin", "eth", "ethereum", "sol", "solana",
                "bnb", "doge", "xrp", "avax", "link", "crypto")

    markets = []
    cursor = ""
    fetched = 0

    while fetched < limit:
        try:
            async with session.get(
                "https://clob.polymarket.com/markets",
                params={"limit": 100, "next_cursor": cursor},
                timeout=aiohttp.ClientTimeout(total=10),
            ) as r:
                data = await r.json()
        except Exception as exc:
            log.debug("CLOB fetch error: %s", exc)
            break

        items = data.get("data", [])
        if not items:
            break

        for item in items:
            q = item.get("question", "").lower()
            if not any(kw in q for kw in KEYWORDS):
                continue
            if not item.get("closed", False):
                continue

            end_iso = item.get("end_date_iso", "")
            if not end_iso:
                continue
            try:
                dt = datetime.fromisoformat(end_iso.replace("Z", "+00:00"))
                exp_ts = dt.timestamp()
            except Exception:
                continue

            # Need a parseable strike
            from signals.crypto_binary_signal import _parse_strike
            strike = _parse_strike(item.get("question", ""))
            if strike is None:
                continue

            # Get devigged prices from tokens
            tokens = item.get("tokens", [])
            yes_price = no_price = 0.5
            for t in tokens:
                outcome = t.get("outcome", "").upper()
                price   = float(t.get("price", 0.5))
                if outcome == "YES":
                    yes_price = price
                elif outcome == "NO":
                    no_price = price

            # Determine outcome from winning token
            outcome_val = None
            for t in tokens:
                if t.get("winner", False):
                    outcome_val = 1 if t.get("outcome", "").upper() == "YES" else 0
                    break

            markets.append({
                "condition_id": item.get("condition_id", ""),
                "question":     item.get("question", ""),
                "exp_ts":       exp_ts,
                "yes_price":    yes_price,
                "no_price":     no_price,
                "strike":       strike,
                "outcome":      outcome_val,
                "volume":       float(item.get("volume", 0) or 0),
            })

        fetched += len(items)
        cursor = data.get("next_cursor", "")
        if not cursor or cursor == "LTE=":
            break

    return markets


# ── Binance historical data ────────────────────────────────────────────────────

async def fetch_klines_at(
    session: aiohttp.ClientSession,
    symbol: str,
    end_ts_ms: int,
    n: int = 30,
    interval: str = "5m",
) -> list[float]:
    """Return n close prices ending at end_ts_ms (exclusive)."""
    start_ms = end_ts_ms - n * 5 * 60 * 1000
    try:
        async with session.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": symbol, "interval": interval,
                    "startTime": start_ms, "endTime": end_ts_ms, "limit": n},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as r:
            data = await r.json()
        return [float(c[4]) for c in data]
    except Exception:
        return []


async def fetch_price_at(
    session: aiohttp.ClientSession,
    symbol: str,
    ts_ms: int,
) -> Optional[float]:
    """Return the close price of the 1-min candle that contains ts_ms."""
    try:
        async with session.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": symbol, "interval": "1m",
                    "startTime": ts_ms - 60_000,
                    "endTime": ts_ms + 60_000,
                    "limit": 3},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as r:
            data = await r.json()
        if not data:
            return None
        return float(data[0][4])
    except Exception:
        return None


# ── Model pricing (no external dependencies, no Redis) ───────────────────────

def _bs_digital(spot: float, strike: float, sigma: float,
                tau_years: float, mu: float, direction: str) -> tuple[float, float]:
    """Pure Black-Scholes digital probability. Returns (prob_yes, d2)."""
    from scipy.stats import norm
    if tau_years <= 0 or sigma <= 0 or spot <= 0 or strike <= 0:
        return 0.5, 0.0
    vol_sqrt_tau = sigma * math.sqrt(tau_years)
    d2 = (math.log(spot / strike) + (mu - 0.5 * sigma**2) * tau_years) / vol_sqrt_tau
    prob_above = float(norm.cdf(d2))
    return (prob_above if direction == "above" else 1.0 - prob_above), d2


def _realized_vol(closes: list[float]) -> float:
    """Annualized realized vol from 5-min close prices."""
    if len(closes) < 3:
        return 0.70
    log_r = np.diff(np.log(np.array(closes, dtype=float)))
    # 5-min interval → ×105120 to annualize variance
    return float(np.std(log_r, ddof=1) * math.sqrt(105_120))


def _price_market(
    closes: list[float],   # historical 5-min closes ending ~5 min before expiry
    spot: float,           # spot price at prediction time
    tau_hours: float,      # hours to expiry at prediction time
    yes_price: float,      # devigged Polymarket market price
    no_price: float,
    direction: str = "above",
    strike: Optional[float] = None,
) -> dict:
    """Runs the BS model (simplified, no Heston/onchain for backtest clarity)."""
    if strike is None:
        strike = spot   # "Up or Down" → strike = window-open proxy

    sigma = _realized_vol(closes) if len(closes) >= 3 else 0.70

    # Momentum decay (same formula as live model)
    if len(closes) >= 2:
        momentum_5m = closes[-1] / closes[-2] - 1.0
        momentum_decay = math.exp(-tau_hours / 0.5)
        mu = float(np.clip(momentum_5m * 105_120 * momentum_decay, -3.0, 3.0))
    else:
        mu = 0.0
        momentum_5m = 0.0

    tau_years = tau_hours / 8_760.0
    model_prob, d2 = _bs_digital(spot, strike, sigma, tau_years, mu, direction)
    model_prob = float(np.clip(model_prob, 0.01, 0.99))

    total = yes_price + no_price
    devigged = yes_price / total if total > 0 else yes_price
    edge = model_prob - devigged

    return {
        "model_prob":   model_prob,
        "market_prob":  devigged,
        "edge":         edge,
        "sigma":        sigma,
        "d2":           d2,
        "tau_hours":    tau_hours,
        "momentum_5m":  momentum_5m,
        "strike":       strike,
        "spot":         spot,
    }


# ── Main backtest loop ────────────────────────────────────────────────────────

async def run_backtest(
    limit: int = 300,
    tau_hours_list: list[float] = None,
) -> None:
    if tau_hours_list is None:
        # Price each market at 3 τ snapshots: 24h, 4h, 1h before expiry
        tau_hours_list = [24.0, 4.0, 1.0]

    from testing.tracker import log_evaluation, print_report, _conn
    from signals.crypto_binary_signal import _parse_asset

    t0 = time.time()
    sep = "═" * 64
    print(f"\n{_c(BLD+CYN, sep)}")
    print(_c(BLD+CYN, "  BACKTEST — Crypto Binary Signal"))
    print(_c(BLD+CYN, f"  CLOB historical markets  |  τ snapshots: {tau_hours_list}h"))
    print(_c(BLD+CYN, sep))

    async with aiohttp.ClientSession() as session:

        print(f"\n{_c(BLD, '[1/3] Fetching resolved crypto markets from CLOB...')}", flush=True)
        markets = await fetch_closed_crypto_markets(session, limit=limit)
        if not markets:
            print(_c(RED, "  No resolved markets found."))
            return

        # Only keep markets with known outcomes and clean question structure
        # Exclude race-condition questions ("hit X or Y first") — model doesn't handle them
        def _is_clean(m: dict) -> bool:
            q = m.get("question", "").lower()
            if " or " in q and "first" in q:
                return False
            return m.get("outcome") is not None

        with_outcome = [m for m in markets if _is_clean(m)]
        print(f"      {_c(GRN, str(len(markets)))} resolved markets  "
              f"({len(with_outcome)} with known YES/NO outcome)")

        print(f"\n{_c(BLD, '[2/3] Pricing at historical τ snapshots...')}", flush=True)

        logged = 0
        errors = 0

        sem = asyncio.Semaphore(6)

        async def _process_one(mkt: dict) -> int:
            nonlocal errors
            async with sem:
                try:
                    asset, symbol = _parse_asset(mkt["question"])
                    if not asset or not symbol:
                        return 0
                    if mkt.get("outcome") is None:
                        return 0

                    exp_ts = mkt["exp_ts"]
                    exp_ms = int(exp_ts * 1000)
                    strike = mkt["strike"]
                    outcome = mkt["outcome"]
                    count = 0

                    for tau_h in tau_hours_list:
                        pred_ts_ms = exp_ms - int(tau_h * 3600 * 1000)
                        closes = await fetch_klines_at(session, symbol, pred_ts_ms)
                        if not closes:
                            continue

                        spot = closes[-1]
                        pricing = _price_market(
                            closes=closes[:-1],
                            spot=spot,
                            tau_hours=tau_h,
                            yes_price=mkt["yes_price"],
                            no_price=mkt["no_price"],
                            direction="above",
                            strike=strike,
                        )

                        result = {
                            "asset":               asset,
                            "direction":           "above",
                            "strike_price":        strike,
                            "spot_price":          pricing["spot"],
                            "tau_hours":           tau_h,
                            "model_prob":          pricing["model_prob"],
                            "devigged_market_prob": pricing["market_prob"],
                            "edge":                pricing["edge"],
                            "realized_vol_ann":    pricing["sigma"],
                            "d2":                  pricing["d2"],
                            "expiry_ts":           exp_ts,
                            "momentum_5m":         pricing["momentum_5m"],
                        }
                        uid = f"{mkt['condition_id']}_{tau_h}"
                        log_evaluation(uid, mkt["question"], result,
                                       signal_fired=abs(pricing["edge"]) >= 0.03)

                        with _conn() as c:
                            c.execute(
                                """UPDATE evaluations
                                   SET outcome=?, resolved_spot=?, resolved_ts=?
                                   WHERE market_id=? AND outcome IS NULL""",
                                (outcome, float(strike), time.time(), uid),
                            )
                        count += 1

                    return count
                except Exception as exc:
                    errors += 1
                    log.debug("backtest error %s: %s",
                              mkt.get("condition_id", "?")[:8], exc)
                    return 0

        tasks = [_process_one(m) for m in with_outcome]
        results = await asyncio.gather(*tasks)
        logged = sum(results)

        print(f"      {_c(GRN, str(logged))} data points logged  "
              f"| {errors} errors  |  elapsed {time.time()-t0:.1f}s")

    print(f"\n{_c(BLD, '[3/3] Model efficiency report:')}")
    print_report(min_resolved=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Backtest crypto binary signal")
    parser.add_argument("--limit", type=int,   default=300,
                        help="Max markets to fetch from CLOB")
    parser.add_argument("--tau",   type=float, nargs="+",
                        default=[24.0, 4.0, 1.0],
                        help="τ snapshots in hours (e.g. --tau 24 4 1)")
    args = parser.parse_args()

    asyncio.run(run_backtest(limit=args.limit, tau_hours_list=args.tau))
