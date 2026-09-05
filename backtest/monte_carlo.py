"""
Backtest — Monte Carlo Simulation

Runs N independent simulations of the strategy over the historical trade
distribution. Each simulation resamples trades with replacement (bootstrap),
applies the current Kelly sizing and bankroll dynamics, and records outcomes.

Metrics produced:
  p_ruin           — fraction of sims where bankroll fell below ruin_threshold
  return_pct_p5    — 5th-percentile final return (worst-case)
  return_pct_p10   — 10th-percentile
  return_pct_p50   — median
  return_pct_p90   — 90th-percentile (best-case)
  max_drawdown_p95 — 95th-percentile worst peak-to-trough drawdown
  sharpe_mean      — mean Sharpe ratio across simulations
  is_robust        — True if p_ruin < 0.05 and return_pct_p10 > 0

Regime conditioning:
  Also reports win-rate and EV broken down by:
    - Markov state (UP vs DOWN)
    - Category (crypto vs politics vs sports vs other)
  This answers "what market conditions break it?"
"""
from __future__ import annotations

import logging
import random
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from core.config import cfg

log = logging.getLogger(__name__)


@dataclass
class MonteCarloResult:
    n_sims: int
    n_trades_per_sim: int
    initial_bankroll: float
    ruin_threshold: float               # absolute bankroll level = ruin
    p_ruin: float                       # fraction of sims that hit ruin
    return_pct_p5:  float              # 5th-percentile final return
    return_pct_p10: float
    return_pct_p50: float
    return_pct_p90: float
    max_dd_p95: float                  # 95th-pct worst drawdown (fraction)
    sharpe_mean: float
    is_robust: bool                    # p_ruin < 5% and p10 return > 0%
    regime_stats: dict = field(default_factory=dict)
    notes: str = ""


def _max_drawdown(equity: list[float]) -> float:
    """Peak-to-trough max drawdown as a fraction."""
    peak = equity[0]
    max_dd = 0.0
    for v in equity:
        if v > peak:
            peak = v
        dd = (peak - v) / peak if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    return max_dd


def _sharpe(returns: list[float], periods_per_year: float = 252.0) -> float:
    if len(returns) < 2:
        return 0.0
    arr = np.array(returns)
    mean = float(np.mean(arr))
    std  = float(np.std(arr, ddof=1))
    if std == 0:
        return 0.0
    return (mean / std) * (periods_per_year ** 0.5)


def run(
    trades: list[dict],
    initial_bankroll: float = 1_000.0,
    n_sims: int | None = None,
    ruin_threshold_pct: float | None = None,
    seed: int = 42,
) -> MonteCarloResult:
    """
    Run Monte Carlo simulation.

    trades: list of dicts with keys:
        pnl         — realized P&L of the trade
        p_model     — model probability at trade time
        edge        — edge at trade time
        category    — market category string (optional)
        markov_state— "up" | "down" | "" (optional)
    """
    n_sims = n_sims or cfg.monte_carlo_n_sims
    ruin_pct = ruin_threshold_pct or cfg.monte_carlo_ruin_threshold
    ruin_abs = initial_bankroll * ruin_pct

    if len(trades) < 5:
        log.warning("MonteCarloSim: only %d trades — results unreliable", len(trades))
        return MonteCarloResult(
            n_sims=n_sims,
            n_trades_per_sim=len(trades),
            initial_bankroll=initial_bankroll,
            ruin_threshold=ruin_abs,
            p_ruin=0.0,
            return_pct_p5=0.0,
            return_pct_p10=0.0,
            return_pct_p50=0.0,
            return_pct_p90=0.0,
            max_dd_p95=0.0,
            sharpe_mean=0.0,
            is_robust=False,
            notes="insufficient_data",
        )

    rng = random.Random(seed)
    n_trades = len(trades)
    pnl_values = [float(t.get("pnl", 0.0)) for t in trades]

    final_bankrolls: list[float] = []
    max_drawdowns:   list[float] = []
    sharpes:         list[float] = []
    ruin_count = 0

    for _ in range(n_sims):
        bankroll = initial_bankroll
        equity: list[float] = [bankroll]
        daily_returns: list[float] = []
        ruined = False

        sample = rng.choices(pnl_values, k=n_trades)
        for pnl in sample:
            if bankroll <= ruin_abs:
                ruined = True
                break
            bankroll += pnl
            bankroll = max(bankroll, 0.0)
            daily_returns.append(pnl / max(equity[-1], 1.0))
            equity.append(bankroll)

        if ruined or bankroll <= ruin_abs:
            ruin_count += 1

        final_bankrolls.append(bankroll)
        max_drawdowns.append(_max_drawdown(equity))
        sharpes.append(_sharpe(daily_returns))

    final_arr = np.array(final_bankrolls)
    dd_arr    = np.array(max_drawdowns)
    returns_pct = (final_arr - initial_bankroll) / initial_bankroll * 100.0

    p_ruin = ruin_count / n_sims
    r_p5   = float(np.percentile(returns_pct, 5))
    r_p10  = float(np.percentile(returns_pct, 10))
    r_p50  = float(np.percentile(returns_pct, 50))
    r_p90  = float(np.percentile(returns_pct, 90))
    dd_p95 = float(np.percentile(dd_arr, 95))
    sh_mean = float(np.mean(sharpes))

    is_robust = p_ruin < 0.05 and r_p10 > 0.0

    # ── Regime conditioning ───────────────────────────────────────────────────
    regime_stats: dict = {}
    for dim in ("markov_state", "category"):
        groups: dict[str, list[float]] = {}
        for t in trades:
            key = str(t.get(dim, "unknown") or "unknown")
            groups.setdefault(key, []).append(float(t.get("pnl", 0.0)))
        for key, pnls in groups.items():
            arr = np.array(pnls)
            regime_stats[f"{dim}:{key}"] = {
                "n":       len(pnls),
                "win_rate": float(np.mean(arr > 0)),
                "avg_pnl":  float(np.mean(arr)),
                "ev":       float(np.sum(arr)),
            }

    verdict = "ROBUST" if is_robust else "FRAGILE"
    notes = (
        f"{verdict} | p_ruin={p_ruin:.1%} "
        f"p10_return={r_p10:+.1f}% p50={r_p50:+.1f}% "
        f"max_dd_p95={dd_p95:.1%} sharpe={sh_mean:.2f}"
    )
    log.info("MonteCarlo(%d sims, %d trades): %s", n_sims, n_trades, notes)

    return MonteCarloResult(
        n_sims=n_sims,
        n_trades_per_sim=n_trades,
        initial_bankroll=initial_bankroll,
        ruin_threshold=ruin_abs,
        p_ruin=p_ruin,
        return_pct_p5=r_p5,
        return_pct_p10=r_p10,
        return_pct_p50=r_p50,
        return_pct_p90=r_p90,
        max_dd_p95=dd_p95,
        sharpe_mean=sh_mean,
        is_robust=is_robust,
        regime_stats=regime_stats,
        notes=notes,
    )


async def run_from_db(
    lookback_days: int = 30,
    n_sims: int | None = None,
) -> MonteCarloResult:
    """Load historical trades from PostgreSQL and run simulation."""
    from persist.db import get_historical_trades
    import time
    start_ts = time.time() - lookback_days * 86_400
    trades = await get_historical_trades(start_ts=start_ts, limit=5_000)
    bankroll = cfg.initial_bankroll
    try:
        from persist.db import get_current_bankroll
        bankroll = await get_current_bankroll()
    except Exception:
        pass
    return run(trades, initial_bankroll=bankroll, n_sims=n_sims)
