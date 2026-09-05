"""
crypto_sim.py — Live paper trading on Polymarket 5-min crypto binary markets.

No LLM, no Redis, no PostgreSQL required — pure quantitative:
  • Fetches ALL active BTC/ETH/SOL/DOGE binary markets from Gamma API
  • Gets real-time spot prices + realized vol from Binance public REST
  • Prices each market with Black-Scholes (PATH F) + Heston calibration
  • Checks oracle lag window (last 45s before Chainlink snapshot)
  • Shows virtual trades: what would be entered, size, expected P&L

Usage:
  python crypto_sim.py                       # single snapshot
  python crypto_sim.py --watch               # loop every 30s
  python crypto_sim.py --min-edge 0.03 --bankroll 1000
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Optional

import aiohttp

logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")
log = logging.getLogger("crypto_sim")

from core.config import cfg
from core.models import Market
from signals.crypto_binary_signal import forecast as crypto_forecast, _parse_asset, _parse_direction, _parse_strike
from match.oracle_lag import _spot_move_pct, push_spot_tick

# ── Colors ────────────────────────────────────────────────────────────────────

RST  = "\033[0m"
GRN  = "\033[92m"
RED  = "\033[91m"
YLW  = "\033[93m"
CYN  = "\033[96m"
BLD  = "\033[1m"
DIM  = "\033[2m"

def _c(col, txt):
    return f"{col}{txt}{RST}"


# ── Fetch live crypto markets from Gamma API ──────────────────────────────────

async def fetch_crypto_markets(session: aiohttp.ClientSession) -> list[Market]:
    """
    Fetch all active crypto binary markets from Polymarket Gamma API.
    No volume filter — we want every 5-min BTC/ETH/SOL window open right now.
    """
    from ingest.market_watcher import _infer_category, _detect_linked_asset
    import json as _json

    CRYPTO_KEYWORDS = ("btc", "bitcoin", "eth", "ethereum", "sol", "solana",
                       "doge", "xrp", "avax", "bnb", "link", "matic", "crypto")

    markets: list[Market] = []
    try:
        async with session.get(
            f"{cfg.polymarket_gamma_api}/markets",
            params={"active": "true", "closed": "false", "limit": 500,
                    "order": "volume", "ascending": "false"},
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            resp.raise_for_status()
            data = await resp.json()
    except Exception as exc:
        print(_c(RED, f"  Gamma API error: {exc}"))
        return []

    now = time.time()
    for item in data:
        try:
            question = item.get("question", "").lower()
            if not any(kw in question for kw in CRYPTO_KEYWORDS):
                continue

            prices     = _json.loads(item.get("outcomePrices", "[0.5,0.5]"))
            yes_price  = float(prices[0]) if prices else 0.5
            no_price   = float(prices[1]) if len(prices) > 1 else 1 - yes_price
            end_date   = item.get("endDate", "")
            linked     = _detect_linked_asset(item.get("question", ""))
            if not linked:
                continue

            # Parse expiry — filter to markets resolving within 72 hours
            exp_ts = None
            if end_date:
                try:
                    dt = datetime.fromisoformat(end_date.replace("Z", "+00:00"))
                    exp_ts = dt.timestamp()
                    tau_h = (exp_ts - now) / 3600
                    if tau_h < 0 or tau_h > 72:
                        continue
                except Exception:
                    pass

            tokens = []
            for t in item.get("tokens", []):
                tokens.append({
                    "token_id": t.get("token_id", t.get("tokenId", "")),
                    "outcome":  t.get("outcome", "YES"),
                })

            market = Market(
                condition_id = item.get("conditionId", item.get("condition_id", "")),
                question     = item.get("question", ""),
                category     = "crypto",
                yes_price    = yes_price,
                no_price     = no_price,
                volume       = float(item.get("volume", 0)),
                end_date     = end_date,
                active       = True,
                tokens       = tokens,
                linked_asset = linked,
            )
            if market.condition_id and 0.02 < yes_price < 0.98:
                markets.append(market)
        except Exception:
            pass

    return markets


# ── Fetch current spot prices from Binance ────────────────────────────────────

async def fetch_spot_prices(
    session: aiohttp.ClientSession,
    assets: set[str],
) -> dict[str, float]:
    """Return {asset: spot_price} for all requested assets."""
    from signals.crypto_binary_signal import ASSET_SYMBOL
    prices: dict[str, float] = {}
    tasks = []
    sym_to_asset: dict[str, str] = {}
    for asset in assets:
        sym = ASSET_SYMBOL.get(asset.upper())
        if sym:
            sym_to_asset[sym] = asset.upper()
            tasks.append(_fetch_one_price(session, sym))

    results = await asyncio.gather(*tasks, return_exceptions=True)
    for sym, result in zip(sym_to_asset.keys(), results):
        if isinstance(result, float):
            prices[sym_to_asset[sym]] = result
    return prices


async def _fetch_one_price(session: aiohttp.ClientSession, symbol: str) -> float:
    try:
        async with session.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": symbol},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as r:
            d = await r.json()
            return float(d["price"])
    except Exception:
        return 0.0


# ── Oracle lag check ──────────────────────────────────────────────────────────

def _oracle_lag_status(market: Market, spot_price: float) -> Optional[str]:
    """
    Return a string describing oracle lag opportunity, or None.
    Active in final 45s before window close.
    """
    if not market.end_date:
        return None
    try:
        dt  = datetime.fromisoformat(market.end_date.replace("Z", "+00:00"))
        secs_left = (dt.timestamp() - time.time())
        if secs_left < cfg.oracle_lag_execution_cutoff_s:
            return None
        if secs_left > cfg.oracle_lag_window_s:
            return None
        # Feed a fake spot tick so _spot_move_pct works
        asset = (market.linked_asset or "BTC").upper()
        push_spot_tick(asset, spot_price)
        move = _spot_move_pct(asset, cfg.oracle_lag_window_s)
        if move is None or abs(move) < cfg.oracle_lag_min_move:
            return None
        direction = "UP" if move > 0 else "DOWN"
        return f"ORACLE LAG {direction} {secs_left:.0f}s left  spot_move={move*100:+.2f}%"
    except Exception:
        return None


# ── Main sim ──────────────────────────────────────────────────────────────────

async def run_crypto_sim(
    min_edge: float = 0.03,
    bankroll: float = 1_000.0,
) -> None:
    t0 = time.time()

    sep = "═" * 64
    print(f"\n{_c(BLD+CYN, sep)}")
    print(_c(BLD+CYN, "  POLYMARKET HFT — CRYPTO 5-MIN PAPER SIM"))
    print(_c(BLD+CYN, f"  {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}  |  bankroll=${bankroll:,.0f}  |  min_edge={min_edge:.2%}"))
    print(_c(BLD+CYN, sep))

    async with aiohttp.ClientSession() as session:

        # 1. Fetch crypto markets
        print(f"\n{_c(BLD, '[1/3] Fetching live crypto markets...')}", flush=True)
        markets = await fetch_crypto_markets(session)
        if not markets:
            print(_c(RED, "  No crypto markets returned. Check network."))
            return
        assets = {(m.linked_asset or "BTC").upper() for m in markets}
        print(f"      {_c(GRN, str(len(markets)))} active crypto markets  |  assets: {', '.join(sorted(assets))}")

        # 2. Fetch live spot prices
        print(f"\n{_c(BLD, '[2/3] Fetching Binance spot prices...')}", flush=True)
        spot_prices = await fetch_spot_prices(session, assets)
        if not spot_prices:
            print(_c(RED, "  Binance API unreachable."))
            return
        for asset, price in sorted(spot_prices.items()):
            print(f"      {_c(CYN, asset):>8s}  ${price:>12,.2f}")

    # 3. Run Black-Scholes model on each market
    print(f"\n{_c(BLD, '[3/3] Pricing with Black-Scholes (crypto_binary_signal)...')}", flush=True)

    sem = asyncio.Semaphore(8)   # 8 concurrent Binance calls (all public, no auth)

    async def _eval(market: Market):
        async with sem:
            try:
                return await asyncio.wait_for(crypto_forecast(market), timeout=15.0)
            except Exception:
                return None

    results_raw = await asyncio.gather(*[_eval(m) for m in markets], return_exceptions=True)

    # Log every evaluation to tracker (calibration data)
    from testing.tracker import log_evaluation
    for market, result in zip(markets, results_raw):
        if result and not isinstance(result, Exception):
            log_evaluation(market.condition_id, market.question, result, signal_fired=False)

    # Pair markets with results and filter
    signals: list[tuple[Market, object, Optional[str]]] = []
    skipped = 0
    for market, result in zip(markets, results_raw):
        if not result or isinstance(result, Exception):
            skipped += 1
            continue
        if abs(result.edge) < min_edge:
            skipped += 1
            continue
        # Re-log as signal_fired=True for this one
        log_evaluation(market.condition_id, market.question, result, signal_fired=True)
        spot = spot_prices.get((market.linked_asset or "BTC").upper(), 0.0)
        oracle_note = _oracle_lag_status(market, spot)
        signals.append((market, result, oracle_note))

    # Sort: oracle lag first (time-critical), then by |edge| descending
    signals.sort(key=lambda x: (x[2] is None, -abs(x[1].edge)))

    elapsed = time.time() - t0

    # ── Print results ─────────────────────────────────────────────────────────
    print(f"\n{'─'*64}")
    total_expo = 0.0

    if not signals:
        print(_c(YLW, f"  No signals above {min_edge:.0%} edge. ({skipped} markets priced, none had sufficient edge)"))
        print(_c(DIM, "  Normal in sideways markets — model sees no clear mispricing."))
    else:
        print(_c(BLD, f"  SIGNALS — {len(signals)} opportunities  ({skipped} below threshold)\n"))

        for market, result, oracle_note in signals:
            r      = result
            pm     = r.devigged_market_prob
            side   = "YES" if r.edge > 0 else "NO"
            edge_c = GRN if r.edge > 0 else RED

            # Kelly fraction uses correct denominator for each bet direction
            if side == "YES":
                kelly = min(cfg.kelly_max, r.edge / max(0.01, 1 - pm) * cfg.kelly_base)
            else:
                kelly = min(cfg.kelly_max, abs(r.edge) / max(0.01, pm) * cfg.kelly_base)

            max_bet = cfg.btc_max_bet_usd if "BTC" in (market.linked_asset or "") else cfg.max_bet_usd
            size    = round(min(max_bet, bankroll * kelly), 2)
            total_expo += size

            # Expected P&L per trade
            if side == "YES":
                win_pnl  = size * (1 - pm) / pm
                ev       = r.model_prob * win_pnl - (1 - r.model_prob) * size
            else:
                win_pnl  = size * pm / (1 - pm)
                ev       = (1 - r.model_prob) * win_pnl - r.model_prob * size

            # Time to expiry
            tau_str = f"{r.tau_hours*60:.0f}m" if r.tau_hours < 1 else f"{r.tau_hours:.1f}h"

            # Oracle lag badge
            lag_badge = _c(YLW + BLD, "  ⚡ ORACLE LAG") if oracle_note else ""

            print(f"  {_c(BLD, '●')} {_c(edge_c, side):6s}  {_c(BLD, market.question[:58])}")
            if oracle_note:
                print(f"    {_c(YLW+BLD, oracle_note)}")
            print(
                f"    {r.asset}  spot=${r.spot_price:,.2f}  strike=${r.strike_price:,.0f}  "
                f"τ={tau_str}  σ={r.realized_vol_ann:.0%}"
            )
            print(
                f"    model_p={_c(CYN, f'{r.model_prob:.3f}')}  "
                f"market_p={_c(DIM, f'{r.devigged_market_prob:.3f}')}  "
                f"edge={_c(edge_c, f'{r.edge:+.3f}')}  "
                f"conf={r.confidence:.2f}  "
                f"momo5m={r.momentum_5m:+.2%}"
            )
            print(
                f"    {_c(GRN, f'→ risk ${size:.2f}')}  "
                f"win=+${win_pnl:.2f}  EV={_c(GRN if ev > 0 else RED, f'${ev:+.2f}')}  "
                f"kelly={kelly:.3f}  vol=${market.volume:,.0f}{lag_badge}"
            )
            print()

        print(f"  Total virtual exposure: {_c(BLD, f'${total_expo:.2f}')} "
              f"/ bankroll ${bankroll:,.0f} "
              f"({total_expo/bankroll*100:.1f}%)")

    # ── Resolve any expired markets + show efficiency report ──────────────────
    from testing.tracker import resolve_outcomes, print_report
    newly_resolved = await resolve_outcomes(lookback_hours=8.0)

    # ── Summary footer ─────────────────────────────────────────────────────────
    print(f"\n{'─'*64}")
    now_ts = datetime.now().strftime('%H:%M:%S')
    print(f"  Markets evaluated : {len(markets)}")
    print(f"  Signals fired     : {len(signals)}")
    print(f"  Skipped (low edge): {skipped}")
    print(f"  Newly resolved    : {newly_resolved}")
    print(f"  Elapsed           : {elapsed:.1f}s")
    print(f"  Timestamp         : {now_ts}  DRY_RUN={_c(GRN, 'true') if cfg.dry_run else _c(RED, 'FALSE — LIVE')}")
    print(_c(BLD+CYN, sep))
    print()

    print_report(min_resolved=5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Polymarket HFT — crypto 5-min paper sim")
    parser.add_argument("--min-edge",  type=float, default=0.03,    help="Minimum edge to show")
    parser.add_argument("--bankroll",  type=float, default=1_000.0, help="Virtual bankroll $")
    parser.add_argument("--watch",     action="store_true",         help="Loop every 30s")
    parser.add_argument("--interval",  type=int,   default=30,      help="Watch interval (seconds)")
    parser.add_argument("--report",    action="store_true",         help="Print efficiency report and exit")
    parser.add_argument("--resolve",   action="store_true",         help="Resolve pending outcomes and exit")
    args = parser.parse_args()

    if args.report:
        from testing.tracker import print_report
        print_report(min_resolved=1)
        raise SystemExit(0)

    if args.resolve:
        async def _resolve():
            from testing.tracker import resolve_outcomes, print_report
            n = await resolve_outcomes(lookback_hours=24.0)
            print(f"Resolved {n} outcomes.")
            print_report(min_resolved=1)
        asyncio.run(_resolve())
        raise SystemExit(0)

    async def _main():
        while True:
            await run_crypto_sim(min_edge=args.min_edge, bankroll=args.bankroll)
            if not args.watch:
                break
            print(_c(DIM, f"  Next update in {args.interval}s...  (Ctrl+C to stop)\n"))
            await asyncio.sleep(args.interval)

    try:
        asyncio.run(_main())
    except KeyboardInterrupt:
        print("\nStopped.")
