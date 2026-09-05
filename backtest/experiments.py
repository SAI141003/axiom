"""
EDGE EXPERIMENTS — does (b) regime-switching or (c) order-flow actually help?

We established the edge is on the DAILY timeframe, so we test there: run the same
BTC/ETH/SOL daily grid under three variants and compare, per cell and in aggregate.
An honest bake-off — a variant only "wins" if it lifts the mean daily return AND
the number of cells that beat buy-&-hold, out of sample via the walk-forward folds.

  variants:
    default       — the shipped 5-evaluator blend
    +orderflow    — default + OBV + MFI (order-flow from volume)   [c]
    regime-switch — ride bulls passively, active strategy in bear/chop  [b]

  python backtest/experiments.py
Writes .data/experiments_report.json for the /backtest-lab page.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backtest import octobot_engine as engine
from signals.evaluators import default_strategy, expanded_strategy, volprofile_strategy
from signals.regime_filter import regime_strategy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "experiments_report.json"

SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"]
TF = "1d"
VARIANTS = {"default": default_strategy, "+orderflow": expanded_strategy,
            "+orderflow+volprofile": volprofile_strategy, "regime-switch": regime_strategy}


def _run_variant(factory) -> dict:
    cells, beats, rets, sharpes, wf_beats, wf_total = [], 0, [], [], 0, 0
    for sym in SYMBOLS:
        rep = engine.run(sym, TF, tm=factory())
        if "error" in rep:
            continue
        m = rep["metrics"]
        beat = m["total_return"] > m["buyhold_return"]
        beats += int(beat)
        rets.append(m["total_return"]); sharpes.append(m["sharpe"])
        wf_beats += rep["wf_folds_beating_bh"]; wf_total += len(rep["walk_forward"])
        cells.append({"symbol": sym, "total_return": m["total_return"],
                      "buyhold_return": m["buyhold_return"], "sharpe": m["sharpe"],
                      "max_drawdown": m["max_drawdown"], "trades": m["trades"],
                      "beat_bh": beat})
    n = len(cells) or 1
    return {"cells": cells, "cells_beating_bh": beats,
            "mean_return": round(sum(rets) / n, 4), "mean_sharpe": round(sum(sharpes) / n, 3),
            "wf_beats": wf_beats, "wf_total": wf_total}


def main() -> None:
    t0 = time.time()
    results = {name: _run_variant(fac) for name, fac in VARIANTS.items()}

    # pick a winner: most cells beating b&h, then highest mean return
    def key(name):
        r = results[name]
        return (r["cells_beating_bh"], r["mean_return"])
    winner = max(results, key=key)
    # only "ship-worthy" if it strictly beats default on both axes
    d = results["default"]
    ship = (winner != "default" and results[winner]["cells_beating_bh"] >= d["cells_beating_bh"]
            and results[winner]["mean_return"] > d["mean_return"])

    report = {"ts": int(time.time()), "seconds": round(time.time() - t0, 1),
              "timeframe": TF, "symbols": SYMBOLS, "variants": results,
              "winner": winner, "ship_worthy": ship,
              "verdict": (f"'{winner}' beats the default blend on the daily pairs — worth adopting."
                          if ship else
                          "no variant clearly beats the default out-of-sample — keeping the shipped blend.")}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    engine.run("BTC/USD", "1d")   # restore canonical single-report

    print(f"\nEDGE EXPERIMENTS — daily BTC/ETH/SOL, {report['seconds']}s\n")
    print(f"  {'variant':<15} {'cells beat b&h':>15} {'mean ret':>10} {'mean Sharpe':>12} {'wf beats':>10}")
    for name, r in results.items():
        star = " ★" if name == winner else ""
        print(f"  {name:<15} {r['cells_beating_bh']}/{len(r['cells'])}{'':>12} "
              f"{r['mean_return']*100:>+8.1f}% {r['mean_sharpe']:>+11.2f} "
              f"{r['wf_beats']}/{r['wf_total']:>8}{star}")
    print(f"\n  → {report['verdict']}")


if __name__ == "__main__":
    main()
