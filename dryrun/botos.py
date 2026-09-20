"""
BOT OS — user-made bots, described not coded.

A bot is a JSON spec in .data/bots/<id>.json. One runner (this file) loads every
enabled spec each cycle and trades it on paper exactly the way the strategy bot
trades: real OHLCV through the CCXT adapter, the evaluator blend as the signal,
a $100 book, no keys, no real money. JARVIS's create_bot tool and the /bots page
both write specs; nothing here generates code, so a bad description cannot
break the desk -- it can only make a bot that loses paper money and gets
retired.

Spec:
  {"id": "eth-momentum", "name": "ETH momentum", "enabled": true,
   "universe": ["ETH/USD"], "timeframe": "1d",
   "weights": {"momentum": 1.0, "rsi": 0.8}, "enter": 0.15, "exit": 0.05,
   "stake": 20.0, "max_pos": 2, "fee_bps": 10, "max_hold_bars": 0,
   "note": "what the user asked for, verbatim", "created": 1789900000}

  python dryrun/botos.py            # run forever (launchd)
  python dryrun/botos.py once       # one cycle
  python dryrun/botos.py validate '{...spec...}'
"""
from __future__ import annotations

import json
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from execution import ccxt_adapter
from signals.evaluators import TradingMode, build_strategy, _registry

SPECS = ROOT / ".data" / "bots"
LOGS = ROOT / "logs"
ET = ZoneInfo("America/New_York")
TIMEFRAMES = {"1h": 3600, "4h": 4 * 3600, "1d": 24 * 3600}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")


def validate(spec: dict) -> dict:
    """Return a clean spec or raise ValueError with a human reason."""
    known = set(_registry().keys())
    sid = str(spec.get("id", "")).strip().lower()
    if not ID_RE.match(sid):
        raise ValueError("id must be 2-40 chars of a-z, 0-9, dash")
    universe = [str(s).upper().strip() for s in spec.get("universe", []) if str(s).strip()]
    if not universe or len(universe) > 8:
        raise ValueError("universe needs 1-8 symbols like BTC/USD")
    for s in universe:
        if not re.match(r"^[A-Z0-9]{2,10}/[A-Z]{3,5}$", s):
            raise ValueError(f"bad symbol {s!r}; use BASE/QUOTE like ETH/USD")
    tf = str(spec.get("timeframe", "1d"))
    if tf not in TIMEFRAMES:
        raise ValueError("timeframe must be 1h, 4h or 1d (the edge is daily; intraday is a research bet)")
    weights = {str(k): float(v) for k, v in (spec.get("weights") or {}).items() if float(v) > 0}
    bad = sorted(set(weights) - known)
    if bad or not weights:
        raise ValueError(f"weights must use only {sorted(known)}; unknown: {bad}" if bad else f"weights needs at least one of {sorted(known)}")
    if any(not (0 <= v <= 1.5) for v in weights.values()):
        raise ValueError("each weight must be between 0 and 1.5")
    enter, exit_ = float(spec.get("enter", 0.15)), float(spec.get("exit", 0.05))
    if not (0.05 <= enter <= 0.5) or not (0 <= exit_ < enter):
        raise ValueError("enter must be 0.05-0.5 and exit below enter")
    stake = float(spec.get("stake", 20.0))
    if not (5 <= stake <= 50):
        raise ValueError("stake must be $5-$50 of the $100 paper book")
    max_pos = int(spec.get("max_pos", 3))
    if not (1 <= max_pos <= 5) or stake * max_pos > 100:
        raise ValueError("max_pos 1-5 and stake x max_pos may not exceed the $100 book")
    return {"id": sid, "name": str(spec.get("name") or sid)[:60], "enabled": bool(spec.get("enabled", True)),
            "universe": universe, "timeframe": tf, "weights": weights, "enter": enter, "exit": exit_,
            "stake": stake, "max_pos": max_pos, "fee_bps": int(spec.get("fee_bps", 10)),
            "max_hold_bars": int(spec.get("max_hold_bars", 0)), "note": str(spec.get("note", ""))[:400],
            "created": int(spec.get("created") or time.time())}


def load_specs() -> list[dict]:
    out = []
    for f in sorted(SPECS.glob("*.json")):
        try:
            out.append(validate(json.loads(f.read_text())))
        except Exception as e:
            print(f"[botos] skip {f.name}: {e}", flush=True)
    return out


def save_spec(spec: dict) -> dict:
    clean = validate(spec)
    SPECS.mkdir(parents=True, exist_ok=True)
    (SPECS / f"{clean['id']}.json").write_text(json.dumps(clean, indent=1))
    return clean


def _log(sid: str) -> Path:
    return LOGS / f"specbot_{sid}.jsonl"


def _rows(sid: str) -> list[dict]:
    p = _log(sid)
    return [json.loads(l) for l in p.open() if l.strip()] if p.exists() else []


def _write(sid: str, rec: dict) -> None:
    LOGS.mkdir(exist_ok=True)
    with _log(sid).open("a") as f:
        f.write(json.dumps(rec) + "\n")


def account(sid: str, start: float = 100.0) -> dict:
    """Paper book for one bot, walked with the same loss floor as the fleet."""
    rows = _rows(sid)
    closes = sorted((r for r in rows if r["type"] == "sclose"), key=lambda r: r["ts"])
    acct, taken = start, []
    for c in closes:
        if acct <= 0:
            break
        acct = max(0.0, acct + c["pnl"]); taken.append(c)
    closed = {r["id"] for r in rows if r["type"] == "sclose"}
    open_pos = [r for r in rows if r["type"] == "sentry" and r["id"] not in closed]
    wins = sum(1 for c in taken if c["won"])
    return {"account": round(acct, 2), "pnl": round(acct - start, 2), "trades": len(taken), "wins": wins,
            "win_rate": round(wins / len(taken), 3) if taken else None, "open": open_pos,
            "recent": [{"sym": c["sym"], "pnl": c["pnl"], "reason": c.get("reason", "signal"), "ts": c["ts"]} for c in taken[-8:]][::-1]}


def _ctx(symbol: str, tf: str) -> dict | None:
    candles = ccxt_adapter.fetch_ohlcv(symbol, tf, 200)
    if len(candles) < 60:
        return None
    return {"close": [c[4] for c in candles], "high": [c[2] for c in candles],
            "low": [c[3] for c in candles], "volume": [c[5] for c in candles]}


def run_bot(spec: dict) -> None:
    sid = spec["id"]
    rows = _rows(sid)
    closed = {r["id"] for r in rows if r["type"] == "sclose"}
    open_pos = {r["sym"]: r for r in rows if r["type"] == "sentry" and r["id"] not in closed}
    tm = TradingMode(build_strategy(spec["weights"], sid), spec["enter"], spec["exit"])
    fee = spec["fee_bps"] / 10_000
    now = int(time.time()); today = datetime.now(ET).strftime("%Y-%m-%d")
    bar_s = TIMEFRAMES[spec["timeframe"]]

    for sym, p in list(open_pos.items()):
        ctx = _ctx(sym, spec["timeframe"])
        if not ctx:
            continue
        d = tm.decide(ctx, "LONG")
        held_bars = (now - p["ts"]) / bar_s
        timed_out = spec["max_hold_bars"] and held_bars >= spec["max_hold_bars"]
        if d["action"] == "CLOSE" or timed_out:
            px = ccxt_adapter.ticker(sym) or ctx["close"][-1]
            pnl = round(p["stake"] * (px / p["entry"] - 1) - 2 * fee * p["stake"], 2)
            _write(sid, {"type": "sclose", "id": p["id"], "sym": sym, "exit": px, "pnl": pnl, "won": pnl > 0,
                         "net": d["net"], "reason": "max-hold" if timed_out else "signal", "ts": now})
            del open_pos[sym]
            print(f"[botos:{sid}] EXIT {sym} @ {px} -> {pnl:+.2f}", flush=True)

    slots = spec["max_pos"] - len(open_pos)
    for sym in spec["universe"]:
        if slots <= 0:
            break
        if sym in open_pos:
            continue
        ctx = _ctx(sym, spec["timeframe"])
        if not ctx:
            continue
        d = tm.decide(ctx, "FLAT")
        if d["action"] == "LONG":
            px = ccxt_adapter.ticker(sym) or ctx["close"][-1]
            _write(sid, {"type": "sentry", "id": f"{now}-{sym.replace('/', '')}", "date": today, "sym": sym,
                         "entry": px, "stake": spec["stake"], "net": d["net"], "ts": now})
            slots -= 1
            print(f"[botos:{sid}] BUY {sym} @ {px} (net {d['net']})", flush=True)


def cycle() -> None:
    specs = [s for s in load_specs() if s["enabled"]]
    if not specs:
        print("[botos] no enabled bots", flush=True)
    for spec in specs:
        try:
            run_bot(spec)
        except Exception as e:
            print(f"[botos:{spec['id']}] error: {e}", flush=True)


def main() -> None:
    print("[botos] started — user-made paper bots from .data/bots/*.json", flush=True)
    while True:
        try:
            cycle()
        except Exception as e:
            print(f"[botos] error: {e}", flush=True)
        time.sleep(3600)          # hourly: fine for 1h bots, generous for daily ones


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "validate":
        try:
            print(json.dumps({"ok": True, "spec": validate(json.loads(sys.argv[2]))}))
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
    elif len(sys.argv) > 1 and sys.argv[1] == "once":
        cycle()
    else:
        main()
