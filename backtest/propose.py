"""
PROPOSE — judge one candidate strategy blend, out-of-sample.

The "Automate Strategy Finding with LLM" loop (Kou et al., EMNLP 2025) in its
honest form: a model may PROPOSE any evaluator blend it likes; the engine scores
it on the same train/holdout split the optimizer uses and says whether it beats
the shipped default where it counts -- on data it never saw. Nothing here ships
anything. It only answers "would this have earned the right to?"

  python backtest/propose.py '{"weights": {"momentum": 1.0, "rsi": 0.8}, "enter": 0.2, "exit": 0.05}'

Prints one JSON object: default vs candidate on train and holdout, and a verdict.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backtest import octobot_engine as engine
from backtest.optimize import SYMBOLS, TF, metrics
from signals.evaluators import TradingMode, build_strategy, _DEFAULT_WEIGHTS, _registry


def windows():
    train, hold = [], []
    for sym in SYMBOLS:
        candles = engine.ccxt_adapter.fetch_ohlcv(sym, TF, 720)
        if len(candles) < 200:
            continue
        cut = int(len(candles) * 0.65)
        train.append(candles[:cut]); hold.append(candles[cut - 40:])
    return train, hold


def judge(weights: dict, enter: float = 0.15, exit_: float = 0.05) -> dict:
    known = set(_registry().keys())
    bad = sorted(set(weights) - known)
    if bad:
        return {"error": f"unknown evaluators: {bad}", "known": sorted(known)}
    train, hold = windows()
    if not train:
        return {"error": "no market data"}
    default_tm = TradingMode(build_strategy(_DEFAULT_WEIGHTS, "factor-blend"), 0.15, 0.05)
    cand_tm = TradingMode(build_strategy(weights, "proposed"), enter, exit_)
    d_tr, d_ho = metrics(default_tm, train), metrics(default_tm, hold)
    c_tr, c_ho = metrics(cand_tm, train), metrics(cand_tm, hold)
    wins_train = c_tr["objective"] > d_tr["objective"]
    wins_hold = c_ho["objective"] > d_ho["objective"]
    if wins_train and wins_hold:
        verdict = "beats the default in-sample AND out-of-sample — worth a full optimizer run before shipping"
    elif wins_train:
        verdict = "beats the default in-sample but NOT out-of-sample — overfit; rejected"
    elif wins_hold:
        verdict = "loses in-sample but wins out-of-sample — likely noise on a small holdout; rejected"
    else:
        verdict = "does not beat the default on either window — rejected"
    return {"timeframe": TF, "symbols": SYMBOLS,
            "candidate": {"weights": weights, "enter": enter, "exit": exit_, "train": c_tr, "holdout": c_ho},
            "default": {"weights": _DEFAULT_WEIGHTS, "enter": 0.15, "exit": 0.05, "train": d_tr, "holdout": d_ho},
            "wins_train": wins_train, "wins_holdout": wins_hold, "verdict": verdict, "shipped": False}


if __name__ == "__main__":
    spec = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    out = judge(spec.get("weights") or _DEFAULT_WEIGHTS, float(spec.get("enter", 0.15)), float(spec.get("exit", 0.05)))
    print(json.dumps(out))
