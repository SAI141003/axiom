import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const run = promisify(exec);
const LOG = path.join(process.cwd(), "..", "logs", "dryrun_weather.jsonl");

// The favorites gate (entry >= 0.70) went live 2026-07-26. The live book is every
// trade placed since; the ungated era before it is reported separately as v1.
// Same fee model as dryrun/brain.py so the two screens agree to the cent.
const GATE_TS = 1784998800;
const fee = (stake: number, e: number) => stake * 0.018 * 4 * e * (1 - e);

/**
 * Weather Auto-Bot feed — the daemon trades server-side 24/7 (one paper trade
 * per flagged edge at the real market price); this joins trades with
 * resolutions into positions + P&L. All real, nothing browser-dependent.
 */
export async function GET() {
  let rows: any[] = [];
  try {
    const { stdout } = await run(`grep -E '"type": "(wtrade|resolve)"' "${LOG}"`,
                                 { maxBuffer: 32 * 1024 * 1024 });
    rows = stdout.trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { /* no trades yet */ }

  const resolves: Record<string, any> = {};
  for (const r of rows) if (r.type === "resolve") resolves[r.slug] = r;

  const trades = rows.filter((r) => r.type === "wtrade").map((t) => {
    const res = resolves[t.slug];
    const book = t.ts >= GATE_TS ? "v2" : "v1";
    if (!res) return { ...t, status: "open", pnl: null, book };
    const bucketWon = t.low === res.winning_low && t.high === res.winning_high;
    const win = t.side === "YES" ? bucketWon : !bucketWon;
    const pnl = +((win ? t.stake * (1 / t.entry - 1) : -t.stake) - fee(t.stake, t.entry)).toFixed(2);
    return { ...t, status: win ? "won" : "lost", pnl, book };
  });

  const live = trades.filter((t: any) => t.book === "v2" || t.status === "open");
  const resolved = live.filter((t: any) => t.status !== "open");
  const wins = resolved.filter((t: any) => t.status === "won").length;
  const totalPnl = +resolved.reduce((a: number, t: any) => a + (t.pnl ?? 0), 0).toFixed(2);
  const v1 = trades.filter((t: any) => t.book === "v1" && t.status !== "open");
  const v1Pnl = +v1.reduce((a: number, t: any) => a + (t.pnl ?? 0), 0).toFixed(2);

  let equity = 0;
  const curve = resolved
    .sort((a: any, b: any) => a.ts - b.ts)
    .map((t: any) => { equity = +(equity + (t.pnl ?? 0)).toFixed(2); return { ts: t.ts, pnl: equity }; });

  return NextResponse.json({
    trades: live.sort((a: any, b: any) => b.ts - a.ts).slice(0, 80),
    stats: {
      placed: live.length,
      open: live.length - resolved.length,
      resolved: resolved.length,
      wins,
      winRate: resolved.length ? +(wins / resolved.length).toFixed(4) : 0,
      totalPnl,
      since: "2026-07-26",
    },
    retired: { label: "weather v1 (ungated, before 2026-07-26)", trades: v1.length, wins: v1.filter((t: any) => t.status === "won").length, totalPnl: v1Pnl },
    curve,
    generated: Date.now(),
  });
}
