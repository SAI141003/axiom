"""
VOLATILITY-MODEL BENCHMARK — our realized-vol Monte Carlo vs the real vol models.

The scenario engine sizes its 20k price paths from TRAILING REALIZED volatility.
Quant desks forecast vol with GARCH and EWMA. This asks, out-of-sample: whose
volatility forecast is actually closest to what the market delivered next month?

Competitors (all real, all cited):
  • Realized-vol (OURS)   trailing 63-day return std — what the scenario MC uses.
  • GARCH(1,1)            σ²ₜ = ω + α·r²ₜ₋₁ + β·σ²ₜ₋₁, fit by MLE each step.
                          — Bollerslev (1986); the academic standard.
  • EWMA / RiskMetrics    σ²ₜ = λσ²ₜ₋₁ + (1−λ)r²ₜ₋₁, λ=0.94.
                          — J.P. Morgan RiskMetrics (1996); the industry standard.
  • Naive (RW-in-vol)     last month's realized vol carried forward.

Scored by QLIKE (Patton 2011) — the loss robust to the noisy realized-variance
proxy: L = rv/fc − log(rv/fc) − 1. Lower = better. Expanding-window, no lookahead.

Writes .data/vol_model_benchmark.json
"""
from __future__ import annotations

import json
import math
import sys
import time
from pathlib import Path

import numpy as np
from scipy.optimize import minimize

sys.path.insert(0, str(Path(__file__).resolve().parent))
from earnings_engine import _get

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "vol_model_benchmark.json"

UNIVERSE = ["NVDA", "AAPL", "MSFT", "AMD", "GOOGL", "META", "TSLA", "AMZN",
            "JPM", "NFLX", "AVGO", "COST", "INTC", "QCOM", "ORCL", "DIS",
            "F", "BA", "NKE", "UBER"]
H = 21          # forecast horizon (one trading month)


def daily_returns(sym: str) -> np.ndarray:
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=3y&interval=1d")
        c = [x for x in j["chart"]["result"][0]["indicators"]["quote"][0]["close"] if x is not None]
    except Exception:
        return np.array([])
    c = np.array(c)
    return np.diff(np.log(c)) * 100.0        # % log returns (scaled for MLE stability)


def garch11_fit(r: np.ndarray):
    """MLE fit of GARCH(1,1). Returns (omega, alpha, beta). Robust defaults on fail."""
    v0 = np.var(r)
    def nll(params):
        w, a, b = params
        if w <= 0 or a < 0 or b < 0 or a + b >= 0.999:
            return 1e10
        s2 = np.empty(len(r)); s2[0] = v0
        for t in range(1, len(r)):
            s2[t] = w + a * r[t - 1] ** 2 + b * s2[t - 1]
        return 0.5 * np.sum(np.log(s2) + r ** 2 / s2)
    try:
        res = minimize(nll, [v0 * 0.05, 0.08, 0.90], method="Nelder-Mead",
                       options={"maxiter": 400, "xatol": 1e-4, "fatol": 1e-4})
        w, a, b = res.x
        if w > 0 and a >= 0 and b >= 0 and a + b < 0.999:
            return w, a, b
    except Exception:
        pass
    return v0 * 0.05, 0.08, 0.90


def garch_forecast_var(r: np.ndarray, w, a, b, h) -> float:
    """h-day cumulative variance forecast from the fitted recursion."""
    v0 = np.var(r)
    s2 = v0
    for t in range(1, len(r)):
        s2 = w + a * r[t - 1] ** 2 + b * s2
    uncond = w / max(1e-9, 1 - a - b)
    tot = 0.0
    f = w + a * r[-1] ** 2 + b * s2                 # 1-step
    for _ in range(h):
        tot += f
        f = uncond + (a + b) * (f - uncond)         # mean-revert toward uncond
    return tot


def ewma_forecast_var(r: np.ndarray, h, lam=0.94) -> float:
    s2 = np.var(r[:20])
    for x in r:
        s2 = lam * s2 + (1 - lam) * x ** 2
    return s2 * h                                    # flat-carry EWMA one-step × h


def qlike(rv: float, fc: float) -> float:
    rv, fc = max(rv, 1e-6), max(fc, 1e-6)
    return rv / fc - math.log(rv / fc) - 1.0


def main() -> None:
    models = ["realized_ours", "garch11", "ewma_riskmetrics", "naive"]
    loss = {m: 0.0 for m in models}
    n = 0
    for sym in UNIVERSE:
        r = daily_returns(sym)
        if len(r) < 300:
            continue
        # walk forward monthly; need >=250d history, refit GARCH every step (cheap)
        for end in range(252, len(r) - H, H):
            hist = r[:end]
            realized_var = float(np.sum(r[end:end + H] ** 2))      # realized variance next month
            f_ours = float(np.var(hist[-63:]) * H)
            w, a, b = garch11_fit(hist[-500:])
            f_garch = garch_forecast_var(hist[-500:], w, a, b, H)
            f_ewma = ewma_forecast_var(hist, H)
            f_naive = float(np.sum(hist[-H:] ** 2))
            for m, f in [("realized_ours", f_ours), ("garch11", f_garch),
                         ("ewma_riskmetrics", f_ewma), ("naive", f_naive)]:
                loss[m] += qlike(realized_var, f)
            n += 1
        time.sleep(0.15)

    if not n:
        print("no data"); return
    rows = sorted(({"model": m, "qlike": round(loss[m] / n, 4)} for m in models),
                  key=lambda x: x["qlike"])
    our_rank = [x["model"] for x in rows].index("realized_ours") + 1
    beats = [x["model"] for x in rows if x["model"] != "realized_ours"
             and rows[our_rank - 1]["qlike"] < x["qlike"]]
    report = {
        "ts": int(time.time()), "predictions": n, "tickers": len(UNIVERSE),
        "task": "1-month-ahead volatility forecast, expanding-window OOS, QLIKE loss (lower=better)",
        "ranking": rows, "our_rank": our_rank,
        "verdict": f"our realized-vol MC ranks #{our_rank}/{len(models)} by QLIKE; beats {', '.join(beats) or 'none'}.",
        "honesty": "Volatility IS forecastable (it clusters) — unlike direction. GARCH usually wins on "
                   "QLIKE; if our simple realized-vol is close, the scenario MC is well-sized. If GARCH "
                   "clearly beats us, swapping the MC's vol input for GARCH is a real, free upgrade.",
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(f"\n1-MONTH VOL FORECAST — {n} OOS predictions, {len(UNIVERSE)} tickers (QLIKE, lower=better)")
    print(f"{'MODEL':<22}{'QLIKE':>9}")
    print("-" * 31)
    for x in rows:
        star = "  ← OURS" if x["model"] == "realized_ours" else ""
        print(f"{x['model']:<22}{x['qlike']:>9}{star}")
    print("-" * 31)
    print(report["verdict"])


if __name__ == "__main__":
    main()
