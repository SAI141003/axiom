"""
ONE-SHOT LIVE CONNECTION TEST — places a single $1 real order to prove the
full path works end to end, then reports every layer's result. This is a
plumbing test on a heavy favorite (max loss ≈ $1), not a strategy bet.

Layers verified (the "how it thinks" stack, bottom up):
  1. AUTH      — key + funder + sig_type derive CLOB creds
  2. BALANCE   — CLOB sees spendable collateral
  3. MARKET    — live orderbook price for the token
  4. ORDER     — signed $1 market buy accepted by the CLOB
  5. POSITION  — the fill shows up in the account
"""
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOKEN = sys.argv[1] if len(sys.argv) > 1 else None
USD = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0

env = {}
for line in (ROOT / ".env").open():
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1); env[k] = v

from py_clob_client_v2 import ClobClient
from py_clob_client_v2.clob_types import (
    BalanceAllowanceParams, AssetType, MarketOrderArgs, OrderType, PartialCreateOrderOptions)

def ok(layer, msg): print(f"  ✓ {layer:<9} {msg}", flush=True)
def bad(layer, msg): print(f"  ✗ {layer:<9} {msg}", flush=True)

print("═" * 60)
print("LIVE POLYMARKET CONNECTION TEST")
print("═" * 60)

# ── 1. AUTH ────────────────────────────────────────────────────────────────
try:
    c = ClobClient(host="https://clob.polymarket.com",
                   key=env["POLYMARKET_PRIVATE_KEY"], chain_id=137,
                   signature_type=int(env.get("POLYMARKET_SIGNATURE_TYPE", "1")),
                   funder=env["POLYMARKET_FUNDER"])
    creds = c.create_or_derive_api_key()
    c.set_api_creds(creds)
    ok("AUTH", f"creds derived (key …{creds.api_key[-6:]}), sig_type={env.get('POLYMARKET_SIGNATURE_TYPE','1')}")
except Exception as e:
    bad("AUTH", str(e)[:120]); sys.exit(1)

# ── 2. BALANCE ─────────────────────────────────────────────────────────────
try:
    b = c.get_balance_allowance(BalanceAllowanceParams(asset_type=AssetType.COLLATERAL))
    bal = int(b["balance"]) / 1e6
    maxed = all(int(x) > 1e30 for x in b.get("allowances", {}).values())
    ok("BALANCE", f"${bal:.2f} spendable · allowances {'MAXED' if maxed else 'NOT SET'}")
    if bal < USD:
        bad("BALANCE", f"insufficient for ${USD} test"); sys.exit(1)
except Exception as e:
    bad("BALANCE", str(e)[:120]); sys.exit(1)

if not TOKEN:
    print("\n(no token given — auth+balance verified, skipping order)")
    sys.exit(0)

# ── 3. MARKET ──────────────────────────────────────────────────────────────
try:
    px = c.get_price(token_id=TOKEN, side="SELL")   # ask = what we'd pay
    ask = float(px["price"])
    ok("MARKET", f"live ask {ask} for token …{TOKEN[-6:]}")
except Exception as e:
    bad("MARKET", str(e)[:120]); sys.exit(1)

# ── 4. ORDER ───────────────────────────────────────────────────────────────
try:
    neg = c.get_neg_risk(TOKEN); tick = c.get_tick_size(TOKEN)
    opts = PartialCreateOrderOptions(neg_risk=neg, tick_size=tick)
    resp = c.create_and_post_market_order(
        MarketOrderArgs(token_id=TOKEN, amount=USD, side="BUY"), opts, OrderType.FOK)
    success = bool(resp and (resp.get("orderID") or resp.get("status") == "matched"))
    if success:
        ok("ORDER", f"FILLED ${USD} — id {str(resp.get('orderID',''))[:16]}…")
    else:
        bad("ORDER", f"rejected: {json.dumps(resp)[:150]}")
    (ROOT / "logs" / "live_orders.jsonl").open("a").write(json.dumps({
        "date": time.strftime("%Y-%m-%d"), "ts": int(time.time()),
        "strategy": "connection_test", "label": "Norway WC NO",
        "token": TOKEN[:16] + "…", "usd": USD, "ref_price": ask,
        "status": "filled" if success else "rejected",
        "detail": json.dumps(resp)[:300]}) + "\n")
except Exception as e:
    bad("ORDER", str(e)[:150]); sys.exit(1)

# ── 5. POSITION ────────────────────────────────────────────────────────────
try:
    time.sleep(3)
    import urllib.request
    url = f"https://data-api.polymarket.com/positions?user={env['POLYMARKET_FUNDER']}&limit=5"
    pos = json.load(urllib.request.urlopen(url))
    if pos:
        ok("POSITION", f"{len(pos)} position(s) on account — newest: {pos[0].get('title','?')[:40]}")
    else:
        print("  · POSITION  not yet indexed (can lag ~30s) — check polymarket.com/portfolio")
except Exception as e:
    print(f"  · POSITION  lookup lagged: {str(e)[:80]}")

print("═" * 60)
print("RESULT: connection is LIVE and every layer responded." if success
      else "RESULT: auth+balance OK, order did not fill — see ORDER line.")
