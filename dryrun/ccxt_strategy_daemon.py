"""
CCXT STRATEGY BOT — $100 PAPER account trading the OctoBot-style evaluator blend.

Puts the whole new stack together on paper: real OHLCV via CCXT → the evaluator
Strategy → a position decision, on the DAILY timeframe where the backtest proved
the edge lives (BTC/ETH/SOL 1d were the only ★EDGE cells; intraday churns and
loses, so we don't touch it). NO real money, NO keys — the CCXT adapter's data
functions are public; accounting is simulated here.

  ENTRY  strategy says LONG on a flat symbol → open $30 at the live price
  EXIT   strategy says CLOSE (net decays back inside the exit band) → realize P&L
  $100 book, up to 3 positions, 10bps fee each side. Daily signals, so we poll
  every few hours — the bar barely moves intraday.

Honest expectation: this strategy is a downside-protector, not a bull-market hero
(it trailed a raging BTC bull while beating buy-&-hold in every down-fold). The
$100 account is the forward test of exactly that. Log: logs/ccxt_bot.jsonl
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from execution import ccxt_adapter
from signals.evaluators import default_strategy

LOG = ROOT / "logs" / "ccxt_bot.jsonl"
ET = ZoneInfo("America/New_York")
UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD"]   # the daily ★EDGE pairs only
STAKE = 30.0
MAX_POS = 3
FEE = 0.001            # 10bps per side


def _rows() -> list[dict]:
    return [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []


def _write(rec: dict) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _ctx(symbol: str) -> dict | None:
    candles = ccxt_adapter.fetch_ohlcv(symbol, "1d", 200)
    if len(candles) < 60:
        return None
    return {"close": [c[4] for c in candles], "high": [c[2] for c in candles],
            "low": [c[3] for c in candles], "volume": [c[5] for c in candles]}


def cycle() -> None:
    rows = _rows()
    closed = {r["id"] for r in rows if r["type"] == "sclose"}
    open_pos = {r["sym"]: r for r in rows if r["type"] == "sentry" and r["id"] not in closed}
    tm = default_strategy()
    now = int(time.time())
    today = datetime.now(ET).strftime("%Y-%m-%d")

    # 1) manage open positions — exit on CLOSE
    for sym, p in list(open_pos.items()):
        ctx = _ctx(sym)
        if not ctx:
            continue
        d = tm.decide(ctx, "LONG")
        if d["action"] == "CLOSE":
            px = ccxt_adapter.ticker(sym) or ctx["close"][-1]
            gross = p["stake"] * (px / p["entry"] - 1)
            pnl = round(gross - 2 * FEE * p["stake"], 2)
            _write({"type": "sclose", "id": p["id"], "sym": sym, "exit": px, "pnl": pnl,
                    "won": pnl > 0, "net": d["net"], "ts": now})
            del open_pos[sym]
            print(f"[ccxt-bot] EXIT {sym} @ {px} → {pnl:+.2f} (net {d['net']})", flush=True)

    # 2) open new positions on flat symbols that signal LONG
    slots = MAX_POS - len(open_pos)
    for sym in UNIVERSE:
        if slots <= 0:
            break
        if sym in open_pos:
            continue
        ctx = _ctx(sym)
        if not ctx:
            continue
        d = tm.decide(ctx, "FLAT")
        if d["action"] == "LONG":
            px = ccxt_adapter.ticker(sym) or ctx["close"][-1]
            _write({"type": "sentry", "id": f"{now}-{sym.replace('/', '')}", "date": today,
                    "sym": sym, "entry": px, "stake": STAKE, "net": d["net"],
                    "components": d["components"], "ts": now})
            slots -= 1
            print(f"[ccxt-bot] BUY {sym} @ {px} (net {d['net']})", flush=True)

    if not open_pos and slots == MAX_POS:
        print("[ccxt-bot] flat — no LONG signals this cycle", flush=True)


def main() -> None:
    print("[ccxt-bot] started — $100 PAPER, evaluator strategy on daily BTC/ETH/SOL (no real money)", flush=True)
    while True:
        try:
            cycle()
        except Exception as e:
            print(f"[ccxt-bot] error: {e}", flush=True)
        time.sleep(4 * 3600)          # daily signals — poll every 4h


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        cycle()
    else:
        main()
