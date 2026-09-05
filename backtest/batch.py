"""
BATCH BACKTEST — map where the strategy actually has edge.

Runs the current strategy across a grid of symbols × timeframes and reports, for
each cell, strategy return vs buy-&-hold, Sharpe, drawdown, and how many walk-
forward folds beat buy-&-hold. Edge = beats b&h AND positive Sharpe AND a majority
of folds beat b&h. One honest landscape instead of a single cherry-picked run.

  python backtest/batch.py
Writes .data/backtest_batch.json for the /backtest-lab page.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backtest import octobot_engine as engine

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "backtest_batch.json"

SYMBOLS = ["BTC/USD", "ETH/USD", "SOL/USD"]
TIMEFRAMES = ["1d", "4h", "1h"]


def _edge(m: dict, wf_beat: int, wf_total: int) -> bool:
    return (m["total_return"] > m["buyhold_return"] and m["sharpe"] > 0
            and wf_total > 0 and wf_beat >= (wf_total + 1) // 2)


def main() -> None:
    cells, t0 = [], time.time()
    for sym in SYMBOLS:
        for tf in TIMEFRAMES:
            rep = engine.run(sym, tf)
            if "error" in rep:
                cells.append({"symbol": sym, "timeframe": tf, "error": rep["error"]}); continue
            m = rep["metrics"]
            wf_total = len(rep["walk_forward"]); wf_beat = rep["wf_folds_beating_bh"]
            cells.append({
                "symbol": sym, "timeframe": tf, "candles": rep["candles"],
                "total_return": m["total_return"], "buyhold_return": m["buyhold_return"],
                "sharpe": m["sharpe"], "max_drawdown": m["max_drawdown"],
                "win_rate": m["win_rate"], "trades": m["trades"], "exposure": m["exposure"],
                "wf_beat": wf_beat, "wf_total": wf_total,
                "edge": _edge(m, wf_beat, wf_total),
            })
            print(f"  {sym:<8} {tf:<3}  strat {m['total_return']*100:+6.1f}%  "
                  f"b&h {m['buyhold_return']*100:+6.1f}%  Sharpe {m['sharpe']:+.2f}  "
                  f"DD {m['max_drawdown']*100:4.0f}%  wf {wf_beat}/{wf_total}"
                  f"  {'★ EDGE' if _edge(m, wf_beat, wf_total) else ''}")

    ok = [c for c in cells if c.get("edge")]
    report = {"ts": int(time.time()), "seconds": round(time.time() - t0, 1),
              "strategy": engine.default_strategy().strategy.name,
              "grid": cells, "edge_cells": len(ok), "total_cells": len(cells)}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    # leave the single-report as BTC/USD 1d so /backtest-lab has a canonical view
    engine.run("BTC/USD", "1d")
    print(f"\n  {len(ok)}/{len(cells)} cells show edge → {OUT}")


if __name__ == "__main__":
    main()
