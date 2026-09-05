"""
BACKTEST ENGINE — OctoBot's validation pillar, native and honest.

Event-driven single-asset backtester: pulls REAL OHLCV via CCXT, walks bar by bar,
asks the Trading Mode for a decision using only data available up to that bar (no
look-ahead), and executes with realistic FEES + SLIPPAGE. Reports the metrics that
actually decide whether a strategy is worth real money — total return vs buy-&-hold,
Sharpe, max drawdown, win rate, exposure — plus WALK-FORWARD validation (split the
history into folds; a strategy that only works on one fold is overfit, not alpha).

  python backtest/octobot_engine.py BTC/USD 1d
  python backtest/octobot_engine.py ETH/USD 4h

Writes .data/backtest_report.json for the /backtest-lab page. No orders, no keys —
this is measurement, not trading.
"""
from __future__ import annotations

import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from execution import ccxt_adapter
from signals.evaluators import TradingMode, default_strategy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "backtest_report.json"

_PERIODS_PER_YEAR = {"1m": 525600, "5m": 105120, "15m": 35040, "1h": 8760,
                     "4h": 2190, "1d": 365, "1w": 52}


def _max_drawdown(equity: list[float]) -> float:
    peak, mdd = equity[0], 0.0
    for e in equity:
        peak = max(peak, e)
        mdd = max(mdd, (peak - e) / peak if peak else 0.0)
    return mdd


def simulate(candles: list[list], tm: TradingMode, fees_bps: float, slippage_bps: float,
             start_cash: float, warmup: int) -> dict:
    """Core loop. candles = [[ts,o,h,l,c,v],...]. Returns metrics + equity curve."""
    closes = [c[4] for c in candles]
    highs = [c[2] for c in candles]
    lows = [c[3] for c in candles]
    vols = [c[5] for c in candles]
    ts = [c[0] for c in candles]
    fee = fees_bps / 1e4
    slip = slippage_bps / 1e4

    cash, units, position = start_cash, 0.0, "FLAT"
    entry_px = 0.0
    equity, bench, trades = [], [], []
    bars_in_market = 0

    for i in range(warmup, len(closes)):
        px = closes[i]
        ctx = {"close": closes[: i + 1], "high": highs[: i + 1],
               "low": lows[: i + 1], "volume": vols[: i + 1]}
        d = tm.decide(ctx, position)

        if d["action"] == "LONG" and position == "FLAT":
            fill = px * (1 + slip)
            units = (cash * (1 - fee)) / fill
            entry_px = fill; cash = 0.0; position = "LONG"
        elif d["action"] == "CLOSE" and position == "LONG":
            fill = px * (1 - slip)
            cash = units * fill * (1 - fee)
            trades.append({"entry": round(entry_px, 6), "exit": round(fill, 6),
                           "ret": round(fill / entry_px - 1, 4), "won": fill > entry_px})
            units = 0.0; position = "FLAT"

        if position == "LONG":
            bars_in_market += 1
        equity.append(cash + units * px)
        bench.append(start_cash * (px / closes[warmup]))

    # close any open position at the last price (mark to realized)
    if position == "LONG":
        fill = closes[-1] * (1 - slip)
        cash = units * fill * (1 - fee)
        trades.append({"entry": round(entry_px, 6), "exit": round(fill, 6),
                       "ret": round(fill / entry_px - 1, 4), "won": fill > entry_px})
        equity[-1] = cash

    rets = [equity[j] / equity[j - 1] - 1 for j in range(1, len(equity))]
    ppy = _PERIODS_PER_YEAR.get(_TF, 365)
    sharpe = 0.0
    if len(rets) > 2 and statistics.pstdev(rets) > 0:
        sharpe = (statistics.mean(rets) / statistics.pstdev(rets)) * (ppy ** 0.5)
    wins = sum(1 for t in trades if t["won"])
    return {
        "start": start_cash, "end": round(equity[-1], 2),
        "total_return": round(equity[-1] / start_cash - 1, 4),
        "buyhold_return": round(bench[-1] / start_cash - 1, 4),
        "sharpe": round(sharpe, 2), "max_drawdown": round(_max_drawdown(equity), 4),
        "trades": len(trades), "win_rate": round(wins / len(trades), 3) if trades else None,
        "exposure": round(bars_in_market / max(1, len(equity)), 3),
        "equity_curve": equity, "bench_curve": bench, "ts": ts[warmup:],
    }


def _downsample(xs: list, n: int = 180) -> list:
    if len(xs) <= n:
        return xs
    step = len(xs) / n
    return [xs[int(k * step)] for k in range(n)]


def run(symbol: str, timeframe: str, tm: TradingMode | None = None, fees_bps: float = 10.0,
        slippage_bps: float = 5.0, start_cash: float = 1000.0, limit: int = 720,
        folds: int = 3) -> dict:
    global _TF
    _TF = timeframe
    tm = tm or default_strategy()
    candles = ccxt_adapter.fetch_ohlcv(symbol, timeframe, limit)
    if len(candles) < 80:
        return {"error": f"not enough candles for {symbol} {timeframe} ({len(candles)})"}
    warmup = 40

    full = simulate(candles, tm, fees_bps, slippage_bps, start_cash, warmup)

    # walk-forward: consecutive folds of the post-warmup history
    wf, usable = [], candles[warmup:]
    fold_sz = len(usable) // folds
    for k in range(folds):
        seg = usable[k * fold_sz: (k + 1) * fold_sz] if k < folds - 1 else usable[k * fold_sz:]
        if len(seg) < 40:
            continue
        r = simulate(seg, tm, fees_bps, slippage_bps, start_cash, 20)
        wf.append({"fold": k + 1, "bars": len(seg), "total_return": r["total_return"],
                   "buyhold_return": r["buyhold_return"], "sharpe": r["sharpe"],
                   "max_drawdown": r["max_drawdown"], "trades": r["trades"],
                   "beat_bh": r["total_return"] > r["buyhold_return"]})

    report = {
        "ts": int(time.time()), "symbol": symbol, "timeframe": timeframe,
        "exchange": ccxt_adapter._exchange_id(), "candles": len(candles),
        "fees_bps": fees_bps, "slippage_bps": slippage_bps, "start_cash": start_cash,
        "strategy": tm.strategy.name,
        "components": [{"name": ev.name, "weight": w} for ev, w in tm.strategy.components],
        "metrics": {k: full[k] for k in ("start", "end", "total_return", "buyhold_return",
                                         "sharpe", "max_drawdown", "trades", "win_rate", "exposure")},
        "equity_curve": _downsample(full["equity_curve"]),
        "bench_curve": _downsample(full["bench_curve"]),
        "ts_axis": _downsample(full["ts"]),
        "walk_forward": wf,
        "wf_folds_beating_bh": sum(1 for f in wf if f["beat_bh"]),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    return report


_TF = "1d"


def main() -> None:
    symbol = sys.argv[1] if len(sys.argv) > 1 else "BTC/USD"
    timeframe = sys.argv[2] if len(sys.argv) > 2 else "1d"
    rep = run(symbol, timeframe)
    if "error" in rep:
        print(rep["error"]); return
    m = rep["metrics"]
    print(f"\nBACKTEST — {symbol} {timeframe} on {rep['exchange']} · {rep['candles']} candles · "
          f"strategy '{rep['strategy']}' (fees {rep['fees_bps']}bps, slip {rep['slippage_bps']}bps)\n")
    print(f"  strategy return   {m['total_return']*100:+7.1f}%     buy & hold {m['buyhold_return']*100:+.1f}%")
    print(f"  Sharpe            {m['sharpe']:>7.2f}     max drawdown {m['max_drawdown']*100:.1f}%")
    print(f"  trades {m['trades']}  win rate {(m['win_rate'] or 0)*100:.0f}%  exposure {m['exposure']*100:.0f}%")
    print(f"\n  walk-forward ({len(rep['walk_forward'])} folds, {rep['wf_folds_beating_bh']} beat buy&hold):")
    for f in rep["walk_forward"]:
        mark = "✓" if f["beat_bh"] else "·"
        print(f"    {mark} fold {f['fold']}: strat {f['total_return']*100:+6.1f}%  "
              f"b&h {f['buyhold_return']*100:+6.1f}%  Sharpe {f['sharpe']:+.2f}  ({f['trades']} trades)")
    print(f"\n  report → {OUT}")


if __name__ == "__main__":
    main()
