"""
PER-SYMBOL ROUTING — is "order-flow on BTC/ETH, plain on SOL" real, or overfit?

Last experiment showed order-flow helps the majors but hurts SOL. The tempting fix
is to route a different strategy per symbol — but picking that from the same window
you judge on is overfitting. So we do it honestly: choose each symbol's strategy on
its TRAIN window only, then score the resulting per-symbol portfolio on an untouched
HOLDOUT against both global choices. It only ships if it wins out-of-sample.

  python backtest/per_symbol.py
Writes .data/per_symbol_report.json, and .data/symbol_strategy.json ONLY if it wins.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backtest import octobot_engine as engine
from signals.evaluators import TradingMode, build_strategy, _DEFAULT_WEIGHTS

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "per_symbol_report.json"
ROUTE = ROOT / ".data" / "symbol_strategy.json"

SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"]
TF = "1d"
LAMBDA = 1.5


def _tm(kind: str) -> TradingMode:
    w = dict(_DEFAULT_WEIGHTS) if kind == "default" else dict(_DEFAULT_WEIGHTS, obv=0.5, mfi=0.4)
    return TradingMode(build_strategy(w, kind), enter=0.15, exit=0.05)


def obj(m: dict) -> float:
    return -5.0 if m["trades"] < 4 else m["sharpe"] - LAMBDA * m["max_drawdown"]


def sim(candles: list, kind: str, warmup: int) -> dict:
    engine._TF = TF
    return engine.simulate(candles, _tm(kind), 10.0, 5.0, 1000.0, warmup)


def main() -> None:
    t0 = time.time()
    train, hold, route, per_sym = {}, {}, {}, []
    for sym in SYMBOLS:
        candles = engine.ccxt_adapter.fetch_ohlcv(sym, TF, 720)
        if len(candles) < 200:
            continue
        cut = int(len(candles) * 0.65)
        tr, ho = candles[:cut], candles[cut - 40:]
        train[sym], hold[sym] = tr, ho
        # choose per symbol on TRAIN only
        od, oo = obj(sim(tr, "default", 40)), obj(sim(tr, "orderflow", 40))
        pick = "orderflow" if oo > od else "default"
        route[sym] = pick
        # holdout metrics for the chosen vs each global
        hd, ho_of = sim(ho, "default", 40), sim(ho, "orderflow", 40)
        chosen = ho_of if pick == "orderflow" else hd
        per_sym.append({"symbol": sym, "picked_on_train": pick,
                        "train_obj_default": round(od, 3), "train_obj_orderflow": round(oo, 3),
                        "holdout_default": hd["total_return"], "holdout_orderflow": ho_of["total_return"],
                        "holdout_chosen": chosen["total_return"], "chosen_sharpe": chosen["sharpe"]})

    def agg(key):  # mean over symbols of a holdout metric
        vals = []
        for sym in route:
            hd, ho_of = sim(hold[sym], "default", 40), sim(hold[sym], "orderflow", 40)
            m = {"default": hd, "orderflow": ho_of, "per_symbol": ho_of if route[sym] == "orderflow" else hd}[key]
            vals.append(m)
        n = len(vals) or 1
        return {"mean_return": round(sum(v["total_return"] for v in vals) / n, 4),
                "mean_sharpe": round(sum(v["sharpe"] for v in vals) / n, 3),
                "beat_bh": sum(1 for v in vals if v["total_return"] > v["buyhold_return"])}

    holdout = {"global-default": agg("default"), "global-orderflow": agg("orderflow"),
               "per-symbol": agg("per_symbol")}
    # per-symbol ships only if it beats BOTH globals on holdout mean return
    ps = holdout["per-symbol"]
    ship = (ps["mean_return"] >= holdout["global-default"]["mean_return"]
            and ps["mean_return"] >= holdout["global-orderflow"]["mean_return"]
            and ps["mean_return"] > min(holdout["global-default"]["mean_return"],
                                        holdout["global-orderflow"]["mean_return"]))

    report = {"ts": int(time.time()), "seconds": round(time.time() - t0, 1),
              "timeframe": TF, "route": route, "per_symbol": per_sym, "holdout": holdout,
              "shipped": ship,
              "verdict": ("per-symbol routing WINS out-of-sample — shipped."
                          if ship else
                          "per-symbol routing does NOT beat both globals out-of-sample — it's overfit to the "
                          "train window. Kept the global blend.")}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    if ship:
        ROUTE.write_text(json.dumps({"route": route, "ts": int(time.time())}, indent=2))
    engine.run("BTC/USD", "1d")   # restore canonical single-report

    print(f"\nPER-SYMBOL ROUTING — daily, {report['seconds']}s\n")
    print(f"  train picks: {route}\n")
    for p in per_sym:
        print(f"  {p['symbol']:<8} train picked {p['picked_on_train']:<10} "
              f"(obj def {p['train_obj_default']:+.2f} vs of {p['train_obj_orderflow']:+.2f})  "
              f"→ holdout chosen {p['holdout_chosen']*100:+.1f}%")
    print(f"\n  HOLDOUT (out-of-sample) mean return:")
    for k, v in holdout.items():
        print(f"    {k:<18} {v['mean_return']*100:+6.1f}%  Sharpe {v['mean_sharpe']:+.2f}  beat b&h {v['beat_bh']}/{len(route)}")
    print(f"\n  → {report['verdict']}")


if __name__ == "__main__":
    main()
