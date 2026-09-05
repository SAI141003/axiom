"""
WEIGHT OPTIMIZER — tune the evaluator blend, honestly.

The batch showed the edge is on the DAILY timeframe, so we tune there. Randomized
search over evaluator weights + entry/exit thresholds, scored by a risk-adjusted
objective (Sharpe − λ·maxDrawdown) averaged across BTC/ETH/SOL daily TRAIN windows,
then judged on untouched HOLDOUT windows. We only SHIP the tuned config if it beats
the current default out-of-sample — otherwise we keep the default and say so. No
overfit theatre.

  python backtest/optimize.py [iterations]
Writes .data/strategy_weights.json (only if it wins OOS) + .data/optimize_report.json
"""
from __future__ import annotations

import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backtest import octobot_engine as engine
from signals.evaluators import TradingMode, build_strategy, _DEFAULT_WEIGHTS

ROOT = Path(__file__).resolve().parent.parent
OUT_WEIGHTS = ROOT / ".data" / "strategy_weights.json"
OUT_REPORT = ROOT / ".data" / "optimize_report.json"

SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"]
TF = "1d"
LAMBDA = 1.5          # drawdown penalty
MIN_TRADES = 4        # reject degenerate "barely trades" solutions
KEYS = list(_DEFAULT_WEIGHTS.keys())


def objective(m: dict) -> float:
    if m["trades"] < MIN_TRADES:
        return -5.0
    return m["sharpe"] - LAMBDA * m["max_drawdown"]


def score(tm: TradingMode, windows: list[list]) -> float:
    """Mean objective across symbol windows."""
    engine._TF = TF
    vals = [objective(engine.simulate(w, tm, 10.0, 5.0, 1000.0, 40)) for w in windows]
    return sum(vals) / len(vals)


def metrics(tm: TradingMode, windows: list[list]) -> dict:
    engine._TF = TF
    ms = [engine.simulate(w, tm, 10.0, 5.0, 1000.0, 40) for w in windows]
    return {"total_return": round(sum(m["total_return"] for m in ms) / len(ms), 4),
            "buyhold_return": round(sum(m["buyhold_return"] for m in ms) / len(ms), 4),
            "sharpe": round(sum(m["sharpe"] for m in ms) / len(ms), 3),
            "max_drawdown": round(sum(m["max_drawdown"] for m in ms) / len(ms), 4),
            "trades": round(sum(m["trades"] for m in ms) / len(ms), 1),
            "objective": round(score(tm, windows), 4)}


def main() -> None:
    iters = int(sys.argv[1]) if len(sys.argv) > 1 else 200
    random.seed(7)
    train, hold = [], []
    for sym in SYMBOLS:
        candles = engine.ccxt_adapter.fetch_ohlcv(sym, TF, 720)
        if len(candles) < 200:
            print(f"  skip {sym} ({len(candles)} candles)"); continue
        cut = int(len(candles) * 0.65)
        train.append(candles[:cut]); hold.append(candles[cut - 40:])   # keep 40-bar warmup overlap
    if not train:
        print("no data"); return

    # SELECTION windows: split each symbol's TRAIN into halves → a candidate must
    # be consistently good across all of them, not lucky on one stretch (anti-overfit).
    sel = []
    for w in train:
        mid = len(w) // 2
        sel.append(w[:mid + 20]); sel.append(w[mid - 20:])

    default_tm = TradingMode(build_strategy(_DEFAULT_WEIGHTS, "factor-blend"), 0.15, 0.05)
    base_train, base_hold = metrics(default_tm, train), metrics(default_tm, hold)

    best, best_obj, t0 = None, score(default_tm, sel), time.time()
    for _ in range(iters):
        w = {k: round(random.uniform(0.0, 1.5), 2) for k in KEYS}
        if sum(w.values()) < 0.3:
            continue
        enter = round(random.uniform(0.10, 0.30), 3)
        exit_ = round(random.uniform(0.0, 0.10), 3)
        tm = TradingMode(build_strategy(w, "factor-blend-tuned"), enter, exit_)
        o = score(tm, sel)                       # robust: mean objective over all sub-windows
        if o > best_obj:
            best_obj, best = o, {"weights": w, "enter": enter, "exit": exit_}

    result = {"ts": int(time.time()), "seconds": round(time.time() - t0, 1),
              "iterations": iters, "timeframe": TF, "symbols": SYMBOLS,
              "objective": f"Sharpe - {LAMBDA}*maxDD (mean over symbols, daily)",
              "default": {"weights": _DEFAULT_WEIGHTS, "enter": 0.15, "exit": 0.05,
                          "train": base_train, "holdout": base_hold}}

    if best is None:
        result["outcome"] = "no candidate beat the default on TRAIN — kept default"
        result["shipped"] = False
    else:
        tuned_tm = TradingMode(build_strategy(best["weights"], "factor-blend-tuned"),
                               best["enter"], best["exit"])
        tuned_train, tuned_hold = metrics(tuned_tm, train), metrics(tuned_tm, hold)
        result["tuned"] = {**best, "train": tuned_train, "holdout": tuned_hold}
        # SHIP only if it wins out-of-sample
        if tuned_hold["objective"] >= base_hold["objective"]:
            OUT_WEIGHTS.write_text(json.dumps({"name": "factor-blend-tuned", **best,
                                               "ts": int(time.time())}, indent=2))
            result["outcome"] = "tuned config WINS out-of-sample — shipped"
            result["shipped"] = True
        else:
            result["outcome"] = "tuned beat default on train but NOT on holdout — kept default (no overfit shipped)"
            result["shipped"] = False

    OUT_REPORT.write_text(json.dumps(result, indent=2))

    print(f"\nOPTIMIZE — {iters} candidates, daily, {result['seconds']}s")
    print(f"  objective: {result['objective']}\n")
    print(f"  DEFAULT   train Sharpe {base_train['sharpe']:+.2f} DD {base_train['max_drawdown']*100:.0f}% "
          f"obj {base_train['objective']:+.3f}   |   holdout Sharpe {base_hold['sharpe']:+.2f} "
          f"DD {base_hold['max_drawdown']*100:.0f}% obj {base_hold['objective']:+.3f}")
    if "tuned" in result:
        tt, th = result["tuned"]["train"], result["tuned"]["holdout"]
        print(f"  TUNED     train Sharpe {tt['sharpe']:+.2f} DD {tt['max_drawdown']*100:.0f}% "
              f"obj {tt['objective']:+.3f}   |   holdout Sharpe {th['sharpe']:+.2f} "
              f"DD {th['max_drawdown']*100:.0f}% obj {th['objective']:+.3f}")
        print(f"  weights: {result['tuned']['weights']}  enter {result['tuned']['enter']} exit {result['tuned']['exit']}")
    print(f"\n  → {result['outcome']}")


if __name__ == "__main__":
    main()
