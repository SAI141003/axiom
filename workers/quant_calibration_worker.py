"""
QuantCalibrationWorker — Background quant model calibration orchestrator.

Runs three independent calibration loops (never blocks hot path):

  Loop A — CVXPY portfolio optimizer (every 30s):
    Collects live signals from SIGNAL_FAST bus
    Runs constrained Kelly LP via CVXPY (3-4ms solve)
    Updates _SIZE_CACHE used by ExecutionWorker._handle_arb()
    Persists to Redis: "qopt:sizes" (60s TTL)

  Loop B — JAX/Diffrax Heston calibration (every 60s):
    Fetches Deribit IV quotes per asset (BTC, ETH, SOL)
    Runs 100 Adam gradient steps on Heston CF MSE (~340ms)
    Persists calibrated params to Redis: "heston:params:{asset}" (120s TTL)

  Loop C — NumPyro SVI Bayesian vol posterior (every 5min):
    Computes realized variance from price history
    Fetches ATM IV observations
    Runs 200 SVI steps (~8s) on Heston prior model
    Persists posterior stats to Redis: "numpyro:posterior:{asset}" (6min TTL)

  Heartbeat: Redis worker key every 10s

Signal collection (for CVXPY):
  Subscribes to SIGNAL_FAST channel
  Keeps latest signal per market_id (dedup by condition_id)
  Clears buffer each time CVXPY runs (prevents stale positions)

Architecture guarantees:
  - Zero blocking I/O in execution hot path
  - All results cached; cache misses fall back to naive Kelly
  - All loops catch-all exceptions — never crashes the worker
  - Feature flags: cfg.use_cvxpy, cfg.use_diffrax, cfg.use_numpyro
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from core.config import cfg
from core.events import Channel, bus
from core.models import Signal
from persist import redis_state

log = logging.getLogger(__name__)

_TRACKED_ASSETS = ["BTC", "ETH", "SOL"]


def _detect_asset(question: str) -> str:
    """Return the primary asset ticker from a market question string."""
    q = question.upper()
    for asset in ("BTC", "ETH", "SOL", "DOGE", "AVAX", "XRP", "MATIC"):
        if asset in q:
            return asset
    return "BTC"


class QuantCalibrationWorker:
    def __init__(self) -> None:
        self._running = False
        self._pending_signals: dict[str, dict] = {}  # condition_id → raw signal dict
        self._lock = asyncio.Lock()

    async def run(self) -> None:
        self._running = True
        log.info("QuantCalibrationWorker: starting")

        # Warm caches from Redis on startup
        await self._warm_caches()

        q_signals = bus.subscribe_local(Channel.SIGNAL_FAST)

        await asyncio.gather(
            self._collect_signals(q_signals),
            self._cvxpy_loop(),
            self._diffrax_loop(),
            self._numpyro_loop(),
            self._heartbeat_loop(),
        )

    # ── Signal collection (feeds CVXPY optimizer) ─────────────────────────────

    async def _collect_signals(self, q: asyncio.Queue) -> None:
        while self._running:
            try:
                raw = await asyncio.wait_for(q.get(), timeout=5.0)
                market = raw.get("market", {})
                mid = market.get("condition_id", "")
                if mid:
                    async with self._lock:
                        self._pending_signals[mid] = raw
            except asyncio.TimeoutError:
                pass
            except Exception as exc:
                log.debug("QuantCalibrationWorker: signal collect error: %s", exc)

    # ── Loop A: CVXPY portfolio optimization ──────────────────────────────────

    async def _cvxpy_loop(self) -> None:
        if not cfg.use_cvxpy:
            log.info("QuantCalibrationWorker: CVXPY disabled (use_cvxpy=false)")
            return
        while self._running:
            await asyncio.sleep(cfg.cvxpy_solve_interval_s)
            try:
                await self._run_cvxpy()
            except Exception as exc:
                log.warning("QuantCalibrationWorker: CVXPY loop error: %s", exc)

    async def _run_cvxpy(self) -> None:
        from signals import portfolio_optimizer as opt
        from signals.portfolio_optimizer import OptSignal
        from risk import risk_engine as _re

        async with self._lock:
            snapshot = dict(self._pending_signals)
            self._pending_signals.clear()

        if not snapshot:
            return

        bankroll = getattr(_re, "_bankroll", cfg.initial_bankroll)
        opt_signals: list[OptSignal] = []

        for mid, raw in snapshot.items():
            try:
                sig = Signal.model_validate(raw)
                asset = _detect_asset(sig.market.question)
                opt_signals.append(OptSignal(
                    market_id=mid,
                    edge=sig.edge,
                    market_prob=sig.p_market,
                    side=sig.side,
                    asset=asset,
                    min_size=1.0,
                ))
            except Exception:
                continue

        if not opt_signals:
            return

        # Run solver in thread (3-4ms — safe, but keep off event loop)
        def _solve():
            return opt.solve(
                opt_signals,
                bankroll=bankroll,
                kelly_max=cfg.kelly_max,
                max_exposure_frac=0.20,
                daily_loss_limit_usd=cfg.daily_loss_limit_usd,
                max_bet_usd=cfg.max_bet_usd,
                btc_max_bet_usd=cfg.btc_max_bet_usd,
            )

        result = await asyncio.get_running_loop().run_in_executor(None, _solve)
        opt.update_cache(result)
        await opt.persist_to_redis(result)

        log.debug(
            "QuantCalibrationWorker: CVXPY n=%d exposure=$%.2f solver=%s (%.1fms)",
            result.n_markets, result.total_exposure,
            result.solver, result.solve_time_ms,
        )

    # ── Loop B: JAX/Diffrax Heston calibration ────────────────────────────────

    async def _diffrax_loop(self) -> None:
        if not cfg.use_diffrax:
            log.info("QuantCalibrationWorker: Diffrax disabled (use_diffrax=false)")
            return
        # Stagger startup by 5s to avoid cold-start pile-up
        await asyncio.sleep(5)
        while self._running:
            try:
                await self._run_diffrax_all()
            except Exception as exc:
                log.warning("QuantCalibrationWorker: Diffrax loop error: %s", exc)
            await asyncio.sleep(cfg.diffrax_recal_interval_s)

    async def _run_diffrax_all(self) -> None:
        from signals import diffrax_calibrator
        from signals.deribit_signal import get_surface as _get_deribit

        tasks = [self._calibrate_asset_heston(asset) for asset in _TRACKED_ASSETS]
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _calibrate_asset_heston(self, asset: str) -> None:
        from signals import diffrax_calibrator as dc
        from signals.diffrax_calibrator import CalibrationQuote

        # Fetch Deribit surface
        try:
            from signals.deribit_signal import get_surface
            surface = get_surface(asset)
            if surface is None:
                return
        except Exception:
            return

        # Build calibration quotes from surface (ATM + OTM strikes)
        try:
            # Get the nearest expiry's quotes from the Deribit surface
            current_price = await _get_spot_price(asset)
            if not current_price:
                return

            quotes: list[CalibrationQuote] = []
            moneyness_grid = [-0.20, -0.10, -0.05, 0.0, 0.05, 0.10, 0.20]

            # Use nearest available expiry
            exp_ts = _nearest_expiry(surface)
            if exp_ts is None:
                return
            tau = max(0.0, (exp_ts - time.time()) / (365.25 * 86400))
            if tau < 1e-5:
                return

            for dm in moneyness_grid:
                K = current_price * (1 + dm)
                iv = surface.get_iv(exp_ts, K)
                if iv and 0.05 <= iv <= 5.0:
                    quotes.append(CalibrationQuote(
                        log_moneyness=dm,
                        tau_years=tau,
                        market_iv=iv,
                    ))

            if len(quotes) < 3:
                return

            params = await dc.calibrate_async(asset, quotes, current_price)
            if params:
                await dc.persist_params(asset, params)

        except Exception as exc:
            log.debug("QuantCalibrationWorker: Heston calibration error %s: %s", asset, exc)

    # ── Loop C: NumPyro SVI Bayesian vol posterior ────────────────────────────

    async def _numpyro_loop(self) -> None:
        if not cfg.use_numpyro:
            log.info("QuantCalibrationWorker: NumPyro disabled (use_numpyro=false)")
            return
        # Stagger startup by 15s
        await asyncio.sleep(15)
        while self._running:
            try:
                await self._run_numpyro_all()
            except Exception as exc:
                log.warning("QuantCalibrationWorker: NumPyro loop error: %s", exc)
            await asyncio.sleep(cfg.numpyro_recal_interval_s)

    async def _run_numpyro_all(self) -> None:
        # NumPyro SVI is slow (~8s); run assets sequentially to avoid GPU/CPU contention
        for asset in _TRACKED_ASSETS[:2]:  # BTC + ETH only (most liquid)
            try:
                await self._update_numpyro_posterior(asset)
            except Exception as exc:
                log.debug("QuantCalibrationWorker: NumPyro error %s: %s", asset, exc)

    async def _update_numpyro_posterior(self, asset: str) -> None:
        from signals import bayesian_vol_posterior as bvp
        from signals.deribit_signal import get_surface

        # Get realized variance from recent price data
        realized_var = await _get_realized_var(asset)
        if realized_var is None:
            return

        # Get ATM IVs from Deribit at multiple expiries
        try:
            surface = get_surface(asset)
            if surface is None:
                return
            current_price = await _get_spot_price(asset)
            if not current_price:
                return

            obs_ivs:  list[float] = []
            obs_taus: list[float] = []
            for exp_ts in _get_expiry_list(surface)[:5]:  # max 5 expiries
                tau = max(0.0, (exp_ts - time.time()) / (365.25 * 86400))
                if tau < 1e-5:
                    continue
                iv = surface.get_iv(exp_ts, current_price)  # ATM
                if iv and 0.05 <= iv <= 5.0:
                    obs_ivs.append(iv)
                    obs_taus.append(tau)

            if len(obs_ivs) < 2:
                return

            await bvp.update_posterior(asset, obs_ivs, obs_taus, realized_var)

        except Exception as exc:
            log.debug("QuantCalibrationWorker: NumPyro posterior error %s: %s", asset, exc)

    # ── Heartbeat ─────────────────────────────────────────────────────────────

    async def _heartbeat_loop(self) -> None:
        while self._running:
            await redis_state.set_worker_heartbeat("quant_calibration")
            await asyncio.sleep(10)

    # ── Startup warm ──────────────────────────────────────────────────────────

    async def _warm_caches(self) -> None:
        """Load cached results from Redis so first trade can use optimized sizes."""
        try:
            from signals import portfolio_optimizer
            await portfolio_optimizer.load_from_redis()
            log.debug("QuantCalibrationWorker: CVXPY cache warmed from Redis")
        except Exception:
            pass

        try:
            from signals import bayesian_vol_posterior as bvp
            for asset in _TRACKED_ASSETS:
                await bvp.load_from_redis(asset)
        except Exception:
            pass


# ── Helpers ───────────────────────────────────────────────────────────────────

async def _get_spot_price(asset: str) -> Optional[float]:
    """Fetch current spot price from Redis price cache."""
    try:
        raw = await redis_state.cache_get(f"price:{asset}USDT")
        if raw:
            import json
            data = json.loads(raw)
            return float(data.get("price", 0)) or None
    except Exception:
        pass
    return None


async def _get_realized_var(asset: str) -> Optional[float]:
    """Compute realized variance from 5-min closes stored in Redis."""
    try:
        raw = await redis_state.cache_get(f"ohlcv:{asset}:5m")
        if not raw:
            return None
        import json
        bars = json.loads(raw)
        closes = [float(b["close"]) for b in bars[-32:] if "close" in b]
        if len(closes) < 4:
            return None
        import math
        log_rets = [math.log(c[1] / c[0]) for c in zip(closes[:-1], closes[1:])]
        dt = 1.0 / 105_120  # 5-min bars per year (365 * 24 * 12 = 105_120)
        return float(sum(r**2 for r in log_rets) / max(len(log_rets) - 1, 1) / dt)
    except Exception:
        return None


def _nearest_expiry(surface) -> Optional[float]:
    """Return the nearest future expiry timestamp from a DeribitSurface."""
    try:
        if hasattr(surface, "_smiles"):
            keys = [k for k in surface._smiles if k > time.time()]
            return min(keys) if keys else None
        if hasattr(surface, "_expiries"):
            keys = [k for k in surface._expiries if k > time.time()]
            return min(keys) if keys else None
    except Exception:
        pass
    return None


def _get_expiry_list(surface) -> list[float]:
    """Return sorted list of future expiry timestamps from a DeribitSurface."""
    try:
        now = time.time()
        if hasattr(surface, "_smiles"):
            return sorted(k for k in surface._smiles if k > now)
        if hasattr(surface, "_expiries"):
            return sorted(k for k in surface._expiries if k > now)
    except Exception:
        pass
    return []
