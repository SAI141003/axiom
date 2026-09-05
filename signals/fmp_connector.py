"""
FINANCIAL MODELING PREP CONNECTOR — a governed data connector in the spirit of
Anthropic's Claude-for-Finance stack (their launch added FMP, Moody's, D&B, …).
FMP has a FREE tier, so this is one we can actually run.

Gives Quill (and the Valuation Reviewer) real fundamentals the earnings engine
alone doesn't have: company profile, key financial ratios, and FMP's own DCF
fair-value estimate. Degrades gracefully to {} when no key is set, so nothing
breaks — set FMP_API_KEY in .env to switch it on.

Free-tier endpoints used (stable, no paid gating):
  /profile/{sym}          sector, market cap, beta, price
  /ratios-ttm/{sym}       P/E, margins, ROE, debt/equity (trailing 12m)
  /discounted-cash-flow/  FMP's DCF fair value vs price

Usage: .venv/bin/python signals/fmp_connector.py AAPL
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

BASE = "https://financialmodelingprep.com/stable"   # v3 legacy retired Aug-2025
UA = {"User-Agent": "Mozilla/5.0"}


def _key() -> str | None:
    k = os.environ.get("FMP_API_KEY")
    if k:
        return k
    env = Path(__file__).resolve().parent.parent / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("FMP_API_KEY"):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def _get(endpoint: str, sym: str, key: str):
    url = f"{BASE}/{endpoint}?symbol={sym}&apikey={key}"
    try:
        return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=12))
    except Exception:
        return None


def _first(rows) -> dict:
    return rows[0] if isinstance(rows, list) and rows else {}


def fundamentals(sym: str) -> dict:
    """Return a compact fundamentals snapshot, or {available: False} without a key."""
    key = _key()
    if not key:
        return {"available": False, "reason": "no FMP_API_KEY set (free key at financialmodelingprep.com)"}
    prof = _first(_get("profile", sym, key))
    ratios = _first(_get("ratios-ttm", sym, key))
    metrics = _first(_get("key-metrics-ttm", sym, key))
    dcf = _first(_get("discounted-cash-flow", sym, key))
    price = prof.get("price") or dcf.get("Stock Price")
    fair = dcf.get("dcf")
    upside = round((fair - price) / price, 3) if (fair and price) else None
    if not prof and not ratios and not dcf:
        return {"available": False, "reason": "FMP returned no data (check key/plan access)"}
    return {
        "available": True,
        "symbol": sym,
        "sector": prof.get("sector"),
        "industry": prof.get("industry"),
        "marketCap": prof.get("marketCap"),
        "beta": prof.get("beta"),
        "price": price,
        "pe_ttm": ratios.get("priceToEarningsRatioTTM"),
        "gross_margin": ratios.get("grossProfitMarginTTM"),
        "net_margin": ratios.get("netProfitMarginTTM"),
        "roe": metrics.get("returnOnEquityTTM"),
        "debt_to_equity": ratios.get("debtToEquityRatioTTM"),
        "dcf_fair_value": round(fair, 2) if fair else None,
        "dcf_upside": upside,
        "dcf_verdict": (None if upside is None else
                        "undervalued" if upside > 0.10 else
                        "overvalued" if upside < -0.10 else "fairly valued"),
    }


if __name__ == "__main__":
    sym = (sys.argv[1] if len(sys.argv) > 1 else "AAPL").upper()
    print(json.dumps(fundamentals(sym), indent=2))
