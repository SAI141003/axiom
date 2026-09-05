import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// Journal = the system's daily memory, written by dryrun/brain.py:
//   .data/journal_days.json   per-day per-strategy {trades, wins, pnl, win_prob}
//   .data/brain_lessons.json  attribution lessons + bounded actions taken
//   .data/mc_verdict.json     Monte Carlo robustness verdicts
//   logs/journal.jsonl        daily brain notes (kind: "brain-daily")
const ROOT = path.join(process.cwd(), "..");

async function readJson(p: string): Promise<any | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(ROOT, p), "utf-8"));
  } catch {
    return null;
  }
}

function analytics(trades: { s: string; ts: number; pnl: number; won: boolean }[]) {
  if (!trades.length) return null;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossW = wins.reduce((a, t) => a + t.pnl, 0);
  const grossL = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  // streaks + max drawdown on the chronological equity path
  let cw = 0, cl = 0, maxW = 0, maxL = 0, eq = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; }
    maxW = Math.max(maxW, cw); maxL = Math.max(maxL, cl);
    eq += t.pnl; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq);
  }
  // P&L distribution histogram (fixed $ bins)
  const edges = [-30, -20, -10, -5, -2, 0, 2, 5, 10, 20, 30, 50];
  const bins = Array.from({ length: edges.length + 1 }, (_, i) => ({
    label: i === 0 ? `<${edges[0]}` : i === edges.length ? `>${edges[edges.length - 1]}` : `${edges[i - 1]}..${edges[i]}`,
    mid: i === 0 ? edges[0] - 1 : i === edges.length ? edges[edges.length - 1] + 1 : (edges[i - 1] + edges[i]) / 2,
    n: 0,
  }));
  for (const t of trades) {
    let i = edges.findIndex((e) => t.pnl < e);
    if (i === -1) i = edges.length;
    bins[i].n++;
  }
  const avgWin = wins.length ? grossW / wins.length : 0;
  const avgLoss = losses.length ? grossL / losses.length : 0;
  const winRate = wins.length / trades.length;
  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Number(winRate.toFixed(4)),
    grossWin: Number(grossW.toFixed(2)),
    grossLoss: Number(grossL.toFixed(2)),
    netPnl: Number((grossW - grossL).toFixed(2)),
    profitFactor: grossL > 0 ? Number((grossW / grossL).toFixed(2)) : null,
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    expectancy: Number((winRate * avgWin - (1 - winRate) * avgLoss).toFixed(2)),
    largestWin: Number(Math.max(...trades.map((t) => t.pnl)).toFixed(2)),
    largestLoss: Number(Math.min(...trades.map((t) => t.pnl)).toFixed(2)),
    maxConsecWins: maxW,
    maxConsecLosses: maxL,
    maxDrawdown: Number(maxDD.toFixed(2)),
    histogram: bins,
    last20: trades.slice(-20).map((t) => ({ ...t, pnl: Number(t.pnl.toFixed(2)) })),
  };
}

export async function GET() {
  const [daysDoc, lessonsDoc, mcDoc, tradesDoc, enginesDoc] = await Promise.all([
    readJson(".data/journal_days.json"),
    readJson(".data/brain_lessons.json"),
    readJson(".data/mc_verdict.json"),
    readJson(".data/journal_trades.json"),
    readJson(".data/engine_status.json"),
  ]);

  // brain-daily notes from the shared journal
  let notes: any[] = [];
  try {
    const raw = await fs.readFile(path.join(ROOT, "logs", "journal.jsonl"), "utf-8");
    notes = raw.trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r?.kind === "brain-daily")
      .slice(-30).reverse();
  } catch {}

  const days = daysDoc?.days ?? {};
  const sortedDays = Object.keys(days).sort();

  // flat series for charts: per day → total pnl + per-strategy pnl
  const series = sortedDays.map((d) => {
    const strats = days[d];
    const total = Object.values(strats).reduce((a: number, s: any) => a + s.pnl, 0);
    return { day: d, total: Number(total.toFixed(2)), ...Object.fromEntries(
      Object.entries(strats).map(([k, v]: [string, any]) => [k, v.pnl]),
    ) };
  });
  let cum = 0;
  const equity = series.map((s) => ({ day: s.day, equity: Number((cum += s.total).toFixed(2)) }));

  // per-strategy rollup across all days + MC win probability
  const strategies: Record<string, any> = {};
  for (const d of sortedDays) {
    for (const [s, rec] of Object.entries<any>(days[d])) {
      const agg = strategies[s] ?? { trades: 0, wins: 0, pnl: 0, days: 0 };
      agg.trades += rec.trades; agg.wins += rec.wins;
      agg.pnl = Number((agg.pnl + rec.pnl).toFixed(2)); agg.days += 1;
      strategies[s] = agg;
    }
  }
  const verdicts = mcDoc?.verdicts ?? {};
  for (const [s, agg] of Object.entries<any>(strategies)) {
    agg.winRate = agg.trades ? Number((agg.wins / agg.trades).toFixed(3)) : 0;
    agg.winProb = Number(((agg.wins + 1) / (agg.trades + 2)).toFixed(3));
    const v = verdicts[s] ?? verdicts[s.replace("crypto-5m", "crypto-5m")];
    agg.mcVerdict = v?.verdict ?? "NO DATA";
    agg.mcProfitProb = v?.p_profit ?? null;
  }

  // correlation matrix of per-strategy DAILY P&L (Dalio's Holy Grail: the
  // portfolio's value is low correlation between streams, not any one P&L)
  const stratNames = Object.keys(strategies);
  const dailyVec: Record<string, number[]> = Object.fromEntries(stratNames.map((s) => [s, []]));
  for (const d of sortedDays) {
    for (const s of stratNames) dailyVec[s].push(days[d][s]?.pnl ?? 0);
  }
  const corr = (a: number[], b: number[]): number | null => {
    const n = a.length;
    if (n < 3) return null;
    const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
    let num = 0, va = 0, vb = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); va += (a[i] - ma) ** 2; vb += (b[i] - mb) ** 2; }
    return va > 0 && vb > 0 ? Number((num / Math.sqrt(va * vb)).toFixed(2)) : null;
  };
  const correlations: Record<string, Record<string, number | null>> = {};
  for (const s1 of stratNames) {
    correlations[s1] = {};
    for (const s2 of stratNames) {
      correlations[s1][s2] = s1 === s2 ? 1 : corr(dailyVec[s1], dailyVec[s2]);
    }
  }

  // calendar: day → { pnl, trades } for the month grid
  const calendar: Record<string, { pnl: number; trades: number }> = {};
  for (const d of sortedDays) {
    const strats = days[d];
    calendar[d] = {
      pnl: Number(Object.values(strats).reduce((a: number, s: any) => a + s.pnl, 0).toFixed(2)),
      trades: Object.values(strats).reduce((a: number, s: any) => a + s.trades, 0),
    };
  }

  return NextResponse.json({
    generated: Date.now(),
    days: series,
    equity,
    strategies,
    engines: enginesDoc?.engines ?? {},
    calendar,
    correlations,
    analytics: analytics(tradesDoc?.trades ?? []),
    lessons: lessonsDoc?.lessons ?? [],
    actions: lessonsDoc?.actions ?? [],
    notes,
  });
}
