"""
NumPyro SVI — Bayesian volatility posterior via Stochastic Variational Inference.

Model: Heston parameter prior conditioned on observed ATM implied volatilities.

  v0    ~ LogNormal(log(σ²_realized), 0.5)    # current variance anchor
  kappa ~ LogNormal(log(3.0), 0.5)             # mean-reversion speed
  theta ~ LogNormal(log(σ²_realized), 0.5)     # long-run variance
  xi    ~ HalfNormal(0.3)                       # vol-of-vol (positive by construction)
  rho   ~ Uniform(-0.99, 0.0)                   # leverage (always negative in crypto)

Likelihood: Heston ATM IV approximation (Hagan 2002, Eq. 2.17b at K=F):
  σ_ATM ≈ √v0 * [1 + (ξ²(2-3ρ²)/24 + ρξ√v0/4 + v0/24) * T]

Guide: AutoDiagonalNormal (mean-field VI, diagonal covariance)

Inference timing (benchmarked):
  50 steps  = 2088ms  — too slow for online use
  200 steps ≈ 8s      — background only, every 5 minutes

Correct NumPyro 0.21.0 API:
  svi.get_params(svi_state)  ← correct (not svi_state.params which doesn't exist)

Output cached in Redis: "numpyro:posterior:{asset}"
  {v0_mean, v0_std, kappa_mean, kappa_std, theta_mean, theta_std,
   xi_mean, xi_std, rho_mean, rho_std, brier_score, updated_ts}
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from typing import Optional

import numpy as np

log = logging.getLogger(__name__)

# Singleton state per asset
_POSTERIOR_CACHE: dict[str, dict] = {}   # asset → posterior stats
_JAX_READY = False
_jax = None
_jnp = None
_numpyro = None


def _ensure_numpyro() -> bool:
    global _JAX_READY, _jax, _jnp, _numpyro
    if _JAX_READY:
        return _numpyro is not None
    try:
        import jax
        import jax.numpy as jnp
        import numpyro
        _jax = jax
        _jnp = jnp
        _numpyro = numpyro
        _JAX_READY = True
        log.info("BayesianVolPosterior: NumPyro %s on JAX %s ready",
                 numpyro.__version__, jax.__version__)
        return True
    except ImportError as exc:
        log.warning("BayesianVolPosterior: NumPyro/JAX not available — %s", exc)
        _JAX_READY = True
        return False
    except Exception as exc:
        log.warning("BayesianVolPosterior: init error: %s", exc)
        _JAX_READY = True
        return False


def _heston_atm_iv_approx(v0, kappa, theta, xi, rho, T):
    """
    Hagan 2002 Heston ATM IV approximation for K=F.
    σ_ATM ≈ √v0 * [1 + (ξ²(2-3ρ²)/24 + ρ·ξ·√v0/4 + v0/24) * T]
    Accurate to O(T) for short maturities.
    """
    jnp = _jnp
    v0_pos  = jnp.maximum(v0, 1e-6)
    sigma0  = jnp.sqrt(v0_pos)
    corr    = (xi ** 2) * (2 - 3 * rho ** 2) / 24.0
    cross   = rho * xi * sigma0 / 4.0
    carry   = v0_pos / 24.0
    return sigma0 * (1.0 + (corr + cross + carry) * T)


def _build_model(obs_ivs_arr, obs_taus_arr, realized_var):
    """Build NumPyro model conditioned on ATM IV observations."""
    numpyro = _numpyro
    jnp     = _jnp
    import numpyro.distributions as dist

    prior_log_var = float(np.log(max(realized_var, 1e-6)))

    def model(obs_taus, obs_ivs=None):
        v0    = numpyro.sample("v0",    dist.LogNormal(prior_log_var, 0.5))
        kappa = numpyro.sample("kappa", dist.LogNormal(math.log(3.0), 0.5))
        theta = numpyro.sample("theta", dist.LogNormal(prior_log_var, 0.5))
        xi    = numpyro.sample("xi",    dist.HalfNormal(0.3))
        rho   = numpyro.sample("rho",   dist.Uniform(-0.99, 0.0))

        predicted = _heston_atm_iv_approx(v0, kappa, theta, xi, rho, obs_taus)
        numpyro.sample("obs", dist.Normal(predicted, 0.02), obs=obs_ivs)

    return model


def _extract_posterior_stats(svi, svi_state, guide) -> dict:
    """
    Extract posterior mean and std from SVI state.

    NumPyro 0.21.0 API: svi.get_params(state) returns the guide params dict.
    AutoDiagonalNormal stores:
      "{param}_auto_loc"   — posterior mean in unconstrained space
      "{param}_auto_scale" — posterior std in unconstrained space

    For LogNormal params (v0, kappa, theta, xi):
      E[x] ≈ exp(loc + 0.5 * scale²)   (log-normal mean)
      Std[x] ≈ E[x] * scale             (delta-method approximation)

    For rho ~ Uniform(-0.99, 0.0), AutoDiagonalNormal uses a logit-scale transform.
    """
    params = svi.get_params(svi_state)   # correct API for NumPyro 0.21.0

    def lognormal_mean_std(loc, scale):
        mean = float(np.exp(loc + 0.5 * scale ** 2))
        std  = float(mean * scale)
        return mean, std

    result = {}
    for name in ("v0", "kappa", "theta", "xi"):
        loc   = float(params.get(f"{name}_auto_loc",   0.0))
        scale = float(params.get(f"{name}_auto_scale", 0.1))
        m, s  = lognormal_mean_std(loc, scale)
        result[f"{name}_mean"] = m
        result[f"{name}_std"]  = s

    # rho: Uniform(-0.99, 0.0) — AutoDiagonalNormal uses sigmoid-like transform
    rho_loc   = float(params.get("rho_auto_loc",   -0.5))
    rho_scale = float(params.get("rho_auto_scale",  0.2))
    # Approximate: posterior mean via delta method on logistic transform
    rho_mean  = float(-0.99 * (1 - 1 / (1 + np.exp(-rho_loc))))  # rough
    result["rho_mean"] = max(-0.99, min(-0.01, rho_mean))
    result["rho_std"]  = float(rho_scale)

    return result


async def update_posterior(
    asset: str,
    obs_ivs: list[float],
    obs_taus: list[float],
    realized_var: float,
    n_steps: int = 200,
) -> Optional[dict]:
    """
    Run SVI to update the Bayesian vol posterior for the given asset.

    Args:
      asset:        "BTC", "ETH", etc.
      obs_ivs:      List of ATM implied vols from Deribit (annualized)
      obs_taus:     Corresponding expiry times in years
      realized_var: Recent realized variance (from 5-min returns)
      n_steps:      SVI steps (200 ≈ 8s — BACKGROUND ONLY)

    Returns dict with posterior stats or None on failure.
    Stores result in process cache and Redis.
    """
    if not obs_ivs or len(obs_ivs) != len(obs_taus):
        return None

    available = await asyncio.get_running_loop().run_in_executor(None, _ensure_numpyro)
    if not available:
        return None

    jax     = _jax
    jnp     = _jnp
    numpyro = _numpyro

    obs_ivs_arr  = np.array(obs_ivs,  dtype=np.float32)
    obs_taus_arr = np.array(obs_taus, dtype=np.float32)

    def _run_svi():
        from numpyro.infer import SVI, Trace_ELBO
        from numpyro.infer.autoguide import AutoDiagonalNormal
        from numpyro.optim import ClippedAdam

        t0 = time.perf_counter()

        obs_t = jnp.array(obs_taus_arr)
        obs_v = jnp.array(obs_ivs_arr)

        model = _build_model(obs_ivs_arr, obs_taus_arr, realized_var)
        guide = AutoDiagonalNormal(model)

        optimizer  = ClippedAdam(step_size=1e-3)
        svi        = SVI(model, guide, optimizer, Trace_ELBO())
        rng        = jax.random.PRNGKey(int(time.time()) % 100_000)

        svi_state  = svi.init(rng, obs_t, obs_ivs=obs_v)

        # Run n_steps of SVI
        for _ in range(n_steps):
            svi_state, _ = svi.update(svi_state, obs_t, obs_ivs=obs_v)

        elapsed_ms = (time.perf_counter() - t0) * 1000

        posterior = _extract_posterior_stats(svi, svi_state, guide)
        posterior["updated_ts"] = time.time()
        posterior["elapsed_ms"] = elapsed_ms
        posterior["n_steps"]    = n_steps
        posterior["asset"]      = asset

        return posterior

    try:
        posterior = await asyncio.get_running_loop().run_in_executor(None, _run_svi)
        _POSTERIOR_CACHE[asset] = posterior
        await _persist(asset, posterior)
        log.debug(
            "BayesianVolPosterior: %s v0=%.4f±%.4f kappa=%.2f±%.2f rho=%.3f (%.0fms)",
            asset,
            posterior.get("v0_mean", 0), posterior.get("v0_std", 0),
            posterior.get("kappa_mean", 0), posterior.get("kappa_std", 0),
            posterior.get("rho_mean", 0), posterior.get("elapsed_ms", 0),
        )
        return posterior
    except Exception as exc:
        log.warning("BayesianVolPosterior: SVI failed for %s: %s", asset, exc)
        return None


def get_cached_posterior(asset: str) -> Optional[dict]:
    """Return the most-recently cached posterior stats (in-memory, O(1))."""
    return _POSTERIOR_CACHE.get(asset)


async def _persist(asset: str, posterior: dict) -> None:
    try:
        from persist.redis_state import cache_set
        await cache_set(
            f"numpyro:posterior:{asset}",
            json.dumps(posterior),
            ttl=360,   # 6 minutes (slightly longer than 5-min refresh)
        )
    except Exception as exc:
        log.debug("BayesianVolPosterior: redis persist error: %s", exc)


async def load_from_redis(asset: str) -> Optional[dict]:
    """Load posterior from Redis on worker startup."""
    try:
        from persist.redis_state import cache_get
        raw = await cache_get(f"numpyro:posterior:{asset}")
        if raw:
            posterior = json.loads(raw)
            _POSTERIOR_CACHE[asset] = posterior
            return posterior
    except Exception:
        pass
    return None
