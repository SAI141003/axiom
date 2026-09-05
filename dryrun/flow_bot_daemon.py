"""
FLOW BOT — $100 PAPER, trades the live order-flow tape (the top-trader way).

This is the honest answer to "it doesn't trade enough." Our daily strategy sits
flat because daily signals are rare — and our own backtest proved that forcing
daily signals to trade intraday just loses. The pros trade often because they read
ORDER FLOW: aggressive buy/sell imbalance (Ultra Delta), big prints, book depth.
So this bot trades that — the same tape, read live via CCXT — at intraday cadence.

  ENTRY  strong buy imbalance (bias > +0.25: CVD + big buyers + bid-heavy book) → LONG $30
  EXIT   flow flips (bias < -0.10) OR 90-min max hold → realize P&L
  $100 book, up to 3 positions, 8bps/side. Polls every 10 min.

HONEST: order flow is a real short-horizon edge (Cont-Kukanov-Stoikov 2014), but it
CANNOT be backtested for free (no tick history) — so this account earns trust by
forward-testing, in the open, no real money. If it bleeds, that's the truth about
retail-latency order-flow chasing; if it works, we'll have live receipts.
Log: logs/flow_bot.jsonl
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
from signals.intraday_flow import order_flow

LOG = ROOT / "logs" / "flow_bot.jsonl"
ET = ZoneInfo("America/New_York")
UNIVERSE = ["BTC/USD", "ETH/USD", "SOL/USD"]
STAKE = 30.0
MAX_POS = 3
FEE = 0.0008          # 8bps per side
ENTER_BIAS = 0.25
EXIT_BIAS = -0.10
MAX_HOLD_MIN = 90


def _rows() -> list[dict]:
    return [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []


def _write(rec: dict) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def cycle() -> None:
    rows = _rows()
    closed = {r["id"] for r in rows if r["type"] == "fclose"}
    open_pos = {r["sym"]: r for r in rows if r["type"] == "fentry" and r["id"] not in closed}
    now = time.time()
    today = datetime.now(ET).strftime("%Y-%m-%d")
    acted = False

    # 1) manage exits — flow flip or max hold
    for sym, p in list(open_pos.items()):
        f = order_flow(sym)
        px = ccxt_adapter.ticker(sym)
        if px is None:
            continue
        held_min = (now - p["ts"]) / 60
        bias = f["bias"] if f else 0.0
        if (f and bias < EXIT_BIAS) or held_min >= MAX_HOLD_MIN:
            gross = p["stake"] * (px / p["entry"] - 1)
            pnl = round(gross - 2 * FEE * p["stake"], 2)
            _write({"type": "fclose", "id": p["id"], "sym": sym, "exit": px, "pnl": pnl,
                    "won": pnl > 0, "bias": round(bias, 3),
                    "reason": "flow-flip" if (f and bias < EXIT_BIAS) else "max-hold", "ts": int(now)})
            del open_pos[sym]; acted = True
            print(f"[flow-bot] EXIT {sym} @ {px} → {pnl:+.2f} (bias {bias:+.2f})", flush=True)

    # 2) entries — strongest buy-flow symbols not held
    slots = MAX_POS - len(open_pos)
    if slots > 0:
        cands = []
        for sym in UNIVERSE:
            if sym in open_pos:
                continue
            f = order_flow(sym)
            if f and f["bias"] > ENTER_BIAS:
                cands.append((f["bias"], sym, f))
        cands.sort(reverse=True)
        for bias, sym, f in cands[:slots]:
            px = ccxt_adapter.ticker(sym)
            if px is None:
                continue
            _write({"type": "fentry", "id": f"{int(now)}-{sym.replace('/', '')}", "date": today,
                    "sym": sym, "entry": px, "stake": STAKE, "bias": round(bias, 3),
                    "cvd_ratio": f["cvd_ratio"], "big_trades": f["big_trades"], "ts": int(now)})
            acted = True
            print(f"[flow-bot] BUY {sym} @ {px} (bias {bias:+.2f}, CVD {f['cvd_ratio']*100:+.0f}%, {f['big_trades']} big)", flush=True)

    if not acted:
        print("[flow-bot] no flow strong enough — holding", flush=True)


def main() -> None:
    print("[flow-bot] started — $100 PAPER order-flow tape trader (no real money)", flush=True)
    while True:
        try:
            cycle()
        except Exception as e:
            print(f"[flow-bot] error: {e}", flush=True)
        time.sleep(600)          # every 10 min — order flow moves fast


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        cycle()
    else:
        main()
