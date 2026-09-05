"""
GAMMA LEVELS (dealer positioning) — the "GAMMA: spot high-resistance
confluence zones" layer. From live option chains, compute gamma exposure
(GEX) per strike and extract the levels every desk watches:

  call wall   strike with max positive GEX — resistance magnet
  put wall    strike with max negative GEX — support magnet
  zero-gamma  flip point: above it dealers dampen moves (mean-revert),
              below it they amplify (trend) — a REGIME line

Convention: dealers are long calls' gamma (+) and short puts' gamma (−);
GEX_strike = Σ OI × BS_gamma × 100 × S. Signs are approximate (true dealer
inventory is unknowable from public data) — these are CONFLUENCE ZONES, not
predictions.

Output: .data/gamma_levels.json {sym: {spot, call_wall, put_wall, zero_gamma,
top_strikes}}. Wired into the overnight loop; consumers: premarket/vwap
context, journal. Run: .venv/bin/python signals/gamma_levels.py
"""
from __future__ import annotations

import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "gamma_levels.json"
SYMBOLS = ["QQQ", "SPY", "NVDA", "TSLA", "AAPL"]
UA = {"User-Agent": "Mozilla/5.0"}

_auth: dict | None = None


def yahoo_auth() -> dict:
    global _auth
    if _auth and time.time() - _auth["ts"] < 1200:
        return _auth
    req = urllib.request.Request("https://fc.yahoo.com", headers=UA)
    try:
        urllib.request.urlopen(req, timeout=10)
    except Exception as e:                       # yahoo replies 404 with cookie
        cookie = e.headers.get("set-cookie", "").split(";")[0] if hasattr(e, "headers") else ""
    else:
        cookie = ""
    req = urllib.request.Request(
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        headers={**UA, "cookie": cookie})
    crumb = urllib.request.urlopen(req, timeout=10).read().decode()
    _auth = {"cookie": cookie, "crumb": crumb, "ts": time.time()}
    return _auth


def yget(url: str) -> dict:
    a = yahoo_auth()
    sep = "&" if "?" in url else "?"
    req = urllib.request.Request(f"{url}{sep}crumb={a['crumb']}",
                                 headers={**UA, "cookie": a["cookie"]})
    return json.load(urllib.request.urlopen(req, timeout=15))


def bs_gamma(spot: float, strike: float, iv: float, t_years: float) -> float:
    if iv <= 0 or t_years <= 0 or spot <= 0:
        return 0.0
    d1 = (math.log(spot / strike) + 0.5 * iv * iv * t_years) / (iv * math.sqrt(t_years))
    phi = math.exp(-0.5 * d1 * d1) / math.sqrt(2 * math.pi)
    return phi / (spot * iv * math.sqrt(t_years))


def gex_for(sym: str) -> dict | None:
    try:
        meta = yget(f"https://query1.finance.yahoo.com/v7/finance/options/{sym}")
        res = meta["optionChain"]["result"][0]
        spot = float(res["quote"]["regularMarketPrice"])
        expiries = res.get("expirationDates", [])[:2]     # nearest two
        now = time.time()
        gex: dict[float, float] = {}
        for exp in expiries:
            t_years = max(1 / 365, (exp - now) / 86400 / 365)
            chain = yget(f"https://query1.finance.yahoo.com/v7/finance/options/{sym}?date={exp}")
            opts = chain["optionChain"]["result"][0]["options"][0]
            for kind, sign in (("calls", 1), ("puts", -1)):
                for c in opts.get(kind, []):
                    oi = c.get("openInterest") or 0
                    iv = c.get("impliedVolatility") or 0
                    k = c.get("strike")
                    if not oi or not k or not 0.01 < iv < 5:
                        continue
                    g = bs_gamma(spot, k, iv, t_years)
                    gex[k] = gex.get(k, 0.0) + sign * oi * g * 100 * spot
            time.sleep(0.4)
        if not gex:
            return None
        # walls
        call_wall = max(gex, key=lambda k: gex[k])
        put_wall = min(gex, key=lambda k: gex[k])
        # zero-gamma: strike where cumulative GEX (sorted) crosses zero
        ks = sorted(gex)
        cum, zero_g = 0.0, None
        prev_k, prev_cum = ks[0], 0.0
        for k in ks:
            cum += gex[k]
            if prev_cum < 0 <= cum or prev_cum > 0 >= cum:
                zero_g = round((k + prev_k) / 2, 2)
            prev_k, prev_cum = k, cum
        top = sorted(gex.items(), key=lambda kv: -abs(kv[1]))[:6]
        return {
            "spot": round(spot, 2),
            "call_wall": call_wall, "put_wall": put_wall,
            "zero_gamma": zero_g,
            "regime": "dampened (above zero-γ)" if zero_g and spot > zero_g
                      else "amplified (below zero-γ)" if zero_g else "unknown",
            "top_strikes": [{"strike": k, "gex": round(v / 1e6, 1)} for k, v in top],
        }
    except Exception as exc:
        print(f"[gamma] {sym} failed: {exc}")
        return None


def main() -> None:
    out = {}
    for sym in SYMBOLS:
        r = gex_for(sym)
        if r:
            out[sym] = r
            print(f"[gamma] {sym}: spot {r['spot']} · call wall {r['call_wall']} · "
                  f"put wall {r['put_wall']} · zero-γ {r['zero_gamma']} · {r['regime']}")
    if out:
        OUT.parent.mkdir(exist_ok=True)
        OUT.write_text(json.dumps({"ts": int(time.time()), "levels": out}, indent=2))


if __name__ == "__main__":
    main()
