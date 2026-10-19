import { monthly, type Market } from "./invest";
import { leaders, type Leader } from "./investStocks";

// THE SIP PLANNER — a monthly amount in, a plan out.
//
// 1. Allocation: risk level → stock/bond split, capped by how soon the money
//    is needed (a 2-year goal does not belong in stocks).
// 2. Back-test: the exact monthly SIP replayed on real month-end prices,
//    dividends in, from every start month the data allows.
// 3. Forward view: 2,000 block-bootstrapped paths that keep the funds' real
//    monthly swings and co-movement but are re-centred on conservative
//    long-run returns (stocks 6.5%, bonds 3.5% a year) instead of the strong
//    last decade, so the median is not a replay of a bull market.

export type Risk = "conservative" | "balanced" | "growth" | "aggressive";
export type Style = "diversified" | "simple" | "diy";
export type PlanInput = { market: Market; monthly: number; years: number; risk: Risk; style: Style; goal?: number };

const EQUITY: Record<Risk, number> = { conservative: 0.4, balanced: 0.6, growth: 0.8, aggressive: 1.0 };
const ER_STOCK = 0.065, ER_BOND = 0.035, ER_METAL = 0.04, INFLATION = 0.025;
// Diversified: a metals slice (gold 80 / silver 20) and a stock slice of one
// proven leader per sector, beside the broad ETF core. The stock slice grows
// with risk; it stays a minority because broad ETFs already hold every company.
const METALS = 0.05;
const STOCK_SLICE: Record<Risk, number> = { conservative: 0.10, balanced: 0.15, growth: 0.20, aggressive: 0.25 };
const METAL_FUNDS: Record<Market, { gold: string; silver: string }> = { us: { gold: "IAU", silver: "SLV" }, ca: { gold: "CGL-C.TO", silver: "SVR-C.TO" } };

type Leg = { symbol: string; weight: number; role: string; stock: number; kind: "etf" | "bond" | "stock" | "metal"; sector?: string };

// Building blocks: the funds the back-test runs on (long histories).
function blocks(market: Market, eq: number): Leg[] {
  const b = 1 - eq;
  const legs: Leg[] = market === "us"
    ? [{ symbol: "VTI", weight: eq * 0.65, role: "US total stock market", stock: 1, kind: "etf" },
       { symbol: "VXUS", weight: eq * 0.35, role: "International stocks (developed + emerging)", stock: 1, kind: "etf" },
       { symbol: "BND", weight: b, role: "US investment-grade bonds", stock: 0, kind: "bond" }]
    : [{ symbol: "XIC.TO", weight: eq * 0.30, role: "Canadian stocks (TSX composite)", stock: 1, kind: "etf" },
       { symbol: "XUU.TO", weight: eq * 0.45, role: "US total stock market (in CAD)", stock: 1, kind: "etf" },
       { symbol: "XEF.TO", weight: eq * 0.20, role: "International developed stocks", stock: 1, kind: "etf" },
       { symbol: "XEC.TO", weight: eq * 0.05, role: "Emerging-market stocks", stock: 1, kind: "etf" },
       { symbol: "ZAG.TO", weight: b, role: "Canadian investment-grade bonds", stock: 0, kind: "bond" }];
  return legs.filter((l) => l.weight > 0.0001);
}

// One-ticket funds that hold the same mix, rebalanced for you.
const ONE_TICKET: Record<Market, Record<Risk, { symbol: string; role: string }>> = {
  us: { conservative: { symbol: "AOM", role: "iShares Core 40/60 moderate allocation" },
        balanced: { symbol: "AOR", role: "iShares Core 60/40 growth allocation" },
        growth: { symbol: "AOA", role: "iShares Core 80/20 aggressive allocation" },
        aggressive: { symbol: "VT", role: "Vanguard Total World Stock (100% stocks)" } },
  ca: { conservative: { symbol: "XCNS.TO", role: "iShares Core Conservative Balanced (40/60)" },
        balanced: { symbol: "XBAL.TO", role: "iShares Core Balanced (60/40)" },
        growth: { symbol: "XGRO.TO", role: "iShares Core Growth (80/20)" },
        aggressive: { symbol: "XEQT.TO", role: "iShares Core Equity (100% stocks)" } },
};

function capRisk(risk: Risk, years: number): { risk: Risk; note: string | null } {
  if (years < 3 && risk !== "conservative") return { risk: "conservative", note: `Money needed within ${years} year${years === 1 ? "" : "s"} should not ride the stock market — capped at Conservative (40% stocks). For under 2 years, a high-interest savings account or GIC/T-bills is safer still.` };
  if (years < 6 && (risk === "growth" || risk === "aggressive")) return { risk: "balanced", note: `A ${years}-year horizon is too short to wait out a deep stock fall (2008 took ~5 years to recover) — capped at Balanced (60% stocks).` };
  return { risk, note: null };
}

// First trading day of a month on the NYSE or TSX, skipping weekends and the
// holidays that can fall in a month's first days: New Year (both), Canada Day
// (TSX, Jul 1), Civic Holiday (TSX, first Monday of August), Labour Day (both,
// first Monday of September). Observed-holiday shifts are applied.
function firstTradingDay(market: Market, year: number, month0: number): string {
  const d = new Date(Date.UTC(year, month0, 1, 12));
  const closed = (x: Date) => {
    const m = x.getUTCMonth(), day = x.getUTCDate(), wd = x.getUTCDay();
    if (wd === 0 || wd === 6) return true;
    if (m === 0 && (day === 1 || (day === 2 && wd === 1))) return true;                     // New Year (observed Mon)
    if (market === "ca" && m === 6 && (day === 1 || (day === 2 && wd === 1))) return true;   // Canada Day
    if (m === 8 && wd === 1 && day <= 7) return true;                                        // Labour Day
    if (market === "ca" && m === 7 && wd === 1 && day <= 7) return true;                     // Civic Holiday
    return false;
  };
  while (closed(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function nyTime(date: string, h: number, m: number): number {   // a New York wall-clock time → epoch ms
  const guess = Date.parse(`${date}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
  const asNy = Date.parse(new Date(guess).toLocaleString("sv-SE", { timeZone: "America/New_York" }).replace(" ", "T") + "Z");
  return guess - (asNy - guess);
}

const pctile = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))]; };

function irr(flows: number[]): number {   // monthly cash flows → annual money-weighted return
  let lo = -0.99, hi = 1;
  const npv = (r: number) => flows.reduce((s, f, i) => s + f / Math.pow(1 + r, i), 0);
  for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (npv(mid) > 0) lo = mid; else hi = mid; }
  return Math.pow(1 + (lo + hi) / 2, 12) - 1;
}

function diversified(market: Market, eq: number, risk: Risk, picks: Leader[]): Leg[] {
  const core = blocks(market, eq).map((l) => ({ ...l, weight: l.weight * (1 - METALS) }));
  const slice = picks.length ? eq * (1 - METALS) * STOCK_SLICE[risk] : 0;
  const legs: Leg[] = core.map((l) => (l.kind === "etf" ? { ...l, weight: l.weight * (1 - STOCK_SLICE[risk] * (picks.length ? 1 : 0)) } : l));
  for (const p of picks) legs.push({ symbol: p.symbol, weight: slice / picks.length, role: `${p.sector} leader — ${p.name}`, stock: 1, kind: "stock", sector: p.sector });
  const m = METAL_FUNDS[market];
  legs.push({ symbol: m.gold, weight: METALS * 0.8, role: "Gold bullion", stock: 0, kind: "metal", sector: "Metals" });
  legs.push({ symbol: m.silver, weight: METALS * 0.2, role: "Silver bullion", stock: 0, kind: "metal", sector: "Metals" });
  return legs.filter((l) => l.weight > 0.0001);
}

type Series = Awaited<ReturnType<typeof monthly>>;

// back-test, start-date check and forward paths for one set of legs
function analyze(legs: Leg[], series: Record<string, Series>, monthlyAmt: number, years: number, goal?: number) {
  const common = legs.map((l) => new Set(series[l.symbol]!.t.map((t) => new Date(t * 1000).toISOString().slice(0, 7))));
  const months = Array.from(common[0]).filter((m) => common.every((c) => c.has(m))).sort();
  const px = (s: string) => { const d = series[s]!; const map = new Map(d.t.map((t, i) => [new Date(t * 1000).toISOString().slice(0, 7), d.px[i]])); return months.map((m) => map.get(m)!); };
  const P = Object.fromEntries(legs.map((l) => [l.symbol, px(l.symbol)]));
  const n = months.length;
  const pr: number[] = [];   // the portfolio's monthly return, rebalanced to target each month
  for (let i = 1; i < n; i++) pr.push(legs.reduce((s, l) => s + l.weight * (P[l.symbol][i] / P[l.symbol][i - 1] - 1), 0));

  const units = Object.fromEntries(legs.map((l) => [l.symbol, 0]));
  const curve: { date: string; invested: number; value: number }[] = [];
  let invested = 0, peak = 0, worstDD = 0;
  for (let i = 0; i < n; i++) {
    for (const l of legs) units[l.symbol] += (monthlyAmt * l.weight) / P[l.symbol][i];
    invested += monthlyAmt;
    const value = legs.reduce((s, l) => s + units[l.symbol] * P[l.symbol][i], 0);
    peak = Math.max(peak, value); worstDD = Math.min(worstDD, value / peak - 1);
    curve.push({ date: months[i], invested: Math.round(invested), value: Math.round(value) });
  }
  const finalBT = curve[curve.length - 1].value;
  // money in at the start of each month; the account's value comes back at the last month-end
  const btIrr = irr(Array.from({ length: n }, (_, i) => (i === n - 1 ? finalBT - monthlyAmt : -monthlyAmt)));

  // the horizon itself when history covers it; otherwise 5-year stretches, so
  // there are still many start dates to compare
  const full = years * 12 <= n - 1;
  const H = full ? years * 12 : Math.min(60, n - 1);
  const rolling: { start: string; value: number; multiple: number }[] = [];
  for (let s = 0; s + H <= n - 1; s++) {
    let v = 0;
    for (let i = s; i < s + H; i++) v = (v + monthlyAmt) * (1 + pr[i]);
    rolling.push({ start: months[s], value: v, multiple: v / (monthlyAmt * H) });
  }
  const rs = [...rolling].sort((a, b) => a.multiple - b.multiple);

  // forward: re-centred block bootstrap
  const w = (k: Leg["kind"][]) => legs.filter((l) => k.includes(l.kind)).reduce((s, l) => s + l.weight, 0);
  const annual = w(["etf", "stock"]) * ER_STOCK + w(["bond"]) * ER_BOND + w(["metal"]) * ER_METAL;
  const mu = Math.pow(1 + annual, 1 / 12) - 1;
  const mHist = pr.reduce((s, x) => s + x, 0) / pr.length;
  const centred = pr.map((x) => x - mHist + mu);
  const T = years * 12, PATHS = 2000, BLOCK = Math.min(12, Math.max(1, centred.length - 1));
  let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const finals: number[] = [], finalsHist: number[] = [];
  const byYear: number[][] = Array.from({ length: years }, () => []);
  const byMonth: number[][] = Array.from({ length: Math.min(12, T) }, () => []);
  for (let p = 0; p < PATHS; p++) {
    let v = 0, vh = 0, t = 0;
    while (t < T) {
      const start = Math.floor(rnd() * (centred.length - BLOCK));
      for (let k = 0; k < BLOCK && t < T; k++, t++) {
        v = (v + monthlyAmt) * (1 + centred[start + k]);
        vh = (vh + monthlyAmt) * (1 + pr[start + k]);
        if (t < byMonth.length) byMonth[t].push(v);
        if ((t + 1) % 12 === 0) byYear[(t + 1) / 12 - 1].push(v);
      }
    }
    finals.push(v); finalsHist.push(vh);
  }
  const totalIn = monthlyAmt * T;
  return {
    months, n, byMonth,
    backtest: {
      from: months[0], to: months[n - 1], months: n, invested: Math.round(invested), value: finalBT, annual: btIrr, worstDrop: worstDD, curve,
      rolling: rs.length ? { horizonMonths: H, full, count: rs.length, worst: rs[0], median: rs[Math.floor(rs.length / 2)], best: rs[rs.length - 1],
        lossShare: rs.filter((r) => r.multiple < 1).length / rs.length } : null,
    },
    forecast: {
      invested: totalIn, p10: pctile(finals, 0.1), p50: pctile(finals, 0.5), p90: pctile(finals, 0.9),
      p50Today: pctile(finals, 0.5) / Math.pow(1 + INFLATION, years), histPace: pctile(finalsHist, 0.5),
      chanceAboveInvested: finals.filter((f) => f > totalIn).length / PATHS,
      chanceGoal: goal ? finals.filter((f) => f >= goal).length / PATHS : null,
      assumed: { stocks: ER_STOCK, bonds: ER_BOND, metals: ER_METAL, inflation: INFLATION, portfolio: annual },
      fan: byYear.map((a, i) => ({ year: i + 1, invested: monthlyAmt * 12 * (i + 1), p10: Math.round(pctile(a, 0.1)), p50: Math.round(pctile(a, 0.5)), p90: Math.round(pctile(a, 0.9)) })),
    },
  };
}

export async function buildPlan(inp: PlanInput) {
  const years = Math.max(1, Math.min(40, Math.round(inp.years)));
  const monthlyAmt = Math.max(1, inp.monthly);
  const { risk, note } = capRisk(inp.risk, years);
  const eq = EQUITY[risk];
  const core = blocks(inp.market, eq);
  const one = ONE_TICKET[inp.market][risk];
  const picks = await leaders(inp.market);
  const div = diversified(inp.market, eq, risk, picks);

  // real prices for everything any style might buy
  const syms = Array.from(new Set([...core, ...div].map((l) => l.symbol).concat(one.symbol)));
  const series: Record<string, Series> = Object.fromEntries(await Promise.all(syms.map(async (s) => [s, await monthly(s, "20y")] as const)));
  const usable = div.filter((l) => series[l.symbol]);   // a fund with no data drops out; its weight is spread over the rest
  const scale = 1 / usable.reduce((s, l) => s + l.weight, 0);
  const divLegs = usable.map((l) => ({ ...l, weight: l.weight * scale }));
  for (const l of core) if (!series[l.symbol]) throw new Error(`no price history for ${l.symbol}`);

  const A = { diversified: analyze(divLegs, series, monthlyAmt, years, inp.goal), core: analyze(core, series, monthlyAmt, years, inp.goal) };

  const price = (s: string) => { const d = series[s]; return d ? (d.meta?.regularMarketPrice ?? d.px[d.px.length - 1]) : null; };
  const order = (l: { symbol: string; weight: number; role: string; kind?: string; sector?: string }) => {
    const amt = monthlyAmt * l.weight, p = price(l.symbol);
    return { symbol: l.symbol, role: l.role, kind: l.kind ?? "etf", sector: l.sector ?? null, weight: l.weight, amount: Math.round(amt * 100) / 100,
             price: p, shares: p ? Math.floor(amt / p) : null, fractional: p ? amt / p : null };
  };
  const currency = inp.market === "ca" ? "CAD" : "USD";

  // the next 12 buys: exact day and time and where the plan should stand after each
  const now = new Date();
  const y0 = now.getUTCFullYear(), m0 = now.getUTCMonth();
  const first = nyTime(firstTradingDay(inp.market, y0, m0), 10, 0) > now.getTime() ? m0 : m0 + 1;
  const calendar = (a: ReturnType<typeof analyze>) => a.byMonth.map((vals, i) => {
    const m = first + i, day = firstTradingDay(inp.market, y0 + Math.floor(m / 12), m % 12);
    return { n: i + 1, date: day, at: nyTime(day, 10, 0), invested: monthlyAmt * (i + 1),
             likely: Math.round(pctile(vals, 0.5)), low: Math.round(pctile(vals, 0.1)), high: Math.round(pctile(vals, 0.9)) };
  });
  const view = (a: ReturnType<typeof analyze>) => ({ backtest: a.backtest, forecast: a.forecast, calendar: calendar(a) });
  const d = A.diversified.backtest, c = A.core.backtest;

  return {
    input: { ...inp, years, monthly: monthlyAmt }, risk, riskNote: note, equity: eq, currency,
    buy: { diversified: divLegs.map(order), simple: [order({ ...one, weight: 1 })], diy: core.map(order) },
    analysis: { diversified: view(A.diversified), core: view(A.core) },
    leaders: picks,
    // the reasoning chain, in order, for the page to show
    chain: [
      `Horizon ${years} years, risk ${inp.risk}${note ? ` → ${risk} (horizon cap)` : ""}: ${Math.round(eq * 100)}% growth assets / ${Math.round((1 - eq) * 100)}% bonds.`,
      `Diversified mix: broad ETFs as the core, ${Math.round(STOCK_SLICE[risk] * 100)}% of the stock money in ${picks.length} sector leaders (one per sector, 10+ years of data, best risk-adjusted return among the sector's leaders), and ${Math.round(METALS * 100)}% in gold and silver.`,
      `Back-tested on real month-end prices, dividends reinvested: diversified ${d.from} → ${d.to} ${(d.annual * 100).toFixed(1)}%/yr (worst fall ${(d.worstDrop * 100).toFixed(0)}%); ETF core alone ${(c.annual * 100).toFixed(1)}%/yr (worst ${(c.worstDrop * 100).toFixed(0)}%) on ${c.from} → ${c.to}.`,
      `Forward: 2,000 paths from 12-month blocks of the real history (keeps crashes and how the holdings move together), re-centred on ${(ER_STOCK * 100).toFixed(1)}% stocks / ${(ER_BOND * 100).toFixed(1)}% bonds / ${(ER_METAL * 100).toFixed(1)}% metals a year — below the last decade's pace on purpose.`,
      `Sector leaders are chosen on the past; leadership changes. That is why they are a slice beside ETFs that own every company, not the plan itself.`,
    ],
  };
}
