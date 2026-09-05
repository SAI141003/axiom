"""
OPENBB CONNECTOR — the Open Data Platform, wired into AXIOM.

OpenBB (71k★) unifies analyst-grade financial data behind one SDK. This pulls a
broad KEYLESS snapshot — equities, crypto, the full US Treasury curve, inflation,
and market news — into one JSON the dashboard reads. Adding provider API keys
(FMP, Intrinio, FRED, Benzinga…) via OpenBB unlocks far more, but everything here
works with zero keys today.

  python signals/openbb_connector.py            (take one snapshot)
Runs every 15 min via launchd com.polymarket.data.openbb.
Writes .data/openbb_snapshot.json for the /data-desk page.
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "openbb_snapshot.json"

WATCHLIST = ["SPY", "QQQ", "DIA", "AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA", "AMD", "JPM"]
CRYPTO = [("BTC-USD", "BTC"), ("ETH-USD", "ETH"), ("SOL-USD", "SOL")]
NEWS_TICKERS = ["NVDA", "AAPL", "TSLA", "SPY"]


def _obb():
    from openbb import obb
    obb.user.preferences.output_type = "dataframe"
    return obb


def _f(x):
    """Clean a numeric → rounded float or None (NaN/None-safe; NaN breaks JSON)."""
    try:
        v = float(x)
        return None if math.isnan(v) or math.isinf(v) else round(v, 2)
    except (TypeError, ValueError):
        return None


def _pct(a, b):
    try:
        va, vb = float(a), float(b)
        if math.isnan(va) or math.isnan(vb) or vb == 0:
            return None
        return round((va / vb - 1) * 100, 2)
    except (TypeError, ValueError):
        return None


def equities(obb) -> list[dict]:
    out = []
    try:
        df = obb.equity.price.quote(",".join(WATCHLIST), provider="yfinance")
    except Exception:
        return out
    for _, r in df.iterrows():
        d = r.to_dict()
        price = _f(d.get("last_price"))
        if price is None:                      # yfinance occasionally NaNs a symbol — skip it
            continue
        out.append({
            "symbol": d.get("symbol"), "name": d.get("name"),
            "price": price, "changePct": _pct(d.get("last_price"), d.get("prev_close")),
            "yearHigh": _f(d.get("year_high")), "yearLow": _f(d.get("year_low")),
            "ma50": _f(d.get("ma_50d")), "ma200": _f(d.get("ma_200d")),
        })
    return out


def crypto(obb) -> list[dict]:
    out = []
    for sym, label in CRYPTO:
        try:
            df = obb.crypto.price.historical(sym, provider="yfinance").tail(2)
            last, prev = df["close"].iloc[-1], df["close"].iloc[-2]
            price = _f(last)
            if price is not None:
                out.append({"symbol": label, "price": price, "changePct": _pct(last, prev)})
        except Exception:
            pass
    return out


def treasury_curve(obb) -> dict | None:
    try:
        df = obb.fixedincome.government.treasury_rates(provider="federal_reserve").tail(1)
        r = df.iloc[-1].to_dict()
        pts = [("3M", "month_3"), ("6M", "month_6"), ("1Y", "year_1"), ("2Y", "year_2"),
               ("5Y", "year_5"), ("10Y", "year_10"), ("30Y", "year_30")]
        curve = [{"tenor": t, "rate": round(float(r[k]) * 100, 2)} for t, k in pts if r.get(k) is not None]
        # 2s10s spread — the classic recession gauge
        y2 = next((c["rate"] for c in curve if c["tenor"] == "2Y"), None)
        y10 = next((c["rate"] for c in curve if c["tenor"] == "10Y"), None)
        return {"curve": curve, "spread_2s10s": round(y10 - y2, 2) if (y2 and y10) else None}
    except Exception:
        return None


def inflation(obb) -> float | None:
    try:
        df = obb.economy.cpi(provider="oecd", countries=["united_states"]).tail(1)
        return round(float(df["value"].iloc[-1]) * 100, 2)
    except Exception:
        return None


def news(obb) -> list[dict]:
    seen, out = set(), []
    for tk in NEWS_TICKERS:
        try:
            df = obb.news.company(tk, provider="yfinance", limit=5)
        except Exception:
            continue
        for _, r in df.iterrows():
            d = r.to_dict()
            title = (d.get("title") or "").strip()
            if not title or title in seen:
                continue
            seen.add(title)
            out.append({"title": title, "url": d.get("url"), "source": d.get("source"), "symbol": tk})
    return out[:10]


def snapshot() -> dict:
    obb = _obb()
    tc = treasury_curve(obb)
    report = {
        "ts": int(time.time()), "source": "OpenBB Platform 4.7 (keyless providers)",
        "equities": equities(obb),
        "crypto": crypto(obb),
        "treasury": tc,
        "cpi_yoy": inflation(obb),
        "news": news(obb),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    return report


if __name__ == "__main__":
    r = snapshot()
    print(f"[openbb] snapshot — {len(r['equities'])} equities, {len(r['crypto'])} crypto, "
          f"{len(r.get('news', []))} headlines")
    if r.get("treasury"):
        c = r["treasury"]["curve"]
        print("  UST curve: " + " ".join(f"{p['tenor']} {p['rate']}%" for p in c) +
              f"  | 2s10s {r['treasury']['spread_2s10s']}")
    print(f"  CPI YoY: {r['cpi_yoy']}%")
    for e in r["equities"][:4]:
        print(f"  {e['symbol']:<5} ${e['price']} ({e['changePct']:+}%)")
    print(f"  → {OUT}")
