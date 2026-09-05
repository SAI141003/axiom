"""
STOCKS BOT — $100 paper account, its own multi-factor logic, forward-tested.

Uses the exact factors that ranked #2-on-accuracy in our head-to-head vs the
industry (AQR momentum, etc.), combined into one conviction signal:
  • 12-month trend        (Moskowitz-Ooi-Pedersen 2012)   long the trend
  • 5-day reversal        (Jegadeesh 1990)                fade the last few days
  • Faber 50-day trend    (Faber 2007)                    long above the MA
  • Low-volatility        (Frazzini-Pedersen 2014)        favor calm names
→ p_up (logistic blend). Trades the HIGH-CONVICTION names long/short, $10 each,
up to 10 concurrent on a $100 book, 3-trading-day hold, marked daily.

HONEST expectation: stock DIRECTION is near-efficient — this will likely land near
break-even, maybe modestly +/−. The 5-day account is the real answer, not a promise.

Log: logs/stocks_bot.jsonl  ·  Run: launchd com.polymarket.dryrun.stocksbot
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "signals"))
from earnings_engine import _get, logistic

LOG = ROOT / "logs" / "stocks_bot.jsonl"
ET = ZoneInfo("America/New_York")
STAKE = 10.0
MAX_POS = 10
HOLD_DAYS = 3
CONVICTION = 0.06

WATCH = ["NVDA", "AAPL", "MSFT", "AMD", "GOOGL", "META", "TSLA", "AMZN", "JPM",
         "NFLX", "AVGO", "COST", "ORCL", "DIS", "UBER", "NKE"]


def _rows():
    return [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []


def _write(rec):
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def closes(sym: str) -> list[float]:
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1y&interval=1d")
        return [c for c in j["chart"]["result"][0]["indicators"]["quote"][0]["close"] if c is not None]
    except Exception:
        return []


def signal(c: list[float]) -> float | None:
    """Multi-factor p_up — the benchmarked ensemble."""
    if len(c) < 60:
        return None
    price = c[-1]
    rets = [c[i] / c[i - 1] - 1 for i in range(1, len(c))]
    mom12 = price / c[-252] - 1 if len(c) >= 252 else price / c[0] - 1
    ret5 = price / c[-6] - 1 if len(c) >= 6 else 0.0
    sma50 = sum(c[-50:]) / 50
    rvol = statistics.pstdev(rets[-10:]) if len(rets) >= 10 else 0.02
    hvol = statistics.pstdev(rets) if len(rets) >= 2 else 0.02
    logit = math.log(0.53 / 0.47)
    logit += 0.50 * (1 if mom12 > 0 else -1)             # 12m trend (Moskowitz)
    logit += -2.0 * max(-0.06, min(0.06, ret5))          # 5d reversal (Jegadeesh)
    logit += 0.30 * (1 if price > sma50 else -1)         # Faber 50d trend
    logit += 0.20 * (1 if rvol < hvol else -1)           # low-vol (Frazzini-Pedersen)
    return logistic(logit)


def price_now(sym: str) -> float | None:
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d")
        return j["chart"]["result"][0]["meta"].get("regularMarketPrice")
    except Exception:
        return None


def cycle():
    rows = _rows()
    today = datetime.now(ET).strftime("%Y-%m-%d")
    now = time.time()
    closed_ids = {r["id"] for r in rows if r["type"] == "sclose"}
    open_pos = [r for r in rows if r["type"] == "sentry" and r["id"] not in closed_ids]
    held = {p["symbol"] for p in open_pos}

    # 1) mark + close matured positions
    for p in open_pos:
        px = price_now(p["symbol"])
        if px is None:
            continue
        held_days = (now - p["ts"]) / 86400
        if held_days >= HOLD_DAYS:
            ret = px / p["entry"] - 1
            pnl = round(STAKE * (ret if p["side"] == "LONG" else -ret), 2)
            _write({"type": "sclose", "id": p["id"], "symbol": p["symbol"],
                    "side": p["side"], "exit": px, "pnl": pnl, "won": (pnl > 0),
                    "ts": int(now)})
            held.discard(p["symbol"])
            print(f"[stocks-bot] CLOSE {p['symbol']} {p['side']} → {pnl:+.2f}", flush=True)
        time.sleep(0.2)

    # 2) open new high-conviction positions (up to MAX_POS)
    slots = MAX_POS - len([p for p in open_pos if p["symbol"] in held])
    if slots <= 0:
        return
    cands = []
    for sym in WATCH:
        if sym in held:
            continue
        c = closes(sym)
        p_up = signal(c)
        if p_up is None:
            continue
        conv = abs(p_up - 0.5)
        if conv >= CONVICTION:
            cands.append((conv, sym, p_up, c[-1]))
        time.sleep(0.2)
    cands.sort(reverse=True)                              # highest conviction first
    for conv, sym, p_up, px in cands[:slots]:
        side = "LONG" if p_up >= 0.5 else "SHORT"
        _write({"type": "sentry", "id": f"{today}-{sym}", "date": today, "symbol": sym,
                "side": side, "entry": px, "p_up": round(p_up, 3),
                "conviction": round(conv, 3), "ts": int(now)})
        print(f"[stocks-bot] OPEN {sym} {side} @ {px} (p_up {p_up:.2f})", flush=True)


def main():
    print("[stocks-bot] started — $100 paper book, multi-factor long/short", flush=True)
    while True:
        n = datetime.now(ET)
        if n.weekday() < 5 and 10 <= n.hour <= 16:
            try:
                cycle()
            except Exception as e:
                print(f"[stocks-bot] error: {e}", flush=True)
        time.sleep(3 * 3600)                              # a few times per session


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        cycle()
    else:
        main()
