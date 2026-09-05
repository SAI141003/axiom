import { NextResponse } from "next/server";
import { simulateTerminal, scoreOption } from "@/lib/montecarlo";

/**
 * Options desk — quant analysis of real chains, CALL/PUT recommendation + sizing.
 * Analysis only: nothing is ever ordered.
 *
 * Formulas ported from this repo's Python quant stack:
 *   - Yang-Zhang (2000) OHLC vol      ← signals/crypto_binary_signal.py::_yang_zhang_vol
 *   - Black-Scholes d1/d2/delta/N(d2) ← signals/heston_pricer.py
 *   - Robust Kelly Eq.4 sizing        ← signals/heston_pricer.py::robust_kelly
 *   - Multi-factor direction score    ← signals/ensemble.py::_multi_factor_score (QuantDinger)
 *
 * Data: Yahoo Finance v7 options + v8 chart (cookie+crumb, no key).
 */

const UA = { "User-Agent": "Mozilla/5.0" };

async function resolveSymbol(query: string): Promise<string | null> {
  // exact ticker passes through; company names resolve via Yahoo search
  if (/^[A-Z]{1,5}([.\-][A-Z]{1,3})?$/.test(query)) return query;
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=5&newsCount=0`,
      { headers: UA });
    if (!res.ok) return null;
    const quotes = (await res.json()).quotes ?? [];
    const pick = quotes.find((q: any) => q.symbol && /^[A-Z]{1,5}$/.test(q.symbol)
      && (q.quoteType === "EQUITY" || q.quoteType === "ETF"));
    return pick?.symbol ?? quotes[0]?.symbol ?? null;
  } catch { return null; }
}
const RISK_FREE = 0.045;
const KELLY_LAMBDA = 1.5;          // cfg.kelly_lambda
const MAX_RISK_PCT = 0.02;         // never risk more than 2% of bankroll on one trade

// ── Yahoo crumb manager (cookie+crumb required since 2024) ───────────────────
let _auth: { cookie: string; crumb: string; ts: number } | null = null;

async function yahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (_auth && Date.now() - _auth.ts < 20 * 60_000) return _auth;
  const r1 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { ...UA, cookie },
  });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("{")) throw new Error("yahoo crumb fetch failed");
  _auth = { cookie, crumb, ts: Date.now() };
  return _auth;
}

async function yGet(url: string): Promise<any> {
  const { cookie, crumb } = await yahooAuth();
  const sep = url.includes("?") ? "&" : "?";
  const res = await fetch(`${url}${sep}crumb=${encodeURIComponent(crumb)}`, {
    headers: { ...UA, cookie },
    cache: "no-store",
  });
  if (res.status === 401) { _auth = null; throw new Error("yahoo 401"); }
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  return res.json();
}

// ── Math (ports) ──────────────────────────────────────────────────────────────

function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

/** Yang-Zhang (2000) — port of signals/crypto_binary_signal.py::_yang_zhang_vol
 *  bars: [open, high, low, close][], daily → annualize by 252. */
function yangZhangVol(bars: number[][]): number {
  const n = bars.length;
  if (n < 4) return 0;
  const logRs: number[] = [], logCo: number[] = [], logOo: number[] = [];
  for (const [o, h, l, c] of bars) {
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    const lh = Math.log(h / o), ll = Math.log(l / o), lc = Math.log(c / o);
    logRs.push(lh * (lh - lc) + ll * (ll - lc));
    logCo.push(lc);
  }
  for (let i = 1; i < n; i++) {
    if (bars[i][0] > 0 && bars[i - 1][0] > 0) logOo.push(Math.log(bars[i][0] / bars[i - 1][0]));
  }
  if (logRs.length < 3 || logOo.length < 2) return 0;
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
  const s2rs = mean(logRs);
  const oBar = mean(logOo);
  const s2o = mean(logOo.map((r) => (r - oBar) ** 2));
  const cBar = mean(logCo);
  const s2c = mean(logCo.map((r) => (r - cBar) ** 2));
  const m = logRs.length;
  const k = 0.34 / (1.34 + (m + 1) / Math.max(m - 1, 1));
  return Math.sqrt(Math.max(0, (s2o + k * s2c + (1 - k) * s2rs) * 252));
}

function bsD1(S: number, K: number, sigma: number, T: number): number {
  return (Math.log(S / K) + (RISK_FREE + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
}

/** Robust Kelly Eq.4 — port of signals/heston_pricer.py::robust_kelly */
function robustKelly(pModel: number, pMarket: number, bankroll: number, varP: number): number {
  const edge = pModel - pMarket;
  if (edge <= 0 || pMarket >= 1) return 0;
  const fStar = edge / (1 - pMarket);
  const varF = varP / (1 - pMarket) ** 2;
  const fHat = fStar / (1 + KELLY_LAMBDA * varF);
  return Math.max(0, Math.min(0.35, fHat)) * bankroll;
}

// ── Analysis ──────────────────────────────────────────────────────────────────

interface Contract {
  strike: number; bid: number; ask: number; mid: number;
  iv: number; oi: number; volume: number; delta: number; spreadPct: number;
}

function parseContracts(raw: any[], S: number, T: number, isCall: boolean, fallbackIv: number): Contract[] {
  return (raw ?? [])
    .filter((c) => c.bid > 0 && c.ask > 0)
    .map((c) => {
      const iv = c.impliedVolatility > 0.01 && c.impliedVolatility < 5 ? c.impliedVolatility : fallbackIv;
      const d1 = bsD1(S, c.strike, iv, T);
      const mid = (c.bid + c.ask) / 2;
      return {
        strike: c.strike, bid: c.bid, ask: c.ask, mid: +mid.toFixed(2),
        iv: +iv.toFixed(4), oi: c.openInterest ?? 0, volume: c.volume ?? 0,
        delta: +((isCall ? normCdf(d1) : normCdf(d1) - 1)).toFixed(3),
        spreadPct: +(((c.ask - c.bid) / Math.max(0.01, mid)) * 100).toFixed(1),
      };
    });
}

async function analyzeSymbol(sym: string, bankroll: number) {
  // 1. 6mo daily OHLC → Yang-Zhang RV, momentum, trend
  const chart = await yGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=6mo&interval=1d`);
  const r = chart.chart?.result?.[0];
  if (!r) throw new Error(`no chart for ${sym}`);
  const q = r.indicators.quote[0];
  const bars: number[][] = [];
  for (let i = 0; i < (r.timestamp?.length ?? 0); i++) {
    if (q.open[i] != null) bars.push([q.open[i], q.high[i], q.low[i], q.close[i]]);
  }
  const S: number = r.meta.regularMarketPrice;
  const closes = bars.map((b) => b[3]);
  const rv = yangZhangVol(bars);
  const ret21 = closes.length > 21 ? closes[closes.length - 1] / closes[closes.length - 22] - 1 : 0;
  const ret63 = closes.length > 63 ? closes[closes.length - 1] / closes[closes.length - 64] - 1 : 0;
  const sma50 = closes.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, closes.length);
  const smaAll = closes.reduce((a, b) => a + b, 0) / closes.length;

  // 2. options chain — expiry closest to 35 DTE
  const meta = await yGet(`https://query1.finance.yahoo.com/v7/finance/options/${sym}`);
  const oc = meta.optionChain?.result?.[0];
  if (!oc?.expirationDates?.length) throw new Error(`no options for ${sym}`);
  const now = Date.now() / 1000;
  const target = [...oc.expirationDates].sort(
    (a: number, b: number) => Math.abs(a - now - 35 * 86400) - Math.abs(b - now - 35 * 86400),
  )[0];
  const chain = await yGet(`https://query1.finance.yahoo.com/v7/finance/options/${sym}?date=${target}`);
  const opts = chain.optionChain?.result?.[0]?.options?.[0];
  if (!opts) throw new Error(`empty chain for ${sym}`);
  const T = Math.max(1, (target - now) / 86400) / 365;
  const dte = Math.round((target - now) / 86400);

  // ATM IV from contracts nearest spot with sane IVs
  const sane = [...(opts.calls ?? []), ...(opts.puts ?? [])]
    .filter((c: any) => c.impliedVolatility > 0.01 && c.impliedVolatility < 5)
    .sort((a: any, b: any) => Math.abs(a.strike - S) - Math.abs(b.strike - S))
    .slice(0, 6);
  const atmIv = sane.length ? sane.reduce((a: number, c: any) => a + c.impliedVolatility, 0) / sane.length : rv;

  const calls = parseContracts(opts.calls, S, T, true, atmIv);
  const puts = parseContracts(opts.puts, S, T, false, atmIv);

  // 3. Multi-factor direction score (QuantDinger port — ensemble.py weights)
  const monthlyVol = Math.max(0.02, rv / Math.sqrt(12));
  const momentum = Math.max(-1, Math.min(1, ret21 / monthlyVol));            // vol-normalized 1m return
  const trend = (S > sma50 ? 0.5 : -0.5) + (S > smaAll ? 0.5 : -0.5);        // SMA50 + SMA~120
  const value = Math.max(-1, Math.min(1, (rv - atmIv) / Math.max(0.05, atmIv))); // RV>IV → options cheap
  const score = 0.40 * momentum + 0.30 * trend + 0.30 * Math.abs(value) * Math.sign(momentum + trend || 1);
  const direction: "CALL" | "PUT" | "SKIP" =
    score > 0.15 ? "CALL" : score < -0.15 ? "PUT" : "SKIP";

  // 4. pick contract: |delta| 0.30-0.50, liquid, tight spread.
  //    If the delta-optimal contract exceeds the risk budget, walk down to a
  //    cheaper OTM strike (|delta| ≥ 0.18) that actually fits the budget.
  const pool = direction === "CALL" ? calls : puts;
  const riskBudgetCap = bankroll * MAX_RISK_PCT;
  const liquid = pool.filter((c) => c.oi >= 100 && c.spreadPct <= 15);
  let pick = direction === "SKIP" ? null : liquid
    .filter((c) => Math.abs(Math.abs(c.delta) - 0.40) < 0.12)
    .sort((a, b) => b.oi - a.oi)[0] ?? null;
  let sizingNote: string | null = null;
  if (pick && pick.ask * 100 > riskBudgetCap) {   // a buyer pays the ASK
    const fits = (c: Contract) => (c.ask || c.mid) * 100 <= riskBudgetCap;
    // pass 1: still a respectable delta
    let affordable = liquid
      .filter((c) => Math.abs(c.delta) >= 0.18 && Math.abs(c.delta) <= 0.40 && fits(c))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] ?? null;
    if (affordable) {
      sizingNote = `delta-optimal $${pick.strike} costs $${(pick.ask * 100).toFixed(0)}/contract at the ask — over the ${MAX_RISK_PCT * 100}% risk cap ($${riskBudgetCap.toFixed(0)}); walked down to an affordable strike`;
      pick = affordable;
    } else {
      // pass 2: low-delta lottery territory — offer it but say what it is
      affordable = liquid
        .filter((c) => Math.abs(c.delta) >= 0.08 && Math.abs(c.delta) < 0.18 && fits(c))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))[0] ?? null;
      if (affordable) {
        sizingNote = `only low-delta (|δ|=${Math.abs(affordable.delta).toFixed(2)}) fits your ${MAX_RISK_PCT * 100}% risk cap — lottery-ticket odds: most likely expires worthless, sized accordingly`;
        pick = affordable;
      } else {
        sizingNote = `no liquid contract fits your ${MAX_RISK_PCT * 100}% risk cap ($${riskBudgetCap.toFixed(0)}/contract). Raise bankroll or trade defined-risk spreads instead.`;
      }
    }
  }

  // 5. sizing — Robust Kelly Eq.4 with |delta| as P(ITM) proxy vs breakeven prob
  let sizing = null;
  if (pick) {
    const pItm = Math.abs(pick.delta);                        // ≈ risk-neutral P(ITM)
    const edgeBoost = Math.min(0.15, Math.abs(score) * 0.15); // our directional view
    const pModel = Math.min(0.9, pItm + edgeBoost);
    const varP = 0.0016;                                       // single-model estimate variance
    const kellyUsd = robustKelly(pModel, pItm, bankroll, varP);
    const riskBudget = Math.min(kellyUsd, riskBudgetCap);
    // REAL economics: entry at the ASK (what a buyer actually pays) — mid
    // flattered cost, breakeven and max-loss (same bug class as Gamma-mid
    // vs CLOB-ask in the crypto arb).
    const entryPx = pick.ask || pick.mid;
    const costPer = entryPx * 100;
    const contracts = Math.max(0, Math.floor(riskBudget / costPer));
    const be = direction === "CALL" ? pick.strike + entryPx : pick.strike - entryPx;
    sizing = {
      contracts,
      costPerContract: +costPer.toFixed(0),
      totalCost: +(contracts * costPer).toFixed(0),
      maxLossUsd: +(contracts * costPer).toFixed(0),
      breakeven: +be.toFixed(2),
      breakevenMovePct: +(((be - S) / S) * 100).toFixed(1),
      riskPctOfBankroll: +((contracts * costPer / bankroll) * 100).toFixed(2),
      note: sizingNote,
    };
  }

  // 6. penny options — cheap far-OTM contracts in the signal direction.
  //    Pennies live in SHORT-DATED chains, so scan the nearest weekly expiry
  //    too, not just the 35-DTE one. % spread is meaningless at 5¢ — filter
  //    on ABSOLUTE spread. Ranked by |delta| per dollar (probability per $).
  let pennyPool: (Contract & { expiry: string; dte: number })[] =
    pool.map((c) => ({ ...c, expiry: new Date(target * 1000).toISOString().slice(0, 10), dte }));
  const nearest = oc.expirationDates[0];
  if (direction !== "SKIP" && nearest !== target) {
    try {
      const nc = await yGet(`https://query1.finance.yahoo.com/v7/finance/options/${sym}?date=${nearest}`);
      const nOpts = nc.optionChain?.result?.[0]?.options?.[0];
      if (nOpts) {
        const nT = Math.max(0.5, (nearest - now) / 86400) / 365;
        const nDte = Math.max(1, Math.round((nearest - now) / 86400));
        const nExp = new Date(nearest * 1000).toISOString().slice(0, 10);
        const raw = direction === "CALL" ? nOpts.calls : nOpts.puts;
        pennyPool = pennyPool.concat(
          parseContracts(raw, S, nT, direction === "CALL", atmIv)
            .map((c) => ({ ...c, expiry: nExp, dte: nDte })),
        );
      }
    } catch { /* nearest-expiry scan is best-effort */ }
  }
  const pennyPicks = direction === "SKIP" ? [] : pennyPool
    .filter((c) => c.mid <= 1.0 && c.bid >= 0.01 && c.oi >= 50 &&
                   (c.ask - c.bid) <= 0.10 && Math.abs(c.delta) >= 0.02)
    .map((c) => {
      const contracts = Math.floor(riskBudgetCap / (c.mid * 100));
      const be = direction === "CALL" ? c.strike + c.mid : c.strike - c.mid;
      return {
        strike: c.strike, mid: c.mid, bid: c.bid, ask: c.ask,
        delta: c.delta, oi: c.oi, iv: +(c.iv * 100).toFixed(1),
        expiry: c.expiry, dte: c.dte,
        deltaPerDollar: +(Math.abs(c.delta) / c.mid).toFixed(3),
        contracts: Math.min(contracts, 50),
        totalCost: +(Math.min(contracts, 50) * c.mid * 100).toFixed(0),
        breakeven: +be.toFixed(2),
        breakevenMovePct: +(((be - S) / S) * 100).toFixed(1),
        approxWinProb: +(Math.abs(c.delta) * 100).toFixed(0),  // |δ| ≈ P(ITM)
      };
    })
    .sort((a, b) => b.deltaPerDollar - a.deltaPerDollar)
    .slice(0, 3);

  // ── Monte Carlo — 10,000 paths (5k GBM + 5k bootstrap of real returns) ────
  let montecarlo: any = null;
  let mcContract: any = null;
  {
    const { terminals, result } = simulateTerminal(S, Math.max(0.08, rv), dte, closes, 10_000);
    montecarlo = result;
    if (pick && direction !== "SKIP") {
      mcContract = scoreOption(terminals, direction as "CALL" | "PUT",
                               pick.strike, pick.ask || pick.mid, dte);
    }
  }

  const nearAtm = (arr: Contract[]) =>
    [...arr].sort((a, b) => Math.abs(a.strike - S) - Math.abs(b.strike - S)).slice(0, 16)
      .sort((a, b) => a.strike - b.strike);

  return {
    symbol: sym, price: S,
    metrics: {
      yangZhangRv: +(rv * 100).toFixed(1),
      atmIv: +(atmIv * 100).toFixed(1),
      ivPremiumPct: +(((atmIv - rv) / Math.max(0.01, rv)) * 100).toFixed(0),
      ret1mPct: +(ret21 * 100).toFixed(1),
      ret3mPct: +(ret63 * 100).toFixed(1),
      aboveSma50: S > sma50,
      score: +score.toFixed(3),
    },
    expiry: new Date(target * 1000).toISOString().slice(0, 10),
    dte,
    direction,
    recommendation: pick ? {
      type: direction, strike: pick.strike, mid: pick.mid, bid: pick.bid, ask: pick.ask,
      delta: pick.delta, iv: +(pick.iv * 100).toFixed(1), oi: pick.oi, spreadPct: pick.spreadPct,
    } : null,
    sizing,
    montecarlo,
    mcContract,
    pennyPicks,
    chain: { calls: nearAtm(calls), puts: nearAtm(puts) },
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const rawSymbols = (searchParams.get("symbols") ?? "NVDA,TSLA,AAPL,MSFT,AMD,GOOGL,META,MU")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
  const resolved = await Promise.all(rawSymbols.map(resolveSymbol));
  const symbols = Array.from(new Set(resolved.filter((x): x is string => !!x)));
  const bankroll = Math.max(500, parseFloat(searchParams.get("bankroll") ?? "10000") || 10000);

  const results = await Promise.allSettled(symbols.map((s) => analyzeSymbol(s, bankroll)));
  const ok = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === "fulfilled")
    .map((r) => r.value)
    .sort((a, b) => Math.abs(b.metrics.score) - Math.abs(a.metrics.score));
  const failed = symbols.filter((_, i) => results[i].status === "rejected");

  return NextResponse.json({ bankroll, results: ok, failed, generated: Date.now() });
}
