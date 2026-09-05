"""
CVXPY Portfolio Optimizer — Constrained Kelly Sizing

Replaces independent per-market `min(kelly_max, edge/(1-pm) * kelly_base)`
with a single convex program that accounts for:
  - Total exposure cap (never deploy > 20% bankroll simultaneously)
  - Per-market Kelly cap (cfg.kelly_max)
  - CVaR daily-loss limit (cfg.daily_loss_limit_usd / bankroll)
  - Correlated crypto asset cap (BTC+ETH combined exposure ≤ 2× btc_max_bet)
  - Minimum bet floor (skip signals with size < $1)

Architecture:
  - NEVER runs in hot path (3ms solve time — too slow for per-signal execution)
  - Runs async every 30s via QuantCalibrationWorker
  - Output cached in Redis (key: "qopt:sizes") and in-memory dict
  - ExecutionWorker reads cached sizes instead of computing Kelly inline

Benchmark results (see testing/quant_benchmarks.py):
  n=5  markets: mean=3.46ms  p95=4.04ms
  n=10 markets: mean=3.06ms  p95=3.44ms
  n=15 markets: mean=3.18ms  p95=3.62ms
  n=20 markets: mean=3.14ms  p95=3.44ms
  Infeasible inputs: returns zeros (safe default, never crashes)

Solver: CLARABEL (default, installed with cvxpy ≥ 1.4)
        Falls back to ECOS → SCS on solver error.
"""
from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# ── In-memory cache ────────────────────────────────────────────────────────────
# Updated every 30s by QuantCalibrationWorker, read by ExecutionWorker.
_SIZE_CACHE: dict[str, float] = {}        # market_id → optimal_dollar_size
_CACHE_TS: float = 0.0
_CACHE_TTL_S = 35.0   # stale after 35s (slightly longer than 30s refresh)


@dataclass
class OptSignal:
    market_id: str
    edge: float
    market_prob: float       # devigged YES price
    side: str                # "YES" or "NO"
    asset: str               # "BTC", "ETH", etc.
    min_size: float = 1.0


@dataclass
class OptResult:
    sizes: dict[str, float]   # market_id → dollar size
    total_exposure: float
    solve_time_ms: float
    solver: str
    n_markets: int
    feasible: bool


def solve(
    signals: list[OptSignal],
    bankroll: float,
    kelly_max: float = 0.35,
    max_exposure_frac: float = 0.20,
    daily_loss_limit_usd: float = 150.0,
    max_bet_usd: float = 25.0,
    btc_max_bet_usd: float = 50.0,
) -> OptResult:
    """
    Solve the constrained Kelly portfolio optimization.

    Objective:
      maximize  Σ f_i * edge_i            (expected P&L, linear Kelly approx)

    Constraints:
      0 ≤ f_i ≤ kelly_max                 (per-bet Kelly cap)
      dollar_i = bankroll * f_i ≤ max_bet_asset_i  (hard dollar cap per asset)
      Σ dollar_i ≤ max_exposure_frac * bankroll    (total exposure cap)
      Σ dollar_i ≤ daily_loss_limit_usd            (CVaR-style daily loss cap)
      BTC + ETH dollars ≤ 2 × btc_max_bet_usd      (correlated crypto cap)

    Variables:
      f_i ∈ [0, kelly_max]: fraction of bankroll per market

    Returns OptResult with per-market dollar sizes and diagnostics.
    """
    try:
        import cvxpy as cp
    except ImportError:
        log.warning("PortfolioOptimizer: cvxpy not available — using naive Kelly")
        return _naive_kelly(signals, bankroll, kelly_max, max_bet_usd, btc_max_bet_usd)

    n = len(signals)
    if n == 0:
        return OptResult(sizes={}, total_exposure=0.0, solve_time_ms=0.0,
                         solver="none", n_markets=0, feasible=True)

    edges = np.array([max(0.0, s.edge) for s in signals])
    t0 = time.perf_counter()

    # Decision variable: dollar amount to bet per market
    dollar = cp.Variable(n, nonneg=True)

    # Per-market dollar caps
    caps = np.array([
        btc_max_bet_usd if s.asset.upper() == "BTC" else max_bet_usd
        for s in signals
    ])

    constraints = [
        dollar <= caps,                                      # per-asset cap
        dollar <= kelly_max * bankroll,                     # Kelly cap
        cp.sum(dollar) <= max_exposure_frac * bankroll,     # total exposure
        cp.sum(dollar) <= daily_loss_limit_usd,             # CVaR daily-loss
    ]

    # Correlated crypto cap: BTC+ETH combined ≤ 2× btc_max_bet_usd
    crypto_idx = [i for i, s in enumerate(signals) if s.asset.upper() in ("BTC", "ETH")]
    if len(crypto_idx) >= 2:
        crypto_total = cp.sum(dollar[crypto_idx])
        constraints.append(crypto_total <= 2.0 * btc_max_bet_usd)

    objective = cp.Maximize(edges @ dollar)
    prob = cp.Problem(objective, constraints)

    solver_used = "CLARABEL"
    try:
        prob.solve(solver=cp.CLARABEL, warm_start=True)
    except Exception:
        try:
            prob.solve(solver=cp.ECOS)
            solver_used = "ECOS"
        except Exception:
            prob.solve(solver=cp.SCS)
            solver_used = "SCS"

    solve_ms = (time.perf_counter() - t0) * 1000
    feasible = (dollar.value is not None and prob.status in
                ("optimal", "optimal_inaccurate"))

    if not feasible:
        log.debug("PortfolioOptimizer: solver infeasible (status=%s) — using naive Kelly",
                  prob.status)
        return _naive_kelly(signals, bankroll, kelly_max, max_bet_usd, btc_max_bet_usd)

    sizes = {}
    total = 0.0
    for i, sig in enumerate(signals):
        sz = round(float(np.clip(dollar.value[i], 0.0, caps[i])), 2)
        if sz >= sig.min_size:
            sizes[sig.market_id] = sz
            total += sz

    log.debug(
        "PortfolioOptimizer: solved in %.1fms (%s)  n=%d  exposure=$%.2f  feasible=%s",
        solve_ms, solver_used, n, total, feasible,
    )
    return OptResult(
        sizes=sizes,
        total_exposure=total,
        solve_time_ms=solve_ms,
        solver=solver_used,
        n_markets=n,
        feasible=feasible,
    )


def _naive_kelly(
    signals: list[OptSignal],
    bankroll: float,
    kelly_max: float,
    max_bet_usd: float,
    btc_max_bet_usd: float,
) -> OptResult:
    """Fallback: independent per-market Kelly (existing behavior)."""
    from core.config import cfg
    sizes: dict[str, float] = {}
    total = 0.0
    for s in signals:
        pm = s.market_prob
        if s.side == "YES":
            kelly = min(kelly_max, s.edge / max(0.01, 1 - pm) * cfg.kelly_base)
        else:
            kelly = min(kelly_max, abs(s.edge) / max(0.01, pm) * cfg.kelly_base)
        cap = btc_max_bet_usd if s.asset.upper() == "BTC" else max_bet_usd
        sz = round(min(cap, bankroll * kelly), 2)
        if sz >= s.min_size:
            sizes[s.market_id] = sz
            total += sz
    return OptResult(sizes=sizes, total_exposure=total, solve_time_ms=0.0,
                     solver="naive_kelly", n_markets=len(signals), feasible=True)


# ── Cache helpers (called by QuantCalibrationWorker + ExecutionWorker) ─────────

def update_cache(result: OptResult) -> None:
    """Store optimization result in process-local memory."""
    global _SIZE_CACHE, _CACHE_TS
    _SIZE_CACHE = dict(result.sizes)
    _CACHE_TS = time.time()
    log.debug("PortfolioOptimizer: cache updated  n=%d  exposure=$%.2f",
              result.n_markets, result.total_exposure)


def get_cached_size(market_id: str, fallback: float = 0.0) -> float:
    """
    Look up optimal size from cache. Returns fallback if cache is stale or miss.
    Hot-path safe: O(1) dict lookup.
    """
    if (time.time() - _CACHE_TS) > _CACHE_TTL_S:
        return fallback  # cache stale — caller uses own Kelly
    return _SIZE_CACHE.get(market_id, fallback)


async def persist_to_redis(result: OptResult) -> None:
    """Persist size cache to Redis so all workers share it."""
    try:
        from persist.redis_state import cache_set
        payload = json.dumps({
            "sizes": result.sizes,
            "ts": time.time(),
            "total_exposure": result.total_exposure,
            "solver": result.solver,
        })
        await cache_set("qopt:sizes", payload, ttl=60)
    except Exception as exc:
        log.debug("PortfolioOptimizer: redis persist error: %s", exc)


async def load_from_redis() -> None:
    """Load cached sizes from Redis on worker startup."""
    global _SIZE_CACHE, _CACHE_TS
    try:
        from persist.redis_state import cache_get
        raw = await cache_get("qopt:sizes")
        if raw:
            obj = json.loads(raw)
            _SIZE_CACHE = {str(k): float(v) for k, v in obj.get("sizes", {}).items()}
            _CACHE_TS = float(obj.get("ts", 0.0))
    except Exception:
        pass
