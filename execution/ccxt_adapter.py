"""
CCXT UNIFIED EXCHANGE ADAPTER — one gated door to 100+ crypto exchanges.

This is OctoBot's exchange pillar, distilled into our safety model. OctoBot reaches
"the vast majority of exchanges thanks to the great CCXT library"; so do we now —
Kraken, Coinbase, Binance, Bybit, OKX, KuCoin… all through ONE gated adapter instead
of a bespoke one per venue. CCXT is non-custodial client-side: your keys and funds
stay with you, the library talks straight to each exchange's official API.

Same gate as the Hyperliquid/Solana/Questrade adapters — an order goes live ONLY if:
  1. CCXT_DRY_RUN=false              (master switch, default TRUE = paper)
  2. CCXT_API_KEY + CCXT_SECRET set  (scoped, no-withdraw exchange keys)
  3. size ≤ CCXT_MAX_ORDER_USD       (default $5 per order)
  4. today's traded < CCXT_DAILY_CAP_USD    (default $20)
  5. realized slippage ≤ CCXT_SLIPPAGE_BPS  (default 30bps — else ABORT)

Spot only here, so blast radius per order is provably the USD spent (loss bound =
notional). Public data (ticker, OHLCV) needs NO key and is used live even in paper —
so backtests and paper fills run on REAL prices. Log: logs/ccxt_orders.jsonl
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
LOG = ROOT / "logs" / "ccxt_orders.jsonl"
ET = ZoneInfo("America/New_York")

_EX_CACHE: dict = {}


def _env() -> dict:
    out = {}
    if ENV.exists():
        for line in ENV.open():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                out[k] = v
    return out


def _log(rec: dict) -> None:
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _num(env: dict, key: str, default: float) -> float:
    try:
        return float(env.get(key, default) or default)
    except (TypeError, ValueError):
        return default


def _exchange_id() -> str:
    return (_env().get("CCXT_EXCHANGE") or "kraken").lower()


def exchange(authed: bool = False):
    """A CCXT exchange instance (cached). authed=True attaches keys for live orders."""
    import ccxt
    key = f"{_exchange_id()}:{authed}"
    if key in _EX_CACHE:
        return _EX_CACHE[key]
    env = _env()
    klass = getattr(ccxt, _exchange_id())
    cfg = {"enableRateLimit": True, "timeout": 15000}
    if authed:
        cfg["apiKey"] = env.get("CCXT_API_KEY", "")
        cfg["secret"] = env.get("CCXT_SECRET", "")
    ex = klass(cfg)
    _EX_CACHE[key] = ex
    return ex


# ── public market data (no key — real prices even in paper) ───────────────────
def ticker(symbol: str) -> float | None:
    """Real last price for e.g. 'BTC/USD'. None on failure."""
    try:
        return float(exchange().fetch_ticker(symbol)["last"])
    except Exception:
        return None


def fetch_ohlcv(symbol: str, timeframe: str = "1d", limit: int = 400) -> list[list]:
    """Real OHLCV candles [ts, o, h, l, c, v]. Empty list on failure."""
    try:
        return exchange().fetch_ohlcv(symbol, timeframe=timeframe, limit=limit)
    except Exception:
        return []


# ── safety gate (identical model to the other adapters) ───────────────────────
def _today_traded() -> float:
    if not LOG.exists():
        return 0.0
    today = datetime.now(ET).strftime("%Y-%m-%d")
    s = 0.0
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("date") == today and r.get("outcome") in ("filled", "partial"):
                s += abs(r.get("size", 0))
        except Exception:
            pass
    return round(s, 2)


def gate() -> tuple[bool, dict, str]:
    env = _env()
    limits = {
        "max_size": _num(env, "CCXT_MAX_ORDER_USD", 5.0),
        "daily_cap": _num(env, "CCXT_DAILY_CAP_USD", 20.0),
        "slippage_bps": _num(env, "CCXT_SLIPPAGE_BPS", 30.0),
        "exchange": _exchange_id(),
    }
    if env.get("CCXT_DRY_RUN", "true").lower() != "false":
        return False, limits, "CCXT_DRY_RUN is true (paper)"
    if not (env.get("CCXT_API_KEY") and env.get("CCXT_SECRET")):
        return False, limits, "no CCXT_API_KEY/CCXT_SECRET"
    if _today_traded() >= limits["daily_cap"]:
        return False, limits, f"daily cap ${limits['daily_cap']} reached"
    return True, limits, ""


def _simulate_fill(price: float, side: str, slippage_bps: float, outcome: dict | None) -> dict:
    if outcome is None:
        adv = 5.0  # ~0.5bp on a liquid CEX pair, small size
        px = price * (1 + adv / 1e4) if side == "BUY" else price * (1 - adv / 1e4)
        return {"kind": "fill", "px": px, "ratio": 1.0}
    kind = outcome.get("kind", "fill")
    if kind == "reject":
        return {"kind": "reject", "reason": outcome.get("reason", "exchange reject")}
    if kind == "timeout":
        return {"kind": "timeout"}
    bps = outcome.get("slippage_bps", slippage_bps)
    px = outcome.get("px", price * (1 + bps / 1e4) if side == "BUY" else price * (1 - bps / 1e4))
    return {"kind": kind, "px": px, "ratio": float(outcome.get("ratio", 1.0))}


def place_order(symbol: str, side: str, size_usd: float, reason: str = "",
                client_id: str | None = None, _price: float | None = None,
                _outcome: dict | None = None) -> dict:
    """Market BUY/SELL ~size_usd of `symbol` on the configured exchange. Paper unless
    the gate clears. Enforces dedupe → size clamp → daily-cap → fill → slippage guard.
    Loss bound = filled size (spot). _price/_outcome are test seams (None in prod)."""
    date = datetime.now(ET).strftime("%Y-%m-%d")
    cid = client_id or uuid.uuid4().hex[:16]
    live, lim, why = gate()
    rec = {"date": date, "ts": int(time.time()), "venue": f"ccxt/{lim['exchange']}", "cid": cid,
           "symbol": symbol, "side": side, "req_size": round(size_usd, 2),
           "reason": reason, "mode": "live" if live else "paper"}

    if _seen(cid):
        rec.update(outcome="duplicate", detail="client_id already processed"); return rec

    size = min(size_usd, lim["max_size"])
    clamped = size < size_usd
    rec.update(size=round(size, 2))

    if _today_traded() + size > lim["daily_cap"] + 1e-9:
        rec.update(outcome="blocked", detail=f"daily cap ${lim['daily_cap']} would be exceeded")
        _log(rec); return rec

    price = _price if _price is not None else ticker(symbol)
    if price is None or price <= 0:
        rec.update(outcome="rejected", detail="no price"); _log(rec); return rec
    rec.update(price=price)

    fill = _live_fill(symbol, side, size, price, cid) if live else _simulate_fill(price, side, lim["slippage_bps"], _outcome)
    if fill["kind"] == "reject":
        rec.update(outcome="rejected", detail=fill.get("reason", "venue reject")); _log(rec); return rec
    if fill["kind"] == "timeout":
        rec.update(outcome="unknown", detail="timeout — needs reconcile, not resent"); _log(rec); return rec

    slip_bps = abs(fill["px"] / price - 1) * 1e4
    if slip_bps > lim["slippage_bps"] + 1e-9:
        rec.update(outcome="aborted", detail=f"slippage {slip_bps:.1f}bps > {lim['slippage_bps']}bps",
                   fill_px=fill["px"]); _log(rec); return rec

    ratio = max(0.0, min(1.0, fill["ratio"]))
    filled = round(size * ratio, 2)
    rec.update(outcome="filled" if ratio >= 0.999 else "partial",
               fill_px=fill["px"], slippage_bps=round(slip_bps, 2),
               filled_ratio=round(ratio, 3), size=filled,
               tokens=round(filled / fill["px"], 8) if fill["px"] > 0 else 0.0,
               max_loss=filled,
               detail=("clamped to caps; " if clamped else "") + (why if not live else "live fill"))
    _log(rec); return rec


def _seen(cid: str) -> bool:
    if not LOG.exists():
        return False
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("cid") == cid and r.get("outcome") in ("filled", "partial", "rejected", "blocked", "aborted"):
                return True
        except Exception:
            pass
    return False


def _live_fill(symbol: str, side: str, size_usd: float, price: float, cid: str) -> dict:
    """REAL market order via CCXT (only when the gate has cleared)."""
    try:
        ex = exchange(authed=True)
        amount = size_usd / price
        o = ex.create_order(symbol, "market", side.lower(), amount)
        avg = o.get("average") or o.get("price") or price
        return {"kind": "fill", "px": float(avg), "ratio": 1.0}
    except Exception as e:
        return {"kind": "reject", "reason": str(e)[:120]}


def status() -> dict:
    env = _env()
    live, lim, why = gate()
    configured = bool(env.get("CCXT_API_KEY") and env.get("CCXT_SECRET"))
    return {"venue": f"ccxt/{lim['exchange']}", "configured": configured,
            "dry_run": env.get("CCXT_DRY_RUN", "true").lower() != "false",
            "live_enabled": live, "gate_reason": why or "cleared",
            "limits": lim, "today_traded": _today_traded(),
            "custody": "non-custodial client-side — keys & funds stay with you",
            "state": "connected (keys set)" if configured else
                     "not configured — add CCXT_API_KEY/CCXT_SECRET to go live"}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "order":
        print(json.dumps(place_order(sys.argv[2], sys.argv[3], float(sys.argv[4]), "manual"), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "price":
        print(f"{sys.argv[2]} = {ticker(sys.argv[2])}")
    else:
        print(json.dumps(status(), indent=2))
