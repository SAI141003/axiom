"""
Backtest & Replay Engine — Phase 13

Replays historical signals through the full pipeline with:
  - Realistic latency simulation (Normal(μ, σ) per stage)
  - Queue-position-based partial fill model
  - Transaction cost model (taker fee + bid-ask spread)
  - Shadow risk engine (paper-trades, does not touch live state)

Data source: historical trade records from PostgreSQL via db module.
For each historical signal, we re-evaluate:
  1. Did the edge hold up? (predicted vs realized)
  2. How much latency degraded the edge?
  3. What was the realized P&L if we had executed?

Output metrics:
  - Sharpe ratio (annualized, assuming 252 trading days)
  - Max drawdown (peak-to-trough on running P&L)
  - Win rate, avg edge predicted vs realized
  - Fill rate (fraction of simulated orders that fully filled)
  - Latency budget consumed vs predicted

Usage:
  from backtest.replay_engine import ReplayEngine, BacktestConfig
  result = await ReplayEngine().run(config)
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger(__name__)


# ── Config & Result types ─────────────────────────────────────────────────────

@dataclass
class BacktestConfig:
    """Configuration for a single backtest run."""
    start_ts: float          = 0.0          # Unix timestamp (0 = all history)
    end_ts: float            = 0.0          # Unix timestamp (0 = now)
    initial_bankroll: float  = 1_000.0
    # Latency model (Normal distribution per stage, in ms)
    ws_latency_mean:  float  = 8.0          # WebSocket receive latency
    ws_latency_std:   float  = 3.0
    signal_latency_mean: float = 150.0      # LLM + Heston ensemble
    signal_latency_std:  float = 50.0
    exec_latency_mean:  float = 40.0        # CLOB submission
    exec_latency_std:   float = 15.0
    # Execution model
    fee_rate: float          = 0.01         # taker fee per side
    slippage_bps: float      = 10.0         # additional price impact in basis points
    fill_rate_base: float    = 0.85         # probability of full fill (no queue priority)
    # Risk parameters (shadow risk engine)
    max_concurrent: int      = 10
    max_single_pct: float    = 0.05
    # Latency decay (mirrors live system)
    latency_decay_lambda: float = 0.15      # per second


@dataclass
class TradeRecord:
    signal_id: str
    market_id: str
    market_question: str
    strategy: str
    side: str
    size: float
    entry_price: float
    exit_price: float          # 1.0 on YES win, 0.0 on loss (for resolved markets)
    pnl: float
    edge_predicted: float
    edge_realized: float
    latency_total_ms: float
    filled: bool               # True = full fill, False = partial/miss
    fill_fraction: float       # 0.0–1.0
    ts: float


@dataclass
class BacktestResult:
    trades: list[TradeRecord] = field(default_factory=list)
    total_pnl: float          = 0.0
    win_rate: float           = 0.0
    avg_edge_predicted: float = 0.0
    avg_edge_realized: float  = 0.0
    fill_rate: float          = 0.0
    sharpe: float             = 0.0
    max_drawdown: float       = 0.0
    sortino: float            = 0.0
    calmar: float             = 0.0
    n_trades: int             = 0
    n_filtered_latency: int   = 0   # signals dropped by latency decay
    n_filtered_ev: int        = 0   # signals dropped by EV filter


# ── Simulation helpers ────────────────────────────────────────────────────────

def _sample_latency(mean: float, std: float) -> float:
    """Sample from truncated normal (no negative latency)."""
    return max(0.0, random.gauss(mean, std))


def _fill_probability(
    price: float,
    spread: float,
    fill_rate_base: float,
    size: float,
    typical_depth: float = 200.0,
) -> float:
    """
    Model probability that a limit order fully fills.
    Thinner liquidity (wide spread, small depth) → lower fill rate.
    """
    spread_penalty = max(0.0, min(0.5, spread / 0.05))     # spreads > 5 cents → penalty
    size_penalty   = max(0.0, min(0.4, (size / typical_depth) * 2))
    return max(0.05, fill_rate_base - spread_penalty * 0.3 - size_penalty * 0.2)


def _effective_price(price: float, side: str, slippage_bps: float) -> float:
    """Adjust entry price for slippage (always worse for the taker)."""
    slip = price * (slippage_bps / 10_000)
    if side == "YES":
        return min(0.99, price + slip)  # buy YES: pay more
    return max(0.01, price - slip)      # buy NO: pay more on NO side


def _compute_sharpe(pnl_series: list[float], periods_per_year: float = 252) -> float:
    """Sharpe ratio from a P&L series (assumes daily periods)."""
    n = len(pnl_series)
    if n < 2:
        return 0.0
    mean = sum(pnl_series) / n
    var  = sum((x - mean) ** 2 for x in pnl_series) / (n - 1)
    std  = math.sqrt(var) if var > 0 else 0.0
    if std == 0:
        return 0.0
    return (mean / std) * math.sqrt(periods_per_year)


def _compute_sortino(pnl_series: list[float], periods_per_year: float = 252) -> float:
    """Sortino ratio (uses downside deviation only)."""
    n = len(pnl_series)
    if n < 2:
        return 0.0
    mean = sum(pnl_series) / n
    neg  = [x for x in pnl_series if x < 0]
    if len(neg) < 2:
        return float("inf") if mean > 0 else 0.0
    neg_var = sum(x ** 2 for x in neg) / len(neg)
    downside_std = math.sqrt(neg_var)
    if downside_std == 0:
        return 0.0
    return (mean / downside_std) * math.sqrt(periods_per_year)


def _compute_max_drawdown(equity_curve: list[float]) -> float:
    """Max peak-to-trough drawdown as a fraction of peak equity."""
    peak = equity_curve[0] if equity_curve else 0.0
    max_dd = 0.0
    for v in equity_curve:
        if v > peak:
            peak = v
        dd = (peak - v) / max(peak, 1.0)
        if dd > max_dd:
            max_dd = dd
    return max_dd


# ── Replay Engine ─────────────────────────────────────────────────────────────

class ReplayEngine:
    """
    Replays historical signals and simulates trade outcomes.

    Each historical trade in the DB has:
      - Signal predictions (edge, p_model, p_market)
      - Actual execution details (entry price, side, size)
      - Resolution outcome (if market has resolved)

    We re-simulate with configurable latency and slippage to answer:
      "What would our P&L have been if we'd been X ms slower?"
    """

    async def run(self, config: BacktestConfig) -> BacktestResult:
        """Run backtest over all historical trades matching config time range."""
        log.info(
            "ReplayEngine: loading historical trades (start=%s end=%s)",
            config.start_ts, config.end_ts
        )

        records = await self._load_trades(config)
        if not records:
            log.warning("ReplayEngine: no historical trades found")
            return BacktestResult()

        log.info("ReplayEngine: simulating %d historical records", len(records))
        return self._simulate(records, config)

    async def _load_trades(self, config: BacktestConfig) -> list[dict]:
        """Load historical trade records from PostgreSQL."""
        try:
            from persist import db
            trades = await db.get_historical_trades(
                start_ts=config.start_ts or None,
                end_ts=config.end_ts or None,
                limit=5_000,
            )
            return trades
        except Exception as exc:
            log.warning("ReplayEngine: DB load failed: %s", exc)
            return []

    def _simulate(self, records: list[dict], config: BacktestConfig) -> BacktestResult:
        """Simulate execution with latency and slippage models."""
        from signals.microstructure import decayed_edge, ev_is_positive

        trades: list[TradeRecord]  = []
        equity                     = config.initial_bankroll
        equity_curve: list[float]  = [equity]
        n_filtered_latency         = 0
        n_filtered_ev              = 0
        open_count                 = 0
        open_exposure: dict[str, float] = {}

        for rec in records:
            # ── 1. Simulate pipeline latency ─────────────────────────────────
            ws_lat     = _sample_latency(config.ws_latency_mean, config.ws_latency_std)
            sig_lat    = _sample_latency(config.signal_latency_mean, config.signal_latency_std)
            exec_lat   = _sample_latency(config.exec_latency_mean, config.exec_latency_std)
            total_lat  = ws_lat + sig_lat + exec_lat

            edge_raw   = float(rec.get("edge", 0.0))
            eff_edge   = decayed_edge(edge_raw, total_lat, config.latency_decay_lambda)

            if eff_edge < 0.02:
                n_filtered_latency += 1
                continue

            side       = rec.get("side", "YES")
            price_raw  = float(rec.get("price", 0.5))
            p_win      = float(rec.get("p_model", price_raw + eff_edge))

            # ── 2. EV filter ──────────────────────────────────────────────────
            eff_price  = _effective_price(price_raw, side, config.slippage_bps)
            if not ev_is_positive(p_win, eff_price, config.fee_rate):
                n_filtered_ev += 1
                continue

            # ── 3. Shadow risk: concentration + concurrency ───────────────────
            market_id = rec.get("market_id", "unknown")
            size      = float(rec.get("size", 10.0))
            exposure  = open_exposure.get(market_id, 0.0)
            max_expo  = equity * config.max_single_pct
            if exposure + size > max_expo:
                size = max(0.0, max_expo - exposure)
            if size < 1.0:
                continue
            if open_count >= config.max_concurrent:
                continue

            # ── 4. Fill simulation ────────────────────────────────────────────
            spread    = abs(float(rec.get("spread", 0.03)))
            fill_p    = _fill_probability(eff_price, spread, config.fill_rate_base, size)
            rand_fill = random.random()
            if rand_fill >= fill_p:
                fill_frac = rand_fill * 0.5   # partial fill
            else:
                fill_frac = 1.0

            filled_size = size * fill_frac
            filled      = fill_frac >= 0.95

            # ── 5. P&L calculation ────────────────────────────────────────────
            # Use actual resolution if available, else use p_model as proxy
            resolution = rec.get("resolution")   # 1.0 if YES resolved, 0.0 if NO
            if resolution is not None:
                outcome = float(resolution)
            else:
                # Simulate outcome from p_model (Monte Carlo)
                outcome = 1.0 if random.random() < p_win else 0.0

            if side == "YES":
                exit_p = outcome
                pnl    = filled_size * (exit_p - eff_price) - filled_size * config.fee_rate
            else:
                exit_p = 1.0 - outcome
                pnl    = filled_size * (exit_p - eff_price) - filled_size * config.fee_rate

            edge_realized = (pnl / max(filled_size, 0.01)) + config.fee_rate

            # ── 6. Update equity and exposure ─────────────────────────────────
            equity                    += pnl
            equity_curve.append(equity)
            open_exposure[market_id]   = max(0.0, exposure + filled_size - pnl)
            if filled:
                open_count = max(0, open_count - 1)

            trades.append(TradeRecord(
                signal_id       = str(rec.get("id", "")),
                market_id       = market_id,
                market_question = str(rec.get("question", ""))[:80],
                strategy        = str(rec.get("strategy", "signal")),
                side            = side,
                size            = filled_size,
                entry_price     = eff_price,
                exit_price      = exit_p,
                pnl             = pnl,
                edge_predicted  = edge_raw,
                edge_realized   = edge_realized,
                latency_total_ms = total_lat,
                filled          = filled,
                fill_fraction   = fill_frac,
                ts              = float(rec.get("ts", time.time())),
            ))

        if not trades:
            return BacktestResult(
                n_trades=0,
                n_filtered_latency=n_filtered_latency,
                n_filtered_ev=n_filtered_ev,
            )

        # ── Aggregate metrics ─────────────────────────────────────────────────
        pnl_series   = [t.pnl for t in trades]
        wins         = [t for t in trades if t.pnl > 0]
        total_pnl    = sum(pnl_series)
        max_dd       = _compute_max_drawdown(equity_curve)

        result = BacktestResult(
            trades             = trades,
            total_pnl          = round(total_pnl, 4),
            win_rate           = round(len(wins) / len(trades), 4),
            avg_edge_predicted = round(sum(t.edge_predicted for t in trades) / len(trades), 4),
            avg_edge_realized  = round(sum(t.edge_realized for t in trades) / len(trades), 4),
            fill_rate          = round(sum(t.fill_fraction for t in trades) / len(trades), 4),
            sharpe             = round(_compute_sharpe(pnl_series), 4),
            sortino            = round(_compute_sortino(pnl_series), 4),
            max_drawdown       = round(max_dd, 4),
            calmar             = round(total_pnl / max(max_dd * config.initial_bankroll, 0.01), 4),
            n_trades           = len(trades),
            n_filtered_latency = n_filtered_latency,
            n_filtered_ev      = n_filtered_ev,
        )

        log.info(
            "ReplayEngine: %d trades | PnL=%.2f | Sharpe=%.2f | "
            "WinRate=%.0f%% | MaxDD=%.1f%% | FillRate=%.0f%% | "
            "Filtered(decay=%d ev=%d)",
            result.n_trades, result.total_pnl, result.sharpe,
            result.win_rate * 100, result.max_drawdown * 100,
            result.fill_rate * 100,
            result.n_filtered_latency, result.n_filtered_ev,
        )
        return result

    def run_sync(self, config: Optional[BacktestConfig] = None) -> BacktestResult:
        """Synchronous entry point for CLI/scripts."""
        if config is None:
            config = BacktestConfig()
        return asyncio.run(self.run(config))
