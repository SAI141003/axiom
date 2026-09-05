"""
Dry validation of the 5-minute Up/Down auto-trader against REAL Polymarket data.

For each recently RESOLVED {asset}-updown-5m-{ts} event:
  1. Actual outcome from Gamma (outcomePrices ["1","0"] = Up won)
  2. Real entry price from CLOB prices-history (first tick in entry window)
  3. Signal replayed from Binance 1m klines as of the window open:
       momentum  = (close[-1] - EMA3(closes)) / EMA3   (≈ live 60s-vs-180s EMA)
       persist   = mean direction of last 3 closed 5m windows
       score     = 0.7*clamped_momentum + 0.3*persist ; |score| > 0.25 → trade
  4. P&L at $10 stakes with the real entry price, CLOB fee curve deducted
  5. Binance-proxy resolution vs actual Chainlink resolution agreement

Usage: .venv/bin/python backtest/validate_5m_live.py [n_windows]
"""
from __future__ import annotations

import asyncio
import json
import sys
import time

import aiohttp

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
BINANCE = "https://api.binance.com"

ASSETS = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT", "xrp": "XRPUSDT"}
STAKE = 10.0
SCORE_THRESHOLD = 0.25
MAX_SIDE_PX = 0.62
ENTRY_CUTOFF_S = 90          # same as live engine: enter in first 90s
SEM = asyncio.Semaphore(8)


def clob_fee(p: float) -> float:
    """Polymarket CLOB v2 crypto taker fee: 1.8% peak x 4p(1-p)."""
    return 0.018 * 4.0 * p * (1.0 - p)


async def jget(s: aiohttp.ClientSession, url: str, **kw):
    async with SEM:
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=15), **kw) as r:
                if r.status != 200:
                    return None
                return await r.json()
        except Exception:
            return None


async def fetch_window(s: aiohttp.ClientSession, asset: str, ts: int):
    """Return dict with actual outcome + real entry prices, or None."""
    ev = await jget(s, f"{GAMMA}/events", params={"slug": f"{asset}-updown-5m-{ts}"})
    if not ev:
        return None
    try:
        m = ev[0]["markets"][0]
        if not m.get("closed"):
            return None
        prices = json.loads(m["outcomePrices"])
        up_won = float(prices[0]) > 0.5
        token_up = json.loads(m["clobTokenIds"])[0]
    except Exception:
        return None

    hist = await jget(
        s, f"{CLOB}/prices-history",
        params={"market": token_up, "startTs": ts, "endTs": ts + 300, "fidelity": 1},
    )
    if not hist or not hist.get("history"):
        return None
    entry_ticks = [p for p in hist["history"] if p["t"] - ts <= ENTRY_CUTOFF_S]
    if not entry_ticks:
        return None
    up_entry = float(entry_ticks[0]["p"])

    return {"asset": asset, "ts": ts, "up_won": up_won,
            "up_entry": up_entry, "down_entry": round(1.0 - up_entry, 4)}


def replay_signal(klines: list, ts: int, recent_dirs: list[int]) -> tuple[str | None, float]:
    """Signal as of window open, using only data BEFORE ts (no lookahead)."""
    closes = [float(k[4]) for k in klines if k[6] <= ts * 1000]  # closed before ts
    if len(closes) < 5:
        return None, 0.0
    ema3 = closes[-3]
    for c in closes[-2:]:
        ema3 = ema3 + 0.5 * (c - ema3)
    momentum = (closes[-1] - ema3) / ema3
    persist = sum(recent_dirs[-3:]) / max(1, len(recent_dirs[-3:])) if recent_dirs else 0.0
    score = (1 if momentum >= 0 else -1) * min(1.0, abs(momentum) * 8000) * 0.7 + persist * 0.3
    if score > SCORE_THRESHOLD:
        return "UP", score
    if score < -SCORE_THRESHOLD:
        return "DOWN", score
    return None, score


async def main(n_windows: int = 120) -> None:
    now_ts = int(time.time() // 300) * 300
    window_ts = [now_ts - (k + 2) * 300 for k in range(n_windows)]  # skip last 2 (may be unresolved)
    t0, t1 = min(window_ts) - 3600, max(window_ts) + 300

    async with aiohttp.ClientSession() as s:
        # Binance 1m klines per asset — paginated (1000-bar API limit per call)
        kl: dict[str, list] = {}
        for a, sym in ASSETS.items():
            bars: list = []
            cursor = t0 * 1000
            while cursor < t1 * 1000:
                data = await jget(s, f"{BINANCE}/api/v3/klines",
                                  params={"symbol": sym, "interval": "1m",
                                          "startTime": cursor, "endTime": t1 * 1000, "limit": 1000})
                if not data:
                    break
                bars.extend(data)
                if len(data) < 1000:
                    break
                cursor = data[-1][6] + 1   # next ms after last close
            kl[a] = bars

        results = await asyncio.gather(*[
            fetch_window(s, a, ts) for a in ASSETS for ts in window_ts
        ])

    rows = [r for r in results if r]
    rows.sort(key=lambda r: r["ts"])

    # replay in chronological order per asset (persistence needs history)
    dirs: dict[str, list[int]] = {a: [] for a in ASSETS}
    trades = []
    binance_agree = 0
    binance_total = 0

    for r in rows:
        a, ts = r["asset"], r["ts"]

        # Binance-proxy resolution check (kline open vs close of the window)
        wk = [k for k in kl[a] if k[0] == ts * 1000 or (k[0] <= ts * 1000 < k[6])]
        wkl = [k for k in kl[a] if ts * 1000 <= k[0] < (ts + 300) * 1000]
        if len(wkl) >= 5:
            b_up = float(wkl[-1][4]) >= float(wkl[0][1])
            binance_total += 1
            binance_agree += int(b_up == r["up_won"])

        side, score = replay_signal(kl[a], ts, dirs[a])
        dirs[a].append(1 if r["up_won"] else -1)
        if side is None:
            continue
        entry = r["up_entry"] if side == "UP" else r["down_entry"]
        if not (0.01 < entry < MAX_SIDE_PX):
            continue
        won = (side == "UP") == r["up_won"]
        gross = STAKE * (1.0 / entry - 1.0) if won else -STAKE
        fee = STAKE * clob_fee(entry)
        trades.append({"asset": a, "ts": ts, "side": side, "entry": entry,
                       "score": round(score, 3), "won": won, "pnl": round(gross - fee, 2)})

    # ── Report ────────────────────────────────────────────────────────────────
    print(f"\n{'='*74}")
    print("DRY VALIDATION — 5-min Up/Down engine vs REAL resolved Polymarket data")
    print(f"{'='*74}")
    print(f"Resolved windows fetched: {len(rows)}  (target {n_windows} per asset x {len(ASSETS)})")
    print(f"Binance-proxy vs Chainlink resolution agreement: "
          f"{binance_agree}/{binance_total} = {100*binance_agree/max(1,binance_total):.1f}%")

    up_rate = sum(r["up_won"] for r in rows) / max(1, len(rows))
    print(f"Base rate (Up outcomes): {100*up_rate:.1f}%  — coin-flip baseline check")

    if not trades:
        print("\nSignal fired 0 trades in this span (quiet tape).")
        return

    n = len(trades)
    wins = sum(t["won"] for t in trades)
    pnl = sum(t["pnl"] for t in trades)
    fired_pct = 100 * n / max(1, len(rows))
    avg_entry = sum(t["entry"] for t in trades) / n
    be = avg_entry  # breakeven win rate ≈ avg entry price (binary payout)
    print(f"\nSignal fired: {n} trades on {len(rows)} windows ({fired_pct:.0f}%)")
    print(f"Win rate:     {wins}/{n} = {100*wins/n:.1f}%   "
          f"(breakeven at avg entry {100*be:.1f}¢ ≈ {100*be:.1f}%)")
    print(f"Net P&L:      ${pnl:+.2f} on ${n*STAKE:.0f} staked "
          f"({100*pnl/(n*STAKE):+.1f}% ROI, CLOB fees included)")

    per: dict[str, list] = {}
    for t in trades:
        per.setdefault(t["asset"], []).append(t)
    print(f"\n{'asset':<6}{'trades':>7}{'wins':>6}{'WR%':>7}{'P&L':>10}")
    for a, ts_ in sorted(per.items()):
        w = sum(t["won"] for t in ts_)
        p = sum(t["pnl"] for t in ts_)
        print(f"{a:<6}{len(ts_):>7}{w:>6}{100*w/len(ts_):>6.1f}%{p:>+9.2f}$")

    print(f"\nLast 8 trades:")
    for t in trades[-8:]:
        when = time.strftime("%H:%M", time.localtime(t["ts"]))
        print(f"  {when} {t['asset'].upper():<4} {t['side']:<5} @ {t['entry']:.3f} "
              f"score={t['score']:+.2f} → {'WON ' if t['won'] else 'LOST'} {t['pnl']:+.2f}$")


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 120
    asyncio.run(main(n))
