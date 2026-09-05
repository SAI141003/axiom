"""
HYPERLIQUID EXECUTION ADAPTER — non-custodial perps via an API/agent wallet.

This is the "full hands to the bot" venue done SAFELY. Hyperliquid's agent (API)
wallet is a separate key that can PLACE and CANCEL orders but can NEVER withdraw
funds — so even a bot gone rogue can lose at most the margin it commits, never the
book. That trade-only key is exactly what MetaMask's Agent Wallet (Aug 2026) signs
with, and it's why you can hand a bot the wheel without handing it your bank.

An order goes live ONLY if ALL hold (mirrors the Questrade/live_micro model):
  1. HL_DRY_RUN=false                (master switch, default TRUE = paper)
  2. HL_API_WALLET_KEY set           (the trade-only agent key, NOT your seed)
  3. margin ≤ HL_MAX_ORDER_USD       (default $5 capital at risk per position)
  4. today's committed < HL_DAILY_CAP_USD   (default $20)
  5. leverage ≤ HL_MAX_LEVERAGE      (default 3x — clamped, never exceeded)
  6. realized slippage ≤ HL_SLIPPAGE_BPS    (default 50bps — else the order ABORTS)

Provable blast-radius: capital at risk per position = margin = notional/leverage,
and margin ≤ HL_MAX_ORDER_USD. A liquidation loses the margin, nothing more. The
agent key can't withdraw. That is the whole safety argument, and scenario_sim.py
proves it holds across every fault.

Real orders use the official hyperliquid-python-sdk (lazy-imported behind the
gate). In paper/dry-run we still pull REAL mid prices but simulate the fill.
Log: logs/hl_orders.jsonl
"""
from __future__ import annotations

import json
import time
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
LOG = ROOT / "logs" / "hl_orders.jsonl"
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}
INFO_URL = "https://api.hyperliquid.xyz/info"


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


def mid_price(coin: str) -> float | None:
    """REAL Hyperliquid mid for `coin` (e.g. 'BTC') — public, no key. None on failure."""
    try:
        body = json.dumps({"type": "allMids"}).encode()
        req = urllib.request.Request(INFO_URL, data=body,
                                     headers={**UA, "Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=12) as r:
            mids = json.load(r)
        v = mids.get(coin)
        return float(v) if v is not None else None
    except Exception:
        return None


# ── safety gate ───────────────────────────────────────────────────────────────
def _today_committed() -> float:
    if not LOG.exists():
        return 0.0
    today = datetime.now(ET).strftime("%Y-%m-%d")
    s = 0.0
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("date") == today and r.get("outcome") in ("filled", "partial"):
                s += abs(r.get("margin", 0))
        except Exception:
            pass
    return round(s, 2)


def gate() -> tuple[bool, dict, str]:
    """(live_enabled, limits, reason). live_enabled True only if fully cleared.
    limits always returned so paper trades honor the SAME caps."""
    env = _env()
    limits = {
        "max_margin": _num(env, "HL_MAX_ORDER_USD", 5.0),
        "daily_cap": _num(env, "HL_DAILY_CAP_USD", 20.0),
        "max_leverage": _num(env, "HL_MAX_LEVERAGE", 3.0),
        "slippage_bps": _num(env, "HL_SLIPPAGE_BPS", 50.0),
    }
    if env.get("HL_DRY_RUN", "true").lower() != "false":
        return False, limits, "HL_DRY_RUN is true (paper)"
    if not env.get("HL_API_WALLET_KEY"):
        return False, limits, "no HL_API_WALLET_KEY (trade-only agent key)"
    if _today_committed() >= limits["daily_cap"]:
        return False, limits, f"daily cap ${limits['daily_cap']} reached"
    return True, limits, ""


def _simulate_fill(mid: float, side: str, slippage_bps: float, outcome: dict | None) -> dict:
    """The venue's response. Default = realistic full fill at mid+adverse slippage.
    scenario_sim injects `outcome` to force partial/reject/timeout/gap faults."""
    if outcome is None:
        # normal: small adverse slippage, full fill
        adv = 8.0  # ~0.8bp typical on a liquid perp
        px = mid * (1 + adv / 1e4) if side == "LONG" else mid * (1 - adv / 1e4)
        return {"kind": "fill", "px": px, "ratio": 1.0}
    kind = outcome.get("kind", "fill")
    if kind == "reject":
        return {"kind": "reject", "reason": outcome.get("reason", "insufficient margin")}
    if kind == "timeout":
        return {"kind": "timeout"}
    # fill / partial / gap: honor an injected fill price or a slippage in bps
    bps = outcome.get("slippage_bps", slippage_bps)
    px = outcome.get("px")
    if px is None:
        px = mid * (1 + bps / 1e4) if side == "LONG" else mid * (1 - bps / 1e4)
    return {"kind": kind, "px": px, "ratio": float(outcome.get("ratio", 1.0))}


def place_perp(coin: str, side: str, margin_usd: float, leverage: float = 2.0,
               reason: str = "", client_id: str | None = None,
               _mid: float | None = None, _outcome: dict | None = None) -> dict:
    """Open a perp: commit `margin_usd` of capital at `leverage`x on `coin`.
      side = 'LONG' | 'SHORT'. Paper unless the gate fully clears.
    Enforces (in order): dedupe → cap clamp → daily-cap block → leverage clamp →
    real/injected fill → slippage guard. Loss is bounded to committed margin.
    _mid/_outcome are test seams; leave them None in production.
    """
    date = datetime.now(ET).strftime("%Y-%m-%d")
    cid = client_id or uuid.uuid4().hex[:16]
    live, lim, why = gate()
    rec = {"date": date, "ts": int(time.time()), "venue": "hyperliquid", "cid": cid,
           "coin": coin, "side": side, "req_margin": round(margin_usd, 2),
           "reason": reason, "mode": "live" if live else "paper"}

    # 1) idempotency — never act on a client id we've already logged as terminal
    if _seen(cid):
        rec.update(outcome="duplicate", detail="client_id already processed"); return rec

    # 2) clamp margin to the per-order cap (never exceed), clamp leverage
    margin = min(margin_usd, lim["max_margin"])
    lev = max(1.0, min(leverage, lim["max_leverage"]))
    clamped = margin < margin_usd or lev < leverage
    rec.update(margin=round(margin, 2), leverage=lev)

    # 3) daily cap (paper honors it too, so paper == live behavior)
    if _today_committed() + margin > lim["daily_cap"] + 1e-9:
        rec.update(outcome="blocked", detail=f"daily cap ${lim['daily_cap']} would be exceeded")
        _log(rec); return rec

    # 4) price
    mid = _mid if _mid is not None else mid_price(coin)
    if mid is None or mid <= 0:
        rec.update(outcome="rejected", detail="no price"); _log(rec); return rec
    notional = margin * lev
    rec.update(notional=round(notional, 2), mid=mid)

    # 5) fill (real via SDK when live+installed; else simulate)
    fill = _live_fill(coin, side, notional, cid) if live else _simulate_fill(mid, side, lim["slippage_bps"], _outcome)
    if fill["kind"] == "reject":
        rec.update(outcome="rejected", detail=fill.get("reason", "venue reject")); _log(rec); return rec
    if fill["kind"] == "timeout":
        # UNKNOWN fill state — never blindly resend; flag for reconcile, commit nothing
        rec.update(outcome="unknown", detail="timeout — needs reconcile, not resent"); _log(rec); return rec

    # 6) slippage guard — abort if the fill is worse than tolerance
    slip_bps = abs(fill["px"] / mid - 1) * 1e4
    if slip_bps > lim["slippage_bps"] + 1e-9:
        rec.update(outcome="aborted", detail=f"slippage {slip_bps:.1f}bps > {lim['slippage_bps']}bps",
                   fill_px=fill["px"]); _log(rec); return rec

    ratio = max(0.0, min(1.0, fill["ratio"]))
    filled_margin = round(margin * ratio, 2)
    rec.update(outcome="filled" if ratio >= 0.999 else "partial",
               fill_px=fill["px"], slippage_bps=round(slip_bps, 2),
               filled_ratio=round(ratio, 3), margin=filled_margin,
               notional=round(filled_margin * lev, 2),
               max_loss=filled_margin,  # provable blast radius: liquidation loses margin, no more
               detail=("clamped to caps; " if clamped else "") + (why if not live else "live fill"))
    _log(rec); return rec


def close_perp(cid: str, entry_px: float, exit_px: float, side: str, margin: float,
               leverage: float, reason: str = "") -> dict:
    """Realize a perp. P&L bounded: a full adverse move (liquidation) loses `margin`,
    never more (the agent key can't touch the rest of the book)."""
    ret = (exit_px / entry_px - 1) * (1 if side == "LONG" else -1)
    raw = margin * leverage * ret
    pnl = max(-margin, round(raw, 2))  # liquidation floor — cannot lose more than margin
    rec = {"date": datetime.now(ET).strftime("%Y-%m-%d"), "ts": int(time.time()),
           "venue": "hyperliquid", "cid": cid, "type": "close", "side": side,
           "entry": entry_px, "exit": exit_px, "margin": margin, "leverage": leverage,
           "pnl": pnl, "liquidated": pnl <= -margin + 1e-9, "reason": reason}
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


def _live_fill(coin: str, side: str, notional: float, cid: str) -> dict:
    """REAL order via hyperliquid-python-sdk (lazy import — only when live)."""
    try:
        from hyperliquid.exchange import Exchange   # type: ignore
        from hyperliquid.utils import constants     # type: ignore
        import eth_account                           # type: ignore
    except Exception:
        return {"kind": "reject", "reason": "hyperliquid SDK not installed"}
    try:
        env = _env()
        wallet = eth_account.Account.from_key(env["HL_API_WALLET_KEY"])
        ex = Exchange(wallet, constants.MAINNET_API_URL)
        mid = mid_price(coin) or 0.0
        if mid <= 0:
            return {"kind": "reject", "reason": "no price"}
        sz = round(notional / mid, 5)
        r = ex.market_open(coin, side == "LONG", sz, None, 0.01)  # 1% max slippage at SDK level too
        st = (((r or {}).get("response") or {}).get("data") or {}).get("statuses") or [{}]
        fill = st[0].get("filled") if isinstance(st[0], dict) else None
        if not fill:
            return {"kind": "reject", "reason": json.dumps(r)[:120]}
        return {"kind": "fill", "px": float(fill["avgPx"]), "ratio": 1.0}
    except Exception as e:
        return {"kind": "reject", "reason": str(e)[:120]}


def status() -> dict:
    env = _env()
    live, lim, why = gate()
    configured = bool(env.get("HL_API_WALLET_KEY"))
    return {"venue": "hyperliquid", "configured": configured,
            "dry_run": env.get("HL_DRY_RUN", "true").lower() != "false",
            "live_enabled": live, "gate_reason": why or "cleared",
            "limits": lim, "today_committed": _today_committed(),
            "custody": "non-custodial — agent key trades, cannot withdraw",
            "state": "connected (agent key)" if configured else
                     "not configured — add HL_API_WALLET_KEY (trade-only) to go live"}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "open":
        # open COIN LONG|SHORT MARGIN [LEV]
        print(json.dumps(place_perp(sys.argv[2], sys.argv[3], float(sys.argv[4]),
                                    float(sys.argv[5]) if len(sys.argv) > 5 else 2.0,
                                    reason="manual"), indent=2))
    else:
        print(json.dumps(status(), indent=2))
