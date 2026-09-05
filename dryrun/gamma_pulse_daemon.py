"""
GAMMA PULSE — $100 paper account, forward-tested.

Trades the ONE documented gamma effect as a clean, resolvable equity bet:
  • AMPLIFIED (short-gamma, spot < zero-γ): dealers amplify → MOMENTUM.
    follow the recent move (up → long, down → short).
  • DAMPENED (long-gamma, spot > zero-γ): dealers pin/hedge against → MEAN-REVERT.
    fade the recent move (up → short, down → long).
  — Barbon & Buraschi "Gamma Fragility"; SqueezeMetrics GEX.

$100 account, $10/paper-bet, one open bet per symbol at a time. Resolves on the
next trading day's close. Honest forward-test: this is UNPROVEN until the record
says otherwise — the whole point is to find out.

Log: logs/gamma_pulse_paper.jsonl  {type:"gentry"|"gresolve", ...}
Run: launchd com.polymarket.dryrun.gammapulse (scheduled ~hourly, market hours)
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "signals"))
from gamma_pulse import pulse, WATCH
from earnings_engine import _get

LOG = ROOT / "logs" / "gamma_pulse_paper.jsonl"
ET = ZoneInfo("America/New_York")
STAKE = 10.0


def _rows():
    return [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []


def _write(rec):
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def recent_return(sym: str) -> float | None:
    """5-day return (the 'recent move' the regime acts on) + current price."""
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1mo&interval=1d")
        c = [x for x in j["chart"]["result"][0]["indicators"]["quote"][0]["close"] if x is not None]
        return (c[-1] / c[-6] - 1) if len(c) >= 6 else None
    except Exception:
        return None


def close_now(sym: str) -> float | None:
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d")
        return j["chart"]["result"][0]["meta"].get("regularMarketPrice")
    except Exception:
        return None


def scan_and_trade():
    rows = _rows()
    today = datetime.now(ET).strftime("%Y-%m-%d")
    open_syms = {r["symbol"] for r in rows if r["type"] == "gentry" and not any(
        x["type"] == "gresolve" and x["id"] == r["id"] for x in rows)}
    traded_today = {r["symbol"] for r in rows if r["type"] == "gentry" and r.get("date") == today}

    for sym in WATCH:
        if sym in open_syms or sym in traded_today:
            continue
        p = pulse(sym)
        if not p:
            continue
        rr = recent_return(sym)
        if rr is None or abs(rr) < 0.005:            # need a real recent move to act on
            continue
        # regime → direction
        if p["short_gamma"]:                          # amplified → momentum
            side = "LONG" if rr > 0 else "SHORT"
        else:                                         # dampened → mean-revert
            side = "SHORT" if rr > 0 else "LONG"
        rec = {"type": "gentry", "id": f"{today}-{sym}", "date": today, "symbol": sym,
               "regime": p["regime"], "short_gamma": p["short_gamma"], "side": side,
               "entry": p["spot"], "recent_5d": round(rr, 4),
               "call_wall": p["call_wall"], "put_wall": p["put_wall"], "zero_gamma": p["zero_gamma"],
               "ts": int(time.time())}
        _write(rec)
        print(f"[gamma-pulse] {sym} {side} @ {p['spot']} ({p['regime']}, 5d {rr*100:+.1f}%)", flush=True)
        time.sleep(0.3)


def resolve_pending():
    rows = _rows()
    resolved = {r["id"] for r in rows if r["type"] == "gresolve"}
    now = time.time()
    for e in rows:
        if e["type"] != "gentry" or e["id"] in resolved:
            continue
        if now - e["ts"] < 22 * 3600:                # give it ~1 trading day
            continue
        px = close_now(e["symbol"])
        if px is None:
            continue
        ret = px / e["entry"] - 1
        won = (ret > 0) if e["side"] == "LONG" else (ret < 0)
        pnl = round(STAKE * (ret if e["side"] == "LONG" else -ret), 2)
        _write({"type": "gresolve", "id": e["id"], "symbol": e["symbol"],
                "won": bool(won), "pnl": pnl, "exit": px, "ret": round(ret, 4),
                "ts": int(now)})
        print(f"[gamma-pulse] {e['symbol']} {e['side']} → {'WON' if won else 'LOST'} {pnl:+.2f}", flush=True)
        time.sleep(0.3)


def main():
    print("[gamma-pulse] started — $100 paper account, forward-testing the gamma edge", flush=True)
    while True:
        now = datetime.now(ET)
        if now.weekday() < 5 and 10 <= now.hour <= 16:   # market hours
            try:
                resolve_pending()
                scan_and_trade()
            except Exception as e:
                print(f"[gamma-pulse] error: {e}", flush=True)
        else:
            try:
                resolve_pending()
            except Exception:
                pass
        time.sleep(3600)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        resolve_pending(); scan_and_trade()
    else:
        main()
