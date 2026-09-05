"""
Heston Stochastic Volatility Pricer

Implements the four equations from the system design:

  Eq 1 — Heston SDE (stochastic vol process):
      dS_t = μ S_t dt + √(v_t) S_t dW_t^S
      dv_t = κ(θ − v_t) dt + ξ√(v_t) dW_t^v
      ⟨dW^S, dW^v⟩ = ρ dt

  Eq 2 — Heston-Lewis digital fair value:
      P(S_T > K | F_t) = ½ + (1/π) ∫₀^∞ Re[ e^(−iu ln K) · φ(u) / (iu) ] du
      where φ(u) is the Heston characteristic function of ln(S_T).
      Replaces the flat N(d₂) Black-Scholes model we had before.
      Captures fat tails, volatility skew, and leverage effect in crypto markets.

  Eq 3 — Bayesian particle filter on latent variance:
      p(v_t | y_{1:t}) ∝ p(y_t | v_t) ∫ p(v_t | v_{t−1}) p(v_{t−1} | y_{1:t−1}) dv_{t−1}
      Uses SIR (Sequential Importance Resampling) with 150 particles.
      Replaces naive realized-vol calculation.
      Returns posterior mean v̂_t and posterior variance Var(v_t).

  Eq 4 — Robust Kelly under estimation variance:
      f̂ = f* / (1 + λ · Var(f*))
      where f* = (μ − r) / σ² = edge / (1 − p_market)  (binary Kelly)
      and   Var(f*) ≈ Var(p_model) / (1 − p_market)²
      Shrinks position size when signal estimates are uncertain.
      λ = cfg.kelly_lambda (default 1.5).

Usage:
  from signals.heston_pricer import (
      calibrate_heston,
      HestonParams,
      BayesianVolFilter,
      heston_digital_prob,
      robust_kelly,
  )
"""
from __future__ import annotations

import cmath
import logging
import math
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
from scipy.integrate import quad  # numeric integration for Lewis formula

from core.config import cfg

log = logging.getLogger(__name__)

# ── Default Heston parameters for crypto assets ───────────────────────────────
# Estimated from historical BTC implied vol surfaces and academic literature.
# κ (mean reversion): BTC vol reverts with ~4-month half-life → κ ≈ 3
# θ (long-run var):   68% annual → θ ≈ 0.46
# ξ (vol-of-vol):     crypto has high vol-of-vol ≈ 0.50
# ρ (leverage corr):  negative → large drops cause vol spikes ≈ -0.65

_DEFAULT_HESTON = {
    "BTC":   dict(kappa=3.0, theta=0.46, xi=0.50, rho=-0.65),
    "ETH":   dict(kappa=3.5, theta=0.67, xi=0.58, rho=-0.60),
    "SOL":   dict(kappa=4.0, theta=1.21, xi=0.72, rho=-0.55),
    "DOGE":  dict(kappa=4.5, theta=1.44, xi=0.80, rho=-0.50),
    "AVAX":  dict(kappa=3.8, theta=0.90, xi=0.65, rho=-0.58),
    "XRP":   dict(kappa=3.2, theta=0.72, xi=0.60, rho=-0.55),
}

_FALLBACK_HESTON = dict(kappa=3.0, theta=0.68, xi=0.55, rho=-0.60)


# ── Equation 1: Heston SDE parameters ─────────────────────────────────────────

@dataclass
class HestonParams:
    kappa: float   # mean reversion speed
    theta: float   # long-run variance (θ)
    xi: float      # volatility of variance (ξ)
    rho: float     # Brownian correlation (ρ)
    v0: float      # current instantaneous variance (v_t) from Bayesian filter


def calibrate_heston(closes: list[float], asset: str = "BTC") -> HestonParams:
    """
    Calibrate Heston parameters from 5-min close prices.
    Uses heuristic moment-matching since MLE needs longer history.
    The Bayesian filter refines v0 online.
    """
    base = _DEFAULT_HESTON.get(asset.upper(), _FALLBACK_HESTON)

    if len(closes) < 3:
        return HestonParams(v0=base["theta"], **base)

    log_ret = np.diff(np.log(np.array(closes, dtype=float)))
    dt      = 1.0 / 105_120          # one 5-min candle in years

    # θ: long-run variance from observed returns
    theta_obs = float(np.var(log_ret, ddof=1) / dt)
    theta_obs = float(np.clip(theta_obs, 0.01, 16.0))
    # Blend 30% observed, 70% prior (small sample — trust prior more)
    theta = 0.30 * theta_obs + 0.70 * base["theta"]

    # ξ: vol-of-vol from variance of squared returns
    sq_ret      = log_ret ** 2
    xi_sq_proxy = float(np.std(sq_ret, ddof=1) / dt) if len(sq_ret) > 2 else 0.0
    xi_obs      = float(np.sqrt(max(0, xi_sq_proxy) / theta)) if theta > 0 else base["xi"]
    xi          = float(np.clip(0.20 * xi_obs + 0.80 * base["xi"], 0.05, 3.0))

    # ρ: price-vol leverage correlation
    # Proxy: corr(y_t, |y_t| − |y_{t−1}|)
    if len(log_ret) >= 4:
        vol_change = np.abs(log_ret[1:]) - np.abs(log_ret[:-1])
        rho_obs    = float(np.corrcoef(log_ret[1:], vol_change)[0, 1])
        rho_obs    = float(np.clip(rho_obs, -0.99, 0.99))
        rho        = 0.25 * rho_obs + 0.75 * base["rho"]
    else:
        rho = base["rho"]

    # v0: most-recent instantaneous variance (pre-filter estimate)
    # Use last 4 candle returns for a fresh estimate
    recent_var = float(np.var(log_ret[-4:], ddof=1) / dt) if len(log_ret) >= 4 else theta
    v0         = float(np.clip(recent_var, 0.001, 25.0))

    return HestonParams(
        kappa=float(base["kappa"]),
        theta=theta,
        xi=xi,
        rho=rho,
        v0=v0,
    )


# ── Equation 2: Heston-Lewis digital formula ──────────────────────────────────

def _heston_cf(
    u: complex,
    tau: float,
    v0: float,
    kappa: float,
    theta: float,
    xi: float,
    rho: float,
) -> complex:
    """
    Heston characteristic function of log(S_T / F) (centered at forward).
    Uses the Albrecher et al. (2007) "little trap" branch-cut-safe form.
    """
    alpha = -0.5 * (u * u + 1j * u)
    beta  = kappa - rho * xi * 1j * u
    gamma = xi * xi / 2.0

    d = cmath.sqrt(beta * beta - 4.0 * alpha * gamma)

    # Choose branch so that Re(d) >= 0 (stable under long tau)
    if beta.real * d.real + beta.imag * d.imag < 0:
        d = -d

    g = (beta - d) / (beta + d)
    h = 1.0 - g * cmath.exp(-d * tau)

    # Avoid log(0) when |g| ≈ 1 and tau is very large
    if abs(1.0 - g) < 1e-12:
        return complex(0.0, 0.0)

    C = (kappa * theta / (xi * xi)) * (
        (beta - d) * tau - 2.0 * cmath.log(h / (1.0 - g))
    )
    D = ((beta - d) / (xi * xi)) * (1.0 - cmath.exp(-d * tau)) / h

    return cmath.exp(C + D * v0)


def heston_digital_prob(
    S: float,
    K: float,
    params: HestonParams,
    tau_years: float,
    mu: float = 0.0,
) -> tuple[float, float]:
    """
    Equation 2: P(S_T > K | F_t) using the Heston-Lewis formula.

    P = ½ + (1/π) ∫₀^∞ Re[ e^(−iu ln K) · φ(u) / (iu) ] du

    where φ(u) = e^(iu ln F) · φ_X(u)
    and   F = S · e^(mu · tau)  (forward price)
    and   φ_X(u) = Heston char-fn of centered log-price.

    Returns (probability, d2_equivalent) where d2 is the equivalent
    Black-Scholes d₂ for diagnostics.
    """
    if tau_years <= 1e-9 or S <= 0 or K <= 0:
        return float(S > K), 0.0

    F    = S * math.exp(mu * tau_years)
    ln_K = math.log(K)
    ln_F = math.log(F)

    def _integrand(u_real: float) -> float:
        if u_real < 1e-10:
            return 0.0
        u_c   = complex(u_real, 0.0)
        phi_X = _heston_cf(u_c, tau_years, params.v0, params.kappa, params.theta, params.xi, params.rho)
        phi   = cmath.exp(1j * u_c * ln_F) * phi_X
        val   = cmath.exp(-1j * u_c * ln_K) * phi / (1j * u_c)
        return val.real

    try:
        result, _ = quad(
            _integrand,
            1e-7, 200.0,
            limit=128,
            epsabs=1e-6,
            epsrel=1e-5,
        )
        p = 0.5 + result / math.pi
    except Exception as exc:
        log.debug("Heston integral failed, falling back to BS: %s", exc)
        # Black-Scholes fallback
        sigma = math.sqrt(max(params.v0, 0.001))
        d2    = (math.log(S / K) + (mu - 0.5 * params.v0) * tau_years) / (sigma * math.sqrt(tau_years))
        from scipy.stats import norm as _norm
        p = float(_norm.cdf(d2))

    p = float(np.clip(p, 0.01, 0.99))

    # Equivalent d2 for logging / diagnostics
    sigma_eff = math.sqrt(max(params.v0, 0.001))
    d2_diag   = (math.log(S / K) + (mu - 0.5 * sigma_eff ** 2) * tau_years) / (
        sigma_eff * math.sqrt(max(tau_years, 1e-9))
    )

    return p, d2_diag


# ── Equation 3: Bayesian particle filter on latent variance ───────────────────

class BayesianVolFilter:
    """
    SIR (Sequential Importance Resampling) particle filter
    that estimates the latent instantaneous variance v_t.

    Each 5-min log-return is an observation:
        y_t | v_t ~ N(−v_t/2·Δt,  v_t·Δt)

    Transition (Heston CIR):
        v_t | v_{t-1} ~ v_{t-1} + κ(θ − v_{t-1})Δt + ξ√(v_{t-1}) ε √Δt
        (Euler-Maruyama, reflected at 0)
    """

    _DT = 1.0 / 105_120   # one 5-min candle in years

    def __init__(self, params: HestonParams, n_particles: int = 150) -> None:
        self.kappa = params.kappa
        self.theta = params.theta
        self.xi    = params.xi
        self.n     = n_particles

        # Initialize from CIR stationary distribution Gamma(2κθ/ξ², ξ²/(2κ))
        shape = max(0.1, 2.0 * self.kappa * self.theta / (self.xi ** 2))
        scale = (self.xi ** 2) / (2.0 * self.kappa)
        self._particles: np.ndarray = np.random.gamma(shape, scale, self.n)
        self._v_est: float = float(params.v0)
        self._v_var: float = float(self.theta * (self.xi ** 2) / (2.0 * self.kappa))

    # ── public properties ──────────────────────────────────────────────────────

    @property
    def v_est(self) -> float:
        """Posterior mean of instantaneous variance E[v_t | y_{1:t}]."""
        return self._v_est

    @property
    def v_var(self) -> float:
        """Posterior variance Var(v_t | y_{1:t}) — feeds Robust Kelly."""
        return self._v_var

    @property
    def sigma_ann(self) -> float:
        """Posterior annualized volatility √E[v_t]."""
        return math.sqrt(max(self._v_est, 0.001))

    # ── update step ───────────────────────────────────────────────────────────

    def update(self, log_return: float) -> None:
        """
        Equation 3: Bayesian filter update with one new log-return observation.
        p(v_t | y_{1:t}) ∝ p(y_t | v_t) ∫ p(v_t | v_{t-1}) p(v_{t-1} | y_{1:t-1}) dv_{t-1}
        """
        dt = self._DT

        # 1. Propagate particles through CIR (Euler-Maruyama)
        eps     = np.random.randn(self.n)
        v_new   = (self._particles
                   + self.kappa * (self.theta - self._particles) * dt
                   + self.xi * np.sqrt(np.maximum(self._particles, 0.0)) * eps * math.sqrt(dt))
        v_new   = np.maximum(v_new, 1e-8)

        # 2. Likelihood weights: p(y_t | v_t) = N(y_t; −v_t/2·Δt, v_t·Δt)
        mu_ret    = -v_new * 0.5 * dt
        sigma_ret = np.sqrt(v_new * dt)
        log_w     = -0.5 * ((log_return - mu_ret) / sigma_ret) ** 2 - np.log(sigma_ret)
        log_w    -= log_w.max()          # numerical stability
        w         = np.exp(log_w)
        w        /= w.sum()

        # 3. Systematic resampling
        cumsum  = np.cumsum(w)
        u_start = np.random.uniform(0.0, 1.0 / self.n)
        u_arr   = u_start + np.arange(self.n) / self.n
        idxs    = np.searchsorted(cumsum, np.clip(u_arr, 0.0, 1.0 - 1e-12))
        self._particles = v_new[np.clip(idxs, 0, self.n - 1)]

        # 4. Posterior statistics (uniform weights after resampling)
        self._v_est = float(np.mean(self._particles))
        self._v_var = float(np.var(self._particles))

    def bulk_update(self, log_returns: list[float]) -> None:
        """Feed all available log-returns to bring filter up to current time."""
        for r in log_returns:
            self.update(r)


# ── Per-asset filter singletons (persists across forecast() calls) ─────────────
_vol_filters: dict[str, BayesianVolFilter] = {}

def get_vol_filter(asset: str, params: HestonParams) -> BayesianVolFilter:
    """Return (or create) the per-asset Bayesian vol filter."""
    if asset not in _vol_filters:
        _vol_filters[asset] = BayesianVolFilter(params)
    return _vol_filters[asset]


# ── Equation 4: Robust Kelly under estimation variance ────────────────────────

def robust_kelly(
    p_model: float,
    p_market: float,
    bankroll: float,
    var_p_model: float,
    kelly_lambda: Optional[float] = None,
) -> tuple[float, float]:
    """
    Equation 4: f̂ = f* / (1 + λ · Var(f*))
    where f* = (μ − r) / σ²  = edge / (1 − p_market)  for binary bets
    and   Var(f*) ≈ Var(p_model) / (1 − p_market)²

    Parameters
    ----------
    p_model     : our model's probability for the chosen side
    p_market    : devigged Polymarket price for the same side
    bankroll    : current bankroll in USD
    var_p_model : estimated variance of p_model (from signal spread or filter)
    kelly_lambda: risk-aversion (λ); defaults to cfg.kelly_lambda

    Returns
    -------
    (approved_size_usd, kelly_fraction)
    """
    lam = kelly_lambda if kelly_lambda is not None else cfg.kelly_lambda

    if p_market >= 0.98 or p_market <= 0.02:
        return 0.0, 0.0

    edge = p_model - p_market
    if edge <= 0.0:
        return 0.0, 0.0

    # Classical Kelly fraction for binary bets (Eq 4, f*)
    # f* = (p_model * b - (1-p_model)) / b  where b = (1 - p_market) / p_market
    b      = (1.0 - p_market) / p_market
    f_star = max(0.0, (p_model * b - (1.0 - p_model)) / b)

    # Estimation variance: Var(f*) ≈ Var(p_model) / (1 − p_market)²
    var_f_star = max(0.0, var_p_model) / max(1e-6, (1.0 - p_market) ** 2)

    # Robust shrinkage
    f_hat = f_star / (1.0 + lam * var_f_star)
    f_hat = float(np.clip(f_hat, 0.0, cfg.kelly_max))

    size = bankroll * f_hat
    return min(size, cfg.max_bet_usd), f_hat


def estimate_var_p_model(p_estimates: list[float]) -> float:
    """
    Estimate Var(p_model) from the spread across available signal components.
    Uses the sample variance of all available probability estimates.
    Falls back to a conservative prior if fewer than 2 signals available.
    """
    valid = [p for p in p_estimates if 0.0 < p < 1.0]
    if len(valid) >= 2:
        return float(np.var(valid, ddof=1))
    # Prior: typical LLM classification uncertainty ≈ ±10%
    return 0.01   # (0.10)² — conservative default


# ── Merton Jump Diffusion Digital Probability ──────────────────────────────────

def merton_digital_prob(
    S: float,
    K: float,
    tau_years: float,
    sigma: float,
    mu: float = 0.0,
    lam: float = 3.0,
    mu_j: float = -0.05,
    sigma_j: float = 0.07,
    n_terms: int = 20,
) -> float:
    """
    P(S_T > K) under Merton (1976) jump-diffusion.

    dS = (μ - λ·k̄)·S·dt + σ·S·dW + J·S·dN

    where dN ~ Poisson(λ·dt) and log(1+J) ~ N(μ_j, σ_j²).

    P = Σ_{n=0}^N  w_n · N(d2_n)

    where:
      k̄   = exp(μ_j + σ_j²/2) − 1        (mean jump size compensator)
      λ'  = λ · (1 + k̄)                   (risk-neutral intensity)
      w_n = exp(−λ'τ) · (λ'τ)^n / n!     (Poisson weights)
      F_n = S · exp((μ − λk̄ + n·ln(1+k̄̄̄̄̄̄̄)/τ_total)·τ + n·μ_j)   (corrected forward)
      σ_n²= σ²·τ + n·σ_j²                (total variance including n jumps)
      d2_n= (ln(F_n/K) − σ_n²/2) / √σ_n²

    Default BTC parameters from Bakshi-Cao-Chen (1997) adapted for crypto:
      λ = 3.0    (3 jumps/year, calibrated from BTC flash-crash history)
      μ_j= -0.05 (mean log-jump: slightly negative due to flash crashes)
      σ_j= 0.07  (jump size std dev)

    Active only for tau_years ≥ 6/8760 (≥ 6 hours) where jump contribution > 0.1%.
    For shorter horizons, the jump probability is < 0.001 and adds noise.
    """
    from scipy.stats import norm as _norm

    if tau_years < 6.0 / 8760.0 or S <= 0 or K <= 0:
        # Below 6-hour horizon, jump contribution is < 0.001 — negligible
        return -1.0  # signal to caller: use Heston instead

    F = S * math.exp(mu * tau_years)
    k_bar = math.exp(mu_j + 0.5 * sigma_j ** 2) - 1.0  # mean jump = e^(μ_j + σ²/2) - 1
    lam_prime = lam * (1.0 + k_bar)                     # risk-neutral jump intensity

    p_total = 0.0
    exp_lam_tau = math.exp(-lam_prime * tau_years)
    lam_tau = lam_prime * tau_years

    for n in range(n_terms):
        # Poisson weight
        log_w = -lam_tau + n * math.log(max(lam_tau, 1e-300)) - sum(math.log(k) for k in range(1, n + 1))
        w = math.exp(max(-700.0, log_w))  # clip to prevent underflow

        if w < 1e-10:
            break  # remaining terms negligible

        # Forward adjusted for n jumps: each jump shifts log(S) by μ_j
        F_n = F * math.exp(n * mu_j)

        # Total variance for n jumps
        var_n = sigma ** 2 * tau_years + n * sigma_j ** 2
        if var_n <= 0:
            var_n = 1e-9

        sigma_n = math.sqrt(var_n)
        d2_n = (math.log(F_n / max(K, 1e-9)) - 0.5 * var_n) / sigma_n
        p_n = float(_norm.cdf(d2_n))
        p_total += w * p_n

    return float(np.clip(p_total, 0.01, 0.99))
