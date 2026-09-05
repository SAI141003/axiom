"""One-shot: print the live CLOB collateral balance as JSON (used by /api/live/balance)."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
env = {}
for line in (ROOT / ".env").open():
    if "=" in line and not line.startswith("#"):
        k, v = line.strip().split("=", 1)
        env[k] = v

try:
    from py_clob_client_v2 import ClobClient
    from py_clob_client_v2.clob_types import BalanceAllowanceParams, AssetType
    c = ClobClient(host="https://clob.polymarket.com",
                   key=env["POLYMARKET_PRIVATE_KEY"], chain_id=137,
                   signature_type=int(env.get("POLYMARKET_SIGNATURE_TYPE", "1")),
                   funder=env["POLYMARKET_FUNDER"])
    c.set_api_creds(c.create_or_derive_api_key())
    b = c.get_balance_allowance(BalanceAllowanceParams(asset_type=AssetType.COLLATERAL))
    al = list(b.get("allowances", {}).values())
    print(json.dumps({"balance": int(b["balance"]) / 1e6,
                      "maxed": all(int(x) > 1e30 for x in al) if al else False}))
except Exception as e:
    print(json.dumps({"error": str(e)[:200]}))
