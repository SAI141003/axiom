import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");
export const dynamic = "force-dynamic";

async function readJson(rel: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf-8")); } catch { return null; }
}

// One view of every paper account: balance, P&L, win rate, the last 7 days, and
// the daily history the forward snapshot has been writing since 2026-08-14.
export async function GET() {
  const [status, forward] = await Promise.all([
    readJson(".data/engine_status.json"),
    readJson(".data/forward_perf.json"),
  ]);
  const engines: Record<string, any> = status?.engines ?? {};
  const accounts = Object.entries(engines)
    .filter(([k]) => k.includes("($100 acct)"))
    .map(([k, v]) => ({
      key: k, name: k.replace(" ($100 acct)", ""),
      account: v.account, pnl: v.pnl, trades: v.trades, wins: v.wins,
      winRate: v.win_rate, today: v.today, daily: v.daily ?? [], config: v.config,
    }));
  const probes = Object.entries(engines)
    .filter(([k]) => !k.includes("($100 acct)"))
    .map(([k, v]) => ({ key: k, name: k, trades: v.trades, wins: v.wins, winRate: v.win_rate, pnl: v.pnl, today: v.today }));

  // Equity history per account, one point per snapshotted day.
  const history: any[] = forward?.history ?? [];
  const equity = history.map((h) => {
    const row: Record<string, any> = { date: h.date };
    // Snapshots before the loss-floor fix recorded balances below zero; a
    // $100 account cannot owe money, so history is floored the same way.
    for (const [k, v] of Object.entries<any>(h.accounts ?? {})) row[k.replace(" ($100 acct)", "")] = Math.max(0, v.account ?? 0);
    return row;
  });

  const total = accounts.reduce((s, a) => s + (a.account ?? 0), 0);
  const pnl = accounts.reduce((s, a) => s + (a.pnl ?? 0), 0);
  const trades = accounts.reduce((s, a) => s + (a.trades ?? 0), 0);
  return NextResponse.json({
    ts: status?.ts ?? null, accounts, probes, equity,
    totals: { start: accounts.length * 100, account: Math.round(total * 100) / 100, pnl: Math.round(pnl * 100) / 100, trades },
    daysTracked: forward?.days_tracked ?? history.length,
  });
}
