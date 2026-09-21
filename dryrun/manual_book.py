"""AXIOM's own hands: the manual paper book.

"Axiom, buy $20 of ETH" lands here. One $100 paper account, real prices at the
moment of the order (Kraken via CCXT for crypto, Yahoo for equities), marked to
market on every status call, closed at the real price. Every order is appended
to logs/manual_book.jsonl so brain.py scores it like any other book. Paper only:
this file has no route to an exchange and never will; live orders go through
the executor behind its two human switches.

  python dryrun/manual_book.py buy ETH/USD 20 "why"
  python dryrun/manual_book.py sell ETH/USD 20 "why"     (short, crypto only)
  python dryrun/manual_book.py close ETH/USD "why"
  python dryrun/manual_book.py status
"""
from __future__ import annotations
import json, sys, time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BOOK = ROOT / ".data" / "manual_book.json"
LOG = ROOT / "logs" / "manual_book.jsonl"
START = 100.0
MAX_STAKE = 50.0


def price(sym: str) -> float:
    sym = sym.upper()
    if "/" in sym:
        import ccxt
        ex = ccxt.kraken({"enableRateLimit": True})
        return float(ex.fetch_ticker(sym)["last"])
    import urllib.request
    req = urllib.request.Request(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1m",
                                 headers={"User-Agent": "Mozilla/5.0 (AXIOM manual book)"})
    with urllib.request.urlopen(req, timeout=15) as r:
        j = json.load(r)
    return float(j["chart"]["result"][0]["meta"]["regularMarketPrice"])


def load() -> dict:
    try:
        return json.loads(BOOK.read_text())
    except Exception:
        return {"account": START, "positions": {}, "closed": []}


def save(b: dict) -> None:
    BOOK.parent.mkdir(exist_ok=True)
    BOOK.write_text(json.dumps(b, indent=1))


def log(row: dict) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps({"ts": int(time.time()), **row}) + "\n")


def marked(b: dict) -> dict:
    out = []
    for sym, p in b["positions"].items():
        try:
            px = price(sym)
        except Exception:
            px = p["entry"]
        upnl = (px - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1)
        out.append({"symbol": sym, "side": p["side"], "qty": p["qty"], "entry": p["entry"], "mark": px, "usd": round(p["qty"] * p["entry"], 2), "upnl": round(upnl, 2), "opened": p["ts"], "why": p.get("why", "")})
    closed = b["closed"]
    wins = sum(1 for c in closed if c["pnl"] > 0)
    return {"account": round(b["account"], 2), "start": START, "realized": round(b["account"] - START, 2),
            "unrealized": round(sum(o["upnl"] for o in out), 2), "open": out, "trades": len(closed), "wins": wins,
            "win_rate": round(wins / len(closed), 3) if closed else None, "last_closed": closed[-3:]}


def buy_or_sell(side: str, sym: str, usd: float, why: str) -> dict:
    sym = sym.upper()
    if side == "short" and "/" not in sym:
        return {"ok": False, "error": "shorts are crypto-only on the paper book"}
    usd = float(usd)
    if usd <= 0 or usd > MAX_STAKE:
        return {"ok": False, "error": f"stake must be 0 < usd <= {MAX_STAKE}"}
    b = load()
    if sym in b["positions"]:
        return {"ok": False, "error": f"already in {sym}; close it first"}
    if usd > b["account"]:
        return {"ok": False, "error": f"only ${b['account']:.2f} left on the paper book"}
    px = price(sym)
    qty = usd / px
    b["positions"][sym] = {"side": side, "qty": qty, "entry": px, "ts": int(time.time()), "why": why}
    b["account"] -= usd
    save(b)
    log({"type": "mopen", "symbol": sym, "side": side, "qty": qty, "entry": px, "usd": usd, "why": why})
    return {"ok": True, "filled": {"symbol": sym, "side": side, "qty": round(qty, 6), "price": px, "usd": usd}, "account_after": round(b["account"], 2), "paper": True}


def close(sym: str, why: str) -> dict:
    sym = sym.upper()
    b = load()
    p = b["positions"].pop(sym, None)
    if not p:
        return {"ok": False, "error": f"no open position in {sym}"}
    px = price(sym)
    pnl = (px - p["entry"]) * p["qty"] * (1 if p["side"] == "long" else -1)
    b["account"] += p["qty"] * p["entry"] + pnl
    row = {"symbol": sym, "side": p["side"], "entry": p["entry"], "exit": px, "pnl": round(pnl, 2), "won": pnl > 0, "ts": int(time.time()), "why": why}
    b["closed"].append(row)
    save(b)
    log({"type": "mclose", **row})
    return {"ok": True, "closed": row, "account_after": round(b["account"], 2), "paper": True}


if __name__ == "__main__":
    a = sys.argv[1:]
    try:
        if not a or a[0] == "status":
            print(json.dumps(marked(load())))
        elif a[0] in ("buy", "sell"):
            print(json.dumps(buy_or_sell("long" if a[0] == "buy" else "short", a[1], a[2], a[3] if len(a) > 3 else "")))
        elif a[0] == "close":
            print(json.dumps(close(a[1], a[2] if len(a) > 2 else "")))
        else:
            print(json.dumps({"ok": False, "error": "buy|sell|close|status"}))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)[:200]}))
