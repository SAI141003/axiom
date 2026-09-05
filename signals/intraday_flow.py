"""
INTRADAY ORDER FLOW — read the same tape the top traders read.

The reel's tools decode to real, well-studied microstructure:
  Ultra Delta   → Cumulative Volume Delta (aggressive buy vs sell volume)
  Big Trades    → large prints / block detection (whales stepping in)
  Deepdom       → order-book depth imbalance (bid vs ask liquidity)
  Deep Gamma    → dealer gamma exposure (we already have this: gamma_pulse.py)

Order-flow imbalance is the single strongest short-horizon predictor in the
literature (Cont-Kukanov-Stoikov 2014; Chordia-Roll-Subrahmanyam). This reads it
LIVE from CCXT's public trade & book feeds — no key. IMPORTANT: it's a live/forward
signal, NOT historically backtestable (no free tick history), so it earns trust by
forward-testing, not by a backtest curve.

  python signals/intraday_flow.py BTC/USD
"""
from __future__ import annotations

import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from execution import ccxt_adapter


def order_flow(symbol: str, trades_limit: int = 1000, book_depth: int = 50) -> dict | None:
    """Live CVD + big-trade + DOM read for `symbol`. None if the venue can't serve it."""
    ex = ccxt_adapter.exchange()
    try:
        trades = ex.fetch_trades(symbol, limit=trades_limit)
    except Exception:
        return None
    if not trades:
        return None

    buy_vol = sum(t["amount"] for t in trades if t.get("side") == "buy")
    sell_vol = sum(t["amount"] for t in trades if t.get("side") == "sell")
    cvd = buy_vol - sell_vol
    tot = buy_vol + sell_vol or 1e-9
    cvd_ratio = cvd / tot                       # [-1,1] aggressive-flow imbalance

    sizes = [t["amount"] for t in trades]
    med = statistics.median(sizes) or 1e-9
    big = [t for t in trades if t["amount"] >= 5 * med]     # ≥5× median = a "big trade"
    big_buy = sum(t["amount"] for t in big if t.get("side") == "buy")
    big_sell = sum(t["amount"] for t in big if t.get("side") == "sell")

    span_s = max(1e-6, (trades[-1]["timestamp"] - trades[0]["timestamp"]) / 1000)
    intensity = len(trades) / span_s            # trades/sec

    # DOM imbalance from the order book
    obi = None
    try:
        ob = ex.fetch_order_book(symbol, limit=book_depth)
        bid = sum(e[1] for e in ob["bids"][:book_depth])   # entries may be [px, amt, ts]
        ask = sum(e[1] for e in ob["asks"][:book_depth])
        obi = (bid - ask) / (bid + ask) if (bid + ask) else None
    except Exception:
        pass

    # combined directional read in [-1,1]
    parts = [cvd_ratio]
    if big_buy + big_sell > 0:
        parts.append((big_buy - big_sell) / (big_buy + big_sell))
    if obi is not None:
        parts.append(obi)
    bias = max(-1.0, min(1.0, sum(parts) / len(parts)))

    return {"symbol": symbol, "ts": int(time.time()), "trades": len(trades),
            "cvd": round(cvd, 4), "cvd_ratio": round(cvd_ratio, 4),
            "big_trades": len(big), "big_buy": round(big_buy, 4), "big_sell": round(big_sell, 4),
            "obi": round(obi, 4) if obi is not None else None,
            "intensity_per_s": round(intensity, 2), "bias": round(bias, 4)}


if __name__ == "__main__":
    sym = sys.argv[1] if len(sys.argv) > 1 else "BTC/USD"
    f = order_flow(sym)
    if not f:
        print(f"[flow] no data for {sym}"); sys.exit(0)
    d = "BUY" if f["bias"] > 0.1 else "SELL" if f["bias"] < -0.1 else "NEUTRAL"
    print(f"[flow] {sym} · {f['trades']} trades @ {f['intensity_per_s']}/s")
    print(f"  CVD {f['cvd']:+} ({f['cvd_ratio']*100:+.1f}% imbalance) · "
          f"{f['big_trades']} big (buy {f['big_buy']} / sell {f['big_sell']}) · "
          f"DOM {f['obi']} · bias {f['bias']:+.2f} → {d}")
