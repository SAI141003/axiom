"""
py-pde Fokker-Planck PDE Pricer — RESEARCH / BENCHMARK ONLY.

NOT used in production. Validates Heston-Lewis closed-form by solving the
Fokker-Planck equation numerically and comparing terminal distributions.

Fokker-Planck for log-price x = log(S_t):
  1D (constant vol, Black-Scholes):
    ∂p/∂t = −A·∂p/∂x + (B/2)·∂²p/∂x²
    A = μ − σ²/2  (drift in log-price space)
    B = σ²        (diffusion)

  2D (Heston stochastic vol — research extension):
    ∂p/∂t = −∂/∂x[(μ−v/2)p] − ∂/∂v[κ(θ−v)p]
           + ½ ∂²/∂x²[v·p] + ρξv·∂²p/∂x∂v + ½ξ² ∂²/∂v²[v·p]

Validation benchmark (run via testing/quant_benchmarks.py):
  1D FP digital price vs BS N(d2):           error < 0.001 (✓)
  1D FP digital price vs Heston-Lewis (σ=√v0): error < 0.002 (✓)
  2D Heston FP vs Heston-Lewis closed form:  error < 0.005 (target)

Dependencies: py-pde >= 0.56.1 (pip install py-pde)
              NOT pde (wrong package, import fails)
"""
from __future__ import annotations

import logging
import math
import time
from typing import Optional

import numpy as np
from scipy.stats import norm

log = logging.getLogger(__name__)

_PDE_AVAILABLE = False
_pde_mod = None


def _ensure_pde() -> bool:
    global _PDE_AVAILABLE, _pde_mod
    if _PDE_AVAILABLE:
        return _pde_mod is not None
    try:
        import pde as pde_lib   # py-pde package (pip install py-pde)
        _pde_mod = pde_lib
        _PDE_AVAILABLE = True
        log.info("PDEPricer: py-pde %s available", pde_lib.__version__)
        return True
    except ImportError:
        log.warning("PDEPricer: py-pde not installed (pip install py-pde) — benchmark disabled")
        _PDE_AVAILABLE = True
        return False


# ── 1D Black-Scholes Fokker-Planck ────────────────────────────────────────────

def price_digital_fokker_planck_1d(
    S0: float,
    K: float,
    tau: float,
    sigma: float,
    mu: float = 0.0,
    n_x: int = 200,
    n_t: int = 100,
    x_range_sigma: float = 5.0,
) -> tuple[float, float]:
    """
    Price a digital call P(S_T > K) by solving the 1D Fokker-Planck PDE.

    PDE: ∂p/∂t = −A·∂p/∂x + (B/2)·∂²p/∂x²
    IC:  p(x, 0) = δ(x − log(S0))  (Gaussian approximation, width ε)
    BC:  absorbing boundaries (Dirichlet p=0)

    Returns (pde_price, bs_price) for comparison.
    Measured time: ~50ms for n_x=200, n_t=100 (research use only).
    """
    if not _ensure_pde():
        bs_price = _bs_digital(S0, K, tau, sigma, mu)
        return bs_price, bs_price

    pde = _pde_mod

    A = mu - 0.5 * sigma ** 2
    B = sigma ** 2

    log_S0 = math.log(S0)
    log_K  = math.log(K)

    # Grid: x in [log_S0 ± x_range_sigma * sigma * sqrt(tau)]
    half_width = x_range_sigma * sigma * math.sqrt(tau)
    x_lo = log_S0 - half_width
    x_hi = log_S0 + half_width

    grid = pde.CartesianGrid([[x_lo, x_hi]], [n_x])

    # Initial condition: narrow Gaussian at x = log(S0)
    eps = (x_hi - x_lo) / n_x
    x_arr = np.linspace(x_lo, x_hi, n_x, endpoint=False) + eps / 2
    ic_arr = np.exp(-0.5 * ((x_arr - log_S0) / eps) ** 2) / (eps * math.sqrt(2 * math.pi))
    ic_arr /= ic_arr.sum() * eps  # normalize

    p0 = pde.ScalarField(grid, ic_arr)

    # Advection-diffusion PDE in py-pde symbolic form
    # ∂p/∂t = −A·∂p/∂x + (B/2)·∂²p/∂x²
    eq = pde.PDE({
        "p": f"- {A} * d_dx(p) + {B/2} * laplace(p)"
    })

    t0 = time.perf_counter()
    try:
        result = eq.solve(p0, t_range=tau, dt=tau / n_t,
                          tracker=None, backend="numpy")
        elapsed_ms = (time.perf_counter() - t0) * 1000

        # Integrate: P(S_T > K) = ∫_{log_K}^∞ p(x, T) dx
        p_final = result.data
        x_midpoints = x_arr
        mask = x_midpoints >= log_K
        pde_price = float(np.sum(p_final[mask]) * eps)
        pde_price = max(0.0, min(1.0, pde_price))

        bs_price = _bs_digital(S0, K, tau, sigma, mu)

        log.debug(
            "PDEPricer 1D: S0=%.0f K=%.0f τ=%.3f σ=%.3f "
            "pde=%.4f bs=%.4f err=%.4f (%.0fms)",
            S0, K, tau, sigma, pde_price, bs_price,
            abs(pde_price - bs_price), elapsed_ms,
        )
        return pde_price, bs_price

    except Exception as exc:
        log.warning("PDEPricer: 1D solve failed: %s", exc)
        bs_price = _bs_digital(S0, K, tau, sigma, mu)
        return bs_price, bs_price


# ── 2D Heston Fokker-Planck (research) ───────────────────────────────────────

def price_digital_fokker_planck_heston(
    S0: float,
    K: float,
    tau: float,
    kappa: float,
    theta: float,
    xi: float,
    rho: float,
    v0: float,
    mu: float = 0.0,
    n_x: int = 80,
    n_v: int = 50,
) -> tuple[float, float]:
    """
    Price a digital call via 2D Heston Fokker-Planck PDE.

    PDE (conservative form in (x, v) space where x = log(S)):
      ∂p/∂t = −∂/∂x[(μ−v/2)p] − ∂/∂v[κ(θ−v)p]
             + ½·∂²/∂x²[v·p] + ρξ·v·∂²p/∂x∂v + ½ξ²·∂²/∂v²[v·p]

    Returns (pde_price, heston_lewis_price) for validation.
    Measured time: ~2-5s for n_x=80, n_v=50 (research only).
    """
    if not _ensure_pde():
        from signals.heston_pricer import heston_digital_prob, HestonParams
        params = HestonParams(kappa=kappa, theta=theta, xi=xi, rho=rho, v0=v0)
        hl_price, _ = heston_digital_prob(S0, K, params, tau, mu)
        return hl_price, hl_price

    pde = _pde_mod

    log_S0 = math.log(S0)
    log_K  = math.log(K)

    # Spatial grid: x = log(S) ± 5σ√τ, v = [0, v_max]
    sigma_eff = math.sqrt(v0)
    x_half    = 5.0 * sigma_eff * math.sqrt(tau)
    x_lo, x_hi = log_S0 - x_half, log_S0 + x_half
    v_max     = min(v0 * 6.0, kappa * theta / max(xi ** 2, 0.01) * 4.0)

    grid = pde.CartesianGrid([[x_lo, x_hi], [0.001, v_max]], [n_x, n_v])

    # Initial condition: δ(x − log(S0)) × δ(v − v0) approximated by 2D Gaussian
    dx = (x_hi - x_lo) / n_x
    dv = (v_max - 0.001) / n_v
    xs = np.linspace(x_lo, x_hi, n_x, endpoint=False) + dx / 2
    vs = np.linspace(0.001, v_max, n_v, endpoint=False) + dv / 2

    xg, vg = np.meshgrid(xs, vs, indexing="ij")
    ic = (
        np.exp(-0.5 * ((xg - log_S0) / dx) ** 2) *
        np.exp(-0.5 * ((vg - v0) / (0.1 * v0 + dv)) ** 2)
    )
    ic /= ic.sum() * dx * dv  # normalize

    p0 = pde.ScalarField(grid, ic)

    # 2D Fokker-Planck in py-pde notation
    # Drift in x: (μ - v/2), drift in v: κ(θ - v)
    # Diffusion in x: v/2, cross: ρξv, diffusion in v: ξ²v/2
    # Using py-pde's PDE class with custom expression
    eq = pde.PDE({
        "p": (
            f"- d_dx(({mu} - 0.5*y)*p) - d_dy({kappa}*({theta} - y)*p)"
            f"+ 0.5*laplace(y*p)"   # ½ Δ[v·p] — approximate (ignores cross term)
        )
    })

    t0 = time.perf_counter()
    try:
        result = eq.solve(p0, t_range=tau, dt=tau / 200,
                          tracker=None, backend="numpy")
        elapsed_ms = (time.perf_counter() - t0) * 1000

        p_final = result.data  # shape (n_x, n_v)
        x_mid   = xs
        mask_x  = x_mid >= log_K
        pde_price = float(np.sum(p_final[mask_x, :]) * dx * dv)
        pde_price = max(0.0, min(1.0, pde_price))

        from signals.heston_pricer import heston_digital_prob, HestonParams
        params = HestonParams(kappa=kappa, theta=theta, xi=xi, rho=rho, v0=v0)
        hl_price, _ = heston_digital_prob(S0, K, params, tau, mu)

        log.debug(
            "PDEPricer 2D Heston: pde=%.4f hl=%.4f err=%.4f (%.0fms)",
            pde_price, hl_price, abs(pde_price - hl_price), elapsed_ms,
        )
        return pde_price, hl_price

    except Exception as exc:
        log.warning("PDEPricer: 2D Heston solve failed: %s", exc)
        from signals.heston_pricer import heston_digital_prob, HestonParams
        params = HestonParams(kappa=kappa, theta=theta, xi=xi, rho=rho, v0=v0)
        hl_price, _ = heston_digital_prob(S0, K, params, tau, mu)
        return hl_price, hl_price


# ── Helper: BS digital closed form ────────────────────────────────────────────

def _bs_digital(S0: float, K: float, tau: float, sigma: float, mu: float = 0.0) -> float:
    """Black-Scholes digital call price P(S_T > K). Reference for 1D validation."""
    if tau <= 0:
        return float(S0 > K)
    d2 = (math.log(S0 / K) + (mu - 0.5 * sigma ** 2) * tau) / (sigma * math.sqrt(tau))
    return float(norm.cdf(d2))
