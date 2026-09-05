"""
KRONOS vs US — is the 102M-param foundation model better than our factor blend?

Head-to-head on monthly equity direction, walk-forward out-of-sample, same tickers,
same metric — the honest test before we ever trust Kronos on stocks. Kronos-base
forecasts 21 days of candles from a lookback window; direction = forecast mean
close vs last close, magnitude mapped to a probability. Our model = the benchmarked
factor blend (12m momentum + 5d reversal + Faber + low-vol).

Writes .data/kronos_benchmark.json  ·  Run in background (Kronos CPU inference is slow).
"""
from __future__ import annotations

import json
import math
import statistics
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "kronos_repo"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from earnings_engine import logistic

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "kronos_benchmark.json"
UA = {"User-Agent": "Mozilla/5.0"}
UNIVERSE = ["NVDA", "AAPL", "MSFT", "AMD", "TSLA", "GOOGL"]   # small — Kronos is slow
HZ = 21           # forecast horizon (trading days)
LOOKBACK = 250    # candles fed to Kronos


def ohlcv(sym):
    j = json.load(urllib.request.urlopen(urllib.request.Request(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=2y&interval=1d",
        headers=UA), timeout=20))
    q = j["chart"]["result"][0]["indicators"]["quote"][0]
    import pandas as pd
    df = pd.DataFrame({"open": q["open"], "high": q["high"], "low": q["low"],
                       "close": q["close"], "volume": q["volume"]}).dropna().reset_index(drop=True)
    return df


def our_p_up(closes):
    if len(closes) < 60:
        return 0.5
    price = closes[-1]
    rets = [closes[i] / closes[i - 1] - 1 for i in range(1, len(closes))]
    mom12 = price / closes[-252] - 1 if len(closes) >= 252 else price / closes[0] - 1
    ret5 = price / closes[-6] - 1
    sma50 = sum(closes[-50:]) / 50
    rvol = statistics.pstdev(rets[-10:]); hvol = statistics.pstdev(rets)
    logit = math.log(0.53 / 0.47) + 0.50 * (1 if mom12 > 0 else -1) \
        - 2.0 * max(-0.06, min(0.06, ret5)) + 0.30 * (1 if price > sma50 else -1) \
        + 0.20 * (1 if rvol < hvol else -1)
    return logistic(logit)


def main():
    import pandas as pd
    from model.kronos import Kronos, KronosTokenizer, KronosPredictor
    print("[kronos-bench] loading Kronos-base...", flush=True)
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mdl = Kronos.from_pretrained("NeoQuasar/Kronos-base"); mdl.to("cpu")
    pred = KronosPredictor(mdl, tok, device="cpu", max_context=512)

    hit = {"kronos": 0, "ours": 0}; bsum = {"kronos": 0.0, "ours": 0.0}; n = 0
    for sym in UNIVERSE:
        try:
            df = ohlcv(sym)
        except Exception:
            continue
        closes = df["close"].tolist()
        # walk-forward monthly over the last ~10 months
        for end in range(len(df) - HZ - 210, len(df) - HZ, HZ):
            if end < LOOKBACK:
                continue
            window = df.iloc[end - LOOKBACK:end].reset_index(drop=True)
            last = window["close"].iloc[-1]
            realized = 1 if closes[end + HZ - 1] > last else 0
            xts = pd.Series(pd.date_range("2020-01-01", periods=len(window), freq="D"))
            yts = pd.Series(pd.date_range("2020-01-01", periods=HZ, freq="D"))
            try:
                r = pred.predict(df=window[["open", "high", "low", "close", "volume"]],
                                 x_timestamp=xts, y_timestamp=yts, pred_len=HZ,
                                 T=0.8, top_p=0.9, sample_count=1, verbose=False)
                fret = r["close"].mean() / last - 1
                p_k = logistic(8.0 * fret)
            except Exception:
                continue
            p_o = our_p_up(closes[:end])
            for m, p in [("kronos", p_k), ("ours", p_o)]:
                hit[m] += int((p >= 0.5) == bool(realized))
                bsum[m] += (p - realized) ** 2
            n += 1
            print(f"[kronos-bench] {sym} @{end}: kronos {'UP' if p_k>=.5 else 'DN'} · "
                  f"ours {'UP' if p_o>=.5 else 'DN'} · real {'UP' if realized else 'DN'} (n={n})", flush=True)

    if not n:
        print("[kronos-bench] no predictions"); return
    rows = [{"model": "Kronos-base (102M foundation)", "key": "kronos",
             "accuracy": round(hit["kronos"] / n, 3), "brier": round(bsum["kronos"] / n, 4)},
            {"model": "OUR factor blend", "key": "ours",
             "accuracy": round(hit["ours"] / n, 3), "brier": round(bsum["ours"] / n, 4)}]
    kb, ob = rows[0]["brier"], rows[1]["brier"]
    verdict = ("Kronos-base BEATS our factor blend — worth adopting for equity direction."
               if kb < ob - 0.003 else
               "our factor blend TIES/BEATS the 102M foundation model — Kronos stays a feature, not a standalone. "
               "Confirms the research: foundation models don't beat simple factors on near-efficient direction.")
    report = {"ts": int(time.time()), "predictions": n, "tickers": len(UNIVERSE),
              "task": "monthly equity direction, Kronos-base vs our factor blend, OOS",
              "rows": rows, "verdict": verdict}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(f"\n[kronos-bench] DONE — {n} predictions")
    for r in rows:
        print(f"  {r['model']:<32} acc {r['accuracy']*100:.1f}%  Brier {r['brier']}")
    print(f"  → {verdict}")


if __name__ == "__main__":
    main()
