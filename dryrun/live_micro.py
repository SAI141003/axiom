"""
Micro-live executor — $1 real orders for strategy daemons, gated to death.

An order goes out ONLY if ALL of these hold:
  1. .env DRY_RUN=false            (the manual master switch)
  2. .env LIVE_MICRO_USD > 0       (per-trade stake, e.g. 1)
  3. Redis kill switch clear       (system:kill absent)
  4. Today's live spend < LIVE_DAILY_CAP_USD (default $10)
  5. Keys present and the CLOB accepts the signed order

Every attempt (sent, filled, rejected, blocked) is appended to
logs/live_orders.jsonl — the live book is auditable line by line.
"""
from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "live_orders.jsonl"
ET = ZoneInfo("America/New_York")

_client = None


def _env() -> dict:
    out = {}
    try:
        for line in (ROOT / ".env").open():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                out[k] = v
    except Exception:
        pass
    return out


def _log(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _today_spend() -> float:
    if not LOG.exists():
        return 0.0
    today = datetime.now(ET).strftime("%Y-%m-%d")
    spend = 0.0
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("date") == today and r.get("status") in ("sent", "filled"):
                spend += float(r.get("usd", 0))
        except Exception:
            pass
    return spend


def live_config() -> tuple[bool, float, str]:
    """(enabled, stake_usd, reason_if_disabled)"""
    env = _env()
    if env.get("DRY_RUN", "true").lower() != "false":
        return False, 0.0, "DRY_RUN is true"
    try:
        stake = float(env.get("LIVE_MICRO_USD", "0"))
    except ValueError:
        stake = 0.0
    if stake <= 0:
        return False, 0.0, "LIVE_MICRO_USD not set"
    stake = min(stake, 5.0)                     # hard ceiling regardless of env
    cap = float(env.get("LIVE_DAILY_CAP_USD", "10") or 10)
    if _today_spend() + stake > cap:
        return False, 0.0, f"daily live cap ${cap} reached"
    try:
        kill = subprocess.run(["redis-cli", "exists", "system:kill"],
                              capture_output=True, text=True, timeout=3).stdout.strip()
        if kill == "1":
            return False, 0.0, "kill switch active"
    except Exception:
        pass                                     # redis down → don't block on it

    # ── daily P&L guards: profit target (anti-overtrade) + stop loss ────────
    # Measured from the REAL CLOB balance vs the day's first snapshot.
    target = float(env.get("LIVE_DAILY_PROFIT_TARGET", "0") or 0)
    stop = float(env.get("LIVE_STOP_LOSS_USD", "0") or 0)
    if target > 0 or stop > 0:
        pnl = _day_pnl()
        if pnl is not None:
            if target > 0 and pnl >= target:
                return False, 0.0, f"DAILY PROFIT TARGET hit (+${pnl:.2f} ≥ ${target}) — done for today"
            if stop > 0 and pnl <= -stop:
                return False, 0.0, f"DAILY STOP LOSS hit (${pnl:.2f} ≤ -${stop}) — halted"
    return True, stake, ""


_BAL_FILE = ROOT / ".data" / "day_start_balance.json"


def _clob_balance() -> float | None:
    try:
        from py_clob_client_v2.clob_types import BalanceAllowanceParams, AssetType
        b = _get_client().get_balance_allowance(
            BalanceAllowanceParams(asset_type=AssetType.COLLATERAL))
        return int(b["balance"]) / 1e6
    except Exception:
        return None


def _day_pnl() -> float | None:
    """Realized day P&L ≈ current CLOB balance − day-start balance.
    (Cash-basis: open positions count when they settle back to cash.)"""
    bal = _clob_balance()
    if bal is None:
        return None
    today = datetime.now(ET).strftime("%Y-%m-%d")
    snap = {}
    try:
        snap = json.loads(_BAL_FILE.read_text())
    except Exception:
        pass
    if snap.get("date") != today:
        _BAL_FILE.parent.mkdir(exist_ok=True)
        _BAL_FILE.write_text(json.dumps({"date": today, "balance": bal}))
        return 0.0
    return round(bal - float(snap["balance"]), 2)


def _get_client():
    global _client
    if _client is not None:
        return _client
    from py_clob_client_v2 import ClobClient
    env = _env()
    c = ClobClient(
        host="https://clob.polymarket.com",
        key=env["POLYMARKET_PRIVATE_KEY"],
        chain_id=137,
        signature_type=int(env.get("POLYMARKET_SIGNATURE_TYPE", "1")),
        funder=env["POLYMARKET_FUNDER"],
    )
    # create_or_derive tries CREATE first (logs a benign 400 when the key already
    # exists) then DERIVEs successfully. Silence that misleading stderr line.
    import os as _os, contextlib as _ctx
    with _ctx.redirect_stderr(open(_os.devnull, "w")):
        c.set_api_creds(c.create_or_derive_api_key())
    _client = c
    return c


def place_micro_buy(strategy: str, token_id: str, label: str, ref_price: float) -> dict:
    """
    Market-buy LIVE_MICRO_USD of a token, fill-or-kill. Returns the audit record.
    Call ONLY after live_config()[0] is True.
    """
    enabled, usd, why = live_config()
    date = datetime.now(ET).strftime("%Y-%m-%d")
    rec = {"date": date, "ts": int(time.time()), "strategy": strategy,
           "label": label, "token": token_id[:16] + "…", "usd": usd,
           "ref_price": ref_price, "status": "blocked", "detail": why}
    # SINGLE CHOKE POINT: only strategies in LIVE_ALLOWED_STRATEGIES may ever go
    # live, regardless of any daemon's own gating. Empty/unset = allow none.
    allowed = {s.strip() for s in _env().get("LIVE_ALLOWED_STRATEGIES", "").split(",") if s.strip()}
    if strategy not in allowed:
        rec["detail"] = f"'{strategy}' not in LIVE_ALLOWED_STRATEGIES ({','.join(sorted(allowed)) or 'empty'})"
        _log(rec)
        return rec
    if not enabled:
        _log(rec)
        return rec
    try:
        from py_clob_client_v2.clob_types import (MarketOrderArgs, OrderType,
            PartialCreateOrderOptions)
        client = _get_client()
        opts = PartialCreateOrderOptions(neg_risk=client.get_neg_risk(token_id),
                                         tick_size=client.get_tick_size(token_id))
        resp = client.create_and_post_market_order(
            MarketOrderArgs(token_id=token_id, amount=usd, side="BUY"),
            opts, OrderType.FOK)
        ok = bool(resp and (resp.get("orderID") or resp.get("status") == "matched"))
        rec.update({"status": "filled" if ok else "rejected",
                    "detail": json.dumps(resp)[:300]})
    except Exception as exc:
        rec.update({"status": "error", "detail": str(exc)[:300]})
    _log(rec)
    print(f"[live-micro] {strategy} {label}: {rec['status']} — {rec['detail'][:80]}", flush=True)
    return rec
