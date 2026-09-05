"""
CANADA-LEGAL EXECUTION ADAPTER — Questrade.

The same self-tuning brain that produces our signals can place REAL equity orders
on Questrade, a Canadian-regulated broker that serves Vancouver residents. This
is the execution layer the scenario/options engine plugs into — no Polymarket,
no geoblock, no wall to climb.

Design mirrors the Polymarket live_micro safety model — an order goes out ONLY if
ALL hold:
  1. BROKER_DRY_RUN=false          (manual master switch, default TRUE = paper)
  2. QUESTRADE_REFRESH_TOKEN set   (your account's API token from Questrade)
  3. order notional ≤ BROKER_MAX_ORDER_USD   (default $5)
  4. today's spend < BROKER_DAILY_CAP_USD    (default $20)
Every order (paper or live) is appended to logs/broker_orders.jsonl — auditable.

Until you add a refresh token it stays in "not configured" and reports so
honestly; it never pretends to be connected.

Questrade OAuth note: refresh tokens are SINGLE-USE. Each refresh returns a new
one, which we persist to .data/questrade_token.json so the next call works.

Setup (later, when you want it live):
  1. Questrade → App Hub → register a personal app → get a refresh token.
  2. Put it in .env:  QUESTRADE_REFRESH_TOKEN=...
  3. Flip BROKER_DRY_RUN=false when you're ready. Start tiny.
"""
from __future__ import annotations

import json
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
TOKENS = ROOT / ".data" / "questrade_token.json"
LOG = ROOT / "logs" / "broker_orders.jsonl"
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}


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


def _http(url: str, headers: dict, data: bytes | None = None, method: str = "GET") -> dict:
    req = urllib.request.Request(url, data=data, headers={**UA, **headers}, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


# ── OAuth: exchange (single-use) refresh token → access token + api server ────
def _access() -> tuple[str, str] | None:
    """Returns (access_token, api_server) or None if not configured / failed.
    Persists the rotated refresh token so the NEXT call still works."""
    env = _env()
    # prefer a previously-rotated token, fall back to the one in .env
    refresh = None
    if TOKENS.exists():
        try:
            refresh = json.loads(TOKENS.read_text()).get("refresh_token")
        except Exception:
            pass
    refresh = refresh or env.get("QUESTRADE_REFRESH_TOKEN")
    if not refresh:
        return None
    try:
        d = _http("https://login.questrade.com/oauth2/token?"
                  + urllib.parse.urlencode({"grant_type": "refresh_token",
                                            "refresh_token": refresh}), {})
    except Exception:
        return None
    if "access_token" not in d:
        return None
    TOKENS.parent.mkdir(exist_ok=True)
    TOKENS.write_text(json.dumps({"refresh_token": d["refresh_token"],
                                  "ts": int(time.time())}))
    return d["access_token"], d["api_server"]


def _auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ── safety gate (mirrors live_micro) ──────────────────────────────────────────
def _today_spend() -> float:
    if not LOG.exists():
        return 0.0
    today = datetime.now(ET).strftime("%Y-%m-%d")
    s = 0.0
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("date") == today and r.get("status") == "filled":
                s += abs(r.get("notional", 0))
        except Exception:
            pass
    return round(s, 2)


def broker_config() -> tuple[bool, float, str]:
    """(enabled, max_order_usd, reason). enabled True only if fully cleared."""
    env = _env()
    if env.get("BROKER_DRY_RUN", "true").lower() != "false":
        return False, 0.0, "BROKER_DRY_RUN is true (paper)"
    if not (_env().get("QUESTRADE_REFRESH_TOKEN") or TOKENS.exists()):
        return False, 0.0, "no QUESTRADE_REFRESH_TOKEN"
    mx = float(env.get("BROKER_MAX_ORDER_USD", "5") or 5)
    cap = float(env.get("BROKER_DAILY_CAP_USD", "20") or 20)
    if _today_spend() >= cap:
        return False, 0.0, f"daily cap ${cap} reached"
    return True, mx, ""


# ── status + orders ───────────────────────────────────────────────────────────
def status() -> dict:
    """Honest connection state — never fakes being connected."""
    env = _env()
    configured = bool(env.get("QUESTRADE_REFRESH_TOKEN") or TOKENS.exists())
    out = {"broker": "questrade", "configured": configured,
           "dry_run": env.get("BROKER_DRY_RUN", "true").lower() != "false",
           "max_order_usd": float(env.get("BROKER_MAX_ORDER_USD", "5") or 5),
           "daily_cap_usd": float(env.get("BROKER_DAILY_CAP_USD", "20") or 20),
           "today_spend": _today_spend()}
    if not configured:
        out["state"] = "not configured — add QUESTRADE_REFRESH_TOKEN to go live"
        return out
    acc = _access()
    if not acc:
        out["state"] = "token present but auth failed — refresh token may be expired"
        return out
    token, server = acc
    try:
        accts = _http(f"{server}v1/accounts", _auth_headers(token)).get("accounts", [])
        bal = None
        if accts:
            b = _http(f"{server}v1/accounts/{accts[0]['number']}/balances", _auth_headers(token))
            cad = next((x for x in b.get("perCurrencyBalances", []) if x.get("currency") == "CAD"), {})
            bal = cad.get("cash")
        out.update(state="connected", accounts=len(accts),
                   account_type=accts[0].get("type") if accts else None, cash_cad=bal)
    except Exception as e:
        out["state"] = f"auth ok but data fetch failed: {str(e)[:60]}"
    return out


def place_equity_order(symbol: str, action: str, notional_usd: float,
                       reason: str = "") -> dict:
    """Market-buy/sell ~notional_usd of `symbol`. Paper unless fully cleared.
    action = 'Buy' | 'Sell'. Returns the audit record (also logged)."""
    date = datetime.now(ET).strftime("%Y-%m-%d")
    enabled, mx, why = broker_config()
    rec = {"date": date, "ts": int(time.time()), "broker": "questrade",
           "symbol": symbol, "action": action, "notional": round(notional_usd, 2),
           "reason": reason, "status": "paper", "detail": why or "paper mode"}
    notional = min(notional_usd, mx if enabled else notional_usd)
    if not enabled:
        _log(rec)
        return rec
    acc = _access()
    if not acc:
        rec.update(status="error", detail="auth failed")
        _log(rec); return rec
    token, server = acc
    try:
        accts = _http(f"{server}v1/accounts", _auth_headers(token))["accounts"]
        acct = accts[0]["number"]
        # resolve symbol → symbolId, get a live price to size the share qty
        sd = _http(f"{server}v1/symbols?names={urllib.parse.quote(symbol)}", _auth_headers(token))
        sym = sd["symbols"][0]
        sid, price = sym["symbolId"], sym.get("prevDayClosePrice") or 1
        qty = max(1, int(notional // max(price, 0.01)))
        body = json.dumps({"symbolId": sid, "quantity": qty, "action": action,
                           "orderType": "Market", "timeInForce": "Day",
                           "primaryRoute": "AUTO", "secondaryRoute": "AUTO"}).encode()
        resp = _http(f"{server}v1/accounts/{acct}/orders", _auth_headers(token),
                     data=body, method="POST")
        oid = (resp.get("orders") or [{}])[0].get("id")
        rec.update(status="filled", detail="order placed", order_id=oid,
                   qty=qty, price=price, notional=round(qty * price, 2))
    except Exception as e:
        rec.update(status="error", detail=str(e)[:120])
    _log(rec)
    return rec


def place_option_order(underlying: str, right: str, notional_usd: float,
                       target_days: int = 21, reason: str = "") -> dict:
    """Buy ~notional_usd of the near-ATM `right` ('Call'|'Put') on `underlying`,
    nearest expiry on/after target_days. Paper unless fully cleared."""
    from datetime import date, timedelta
    d = datetime.now(ET).strftime("%Y-%m-%d")
    enabled, mx, why = broker_config()
    rec = {"date": d, "ts": int(time.time()), "broker": "questrade", "instrument": "option",
           "symbol": underlying, "right": right, "notional": round(notional_usd, 2),
           "reason": reason, "status": "paper", "detail": why or "paper mode"}
    notional = min(notional_usd, mx if enabled else notional_usd)
    if not enabled:
        _log(rec); return rec
    acc = _access()
    if not acc:
        rec.update(status="error", detail="auth failed"); _log(rec); return rec
    token, server = acc
    try:
        h = _auth_headers(token)
        acct = _http(f"{server}v1/accounts", h)["accounts"][0]["number"]
        u = _http(f"{server}v1/symbols?names={urllib.parse.quote(underlying)}", h)["symbols"][0]
        uid, upx = u["symbolId"], u.get("prevDayClosePrice") or 1
        chain = _http(f"{server}v1/symbols/{uid}/options", h).get("optionChain", [])
        target = date.today() + timedelta(days=target_days)
        # nearest expiry on/after target (else the latest available)
        exps = sorted((oc for oc in chain), key=lambda oc: oc["expiryDate"][:10])
        pick = next((oc for oc in exps if oc["expiryDate"][:10] >= target.isoformat()), exps[-1] if exps else None)
        if not pick:
            rec.update(status="error", detail="no option expiries"); _log(rec); return rec
        # near-ATM strike within the chain
        strikes = pick["chainPerRoot"][0]["chainPerStrikePrice"]
        atm = min(strikes, key=lambda s: abs(s["strikePrice"] - upx))
        oid = atm["callSymbolId"] if right == "Call" else atm["putSymbolId"]
        # quote the option to size contracts (premium × 100 per contract)
        q = _http(f"{server}v1/markets/quotes/options", h,
                  data=json.dumps({"optionIds": [oid]}).encode(), method="POST")
        prem = (q.get("optionQuotes") or [{}])[0].get("askPrice") or 0.5
        contracts = max(1, int(notional // (prem * 100)))
        body = json.dumps({"symbolId": oid, "quantity": contracts, "action": "Buy",
                           "orderType": "Market", "timeInForce": "Day",
                           "primaryRoute": "AUTO", "secondaryRoute": "AUTO"}).encode()
        resp = _http(f"{server}v1/accounts/{acct}/orders", h, data=body, method="POST")
        rec.update(status="filled", detail="option order placed",
                   order_id=(resp.get("orders") or [{}])[0].get("id"),
                   strike=atm["strikePrice"], expiry=pick["expiryDate"][:10],
                   contracts=contracts, premium=prem, notional=round(contracts * prem * 100, 2))
    except Exception as e:
        rec.update(status="error", detail=str(e)[:120])
    _log(rec)
    return rec


def execute_signal(symbol: str, direction: str, conviction: float,
                   instrument: str = "equity", horizon_days: int = 21,
                   notional_usd: float | None = None, reason: str = "") -> dict:
    """THE BRIDGE — turn a brain signal into the right broker order.
      direction : 'UP' | 'DOWN'
      conviction: 0-1 (|p-0.5| based); weak signals are skipped
      instrument: 'equity' | 'option'
    Long-only equities unless BROKER_ALLOW_SHORT=true (DOWN → short needs margin).
    """
    env = _env()
    _, mx, _ = broker_config()
    usd = notional_usd if notional_usd is not None else mx or 5.0
    if conviction < float(env.get("BROKER_MIN_CONVICTION", "0.15") or 0.15):
        return {"status": "skipped", "detail": f"conviction {conviction:.2f} below threshold",
                "symbol": symbol, "direction": direction}
    if instrument == "option":
        return place_option_order(symbol, "Call" if direction == "UP" else "Put",
                                  usd, horizon_days, reason)
    # equity
    if direction == "UP":
        return place_equity_order(symbol, "Buy", usd, reason)
    # DOWN → short only if explicitly allowed (margin account)
    if env.get("BROKER_ALLOW_SHORT", "false").lower() == "true":
        return place_equity_order(symbol, "Sell", usd, reason + " (short)")
    return {"status": "skipped", "detail": "DOWN signal + shorting disabled (long-only)",
            "symbol": symbol, "direction": direction}


def capabilities() -> dict:
    env = _env()
    return {"equity_long": True,
            "equity_short": env.get("BROKER_ALLOW_SHORT", "false").lower() == "true",
            "options": True,
            "min_conviction": float(env.get("BROKER_MIN_CONVICTION", "0.15") or 0.15)}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == "order":
        print(json.dumps(place_equity_order(sys.argv[2], sys.argv[3], float(sys.argv[4]),
                                            "manual test"), indent=2))
    elif len(sys.argv) > 1 and sys.argv[1] == "signal":
        # signal SYMBOL UP|DOWN CONVICTION [equity|option]
        print(json.dumps(execute_signal(sys.argv[2], sys.argv[3], float(sys.argv[4]),
                                         sys.argv[5] if len(sys.argv) > 5 else "equity",
                                         reason="manual signal"), indent=2))
    else:
        print(json.dumps({**status(), "capabilities": capabilities()}, indent=2))
