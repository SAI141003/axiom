/**
 * Monte Carlo engine — 10,000 paths per run (5,000 GBM + 5,000 bootstrap).
 *
 * Two methods, half the paths each, so results aren't hostage to one model:
 *   - GBM: geometric Brownian motion with Yang-Zhang σ, risk-free drift
 *     (Black-Scholes world — same math as the repo's heston_pricer d2 pricing)
 *   - BOOTSTRAP: resamples the stock's OWN actual daily log-returns —
 *     captures fat tails and skew that GBM misses
 *
 * Used by /api/options (contract P(profit), MC fair value) and
 * /api/ai stock-analyst (target distribution in the dossier).
 */

const RISK_FREE = 0.045;

function randn(): number {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export interface McResult {
  paths: number;
  method: string;
  horizonDays: number;
  p10: number; p50: number; p90: number;
  pGain: number;                  // P(S_T > S_0)
  meanTerminal: number;
}

/** Terminal-price distribution after horizonDays. closes = daily history. */
export function simulateTerminal(
  S0: number, sigmaAnn: number, horizonDays: number, closes: number[],
  nPaths = 10_000,
): { terminals: number[]; result: McResult } {
  const T = horizonDays / 252;
  const half = Math.floor(nPaths / 2);
  const terminals: number[] = new Array(nPaths);

  // GBM half — exact terminal draw (no path discretization error)
  const drift = (RISK_FREE - (sigmaAnn * sigmaAnn) / 2) * T;
  const vol = sigmaAnn * Math.sqrt(T);
  for (let i = 0; i < half; i++) {
    terminals[i] = S0 * Math.exp(drift + vol * randn());
  }

  // Bootstrap half — resample the stock's real daily log-returns,
  // DE-MEANED to risk-neutral drift: keeps the true fat tails and skew but
  // strips historical momentum, so "MC fair vs market" is a pricing statement
  // rather than a bet that the recent trend repeats.
  const rawRets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rawRets.push(Math.log(closes[i] / closes[i - 1]));
  }
  const histMean = rawRets.reduce((a, b) => a + b, 0) / Math.max(1, rawRets.length);
  const rfDaily = RISK_FREE / 252;
  const rets = rawRets.map((r) => r - histMean + rfDaily);
  const steps = Math.max(1, Math.round(horizonDays));
  for (let i = half; i < nPaths; i++) {
    let logS = Math.log(S0);
    for (let s = 0; s < steps; s++) {
      logS += rets[(Math.random() * rets.length) | 0] ?? 0;
    }
    terminals[i] = Math.exp(logS);
  }

  terminals.sort((a, b) => a - b);
  const q = (p: number) => terminals[Math.min(nPaths - 1, Math.floor(p * nPaths))];
  const mean = terminals.reduce((a, b) => a + b, 0) / nPaths;

  return {
    terminals,
    result: {
      paths: nPaths,
      method: "GBM + historical bootstrap (50/50)",
      horizonDays,
      p10: +q(0.10).toFixed(2), p50: +q(0.50).toFixed(2), p90: +q(0.90).toFixed(2),
      pGain: +(terminals.filter((s) => s > S0).length / nPaths).toFixed(4),
      meanTerminal: +mean.toFixed(2),
    },
  };
}

export interface McOption {
  paths: number;
  pITM: number;           // P(expires in the money)
  pProfit: number;        // P(payoff > premium paid)
  mcFair: number;         // discounted expected payoff
  mcEdgePct: number;      // (fair − ask) / ask
  expectedPnlPerContract: number;
}

/** Score a long option against the MC terminal distribution. */
export function scoreOption(
  terminals: number[], type: "CALL" | "PUT", strike: number, askPremium: number,
  horizonDays: number,
): McOption {
  const n = terminals.length;
  let itm = 0, profit = 0, payoffSum = 0;
  for (const sT of terminals) {
    const payoff = type === "CALL" ? Math.max(0, sT - strike) : Math.max(0, strike - sT);
    if (payoff > 0) itm++;
    if (payoff > askPremium) profit++;
    payoffSum += payoff;
  }
  const disc = Math.exp(-RISK_FREE * (horizonDays / 252));
  const fair = (payoffSum / n) * disc;
  return {
    paths: n,
    pITM: +(itm / n).toFixed(4),
    pProfit: +(profit / n).toFixed(4),
    mcFair: +fair.toFixed(2),
    mcEdgePct: +(((fair - askPremium) / Math.max(0.01, askPremium)) * 100).toFixed(1),
    expectedPnlPerContract: +((fair - askPremium) * 100).toFixed(0),
  };
}
