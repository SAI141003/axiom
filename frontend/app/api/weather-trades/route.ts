import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const run = promisify(exec);
const LOG = path.join(process.cwd(), "..", "logs", "dryrun_weather.jsonl");

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
    if (!res) return { ...t, status: "open", pnl: null };
    const bucketWon = t.low === res.winning_low && t.high === res.winning_high;
    const win = t.side === "YES" ? bucketWon : !bucketWon;
    const pnl = +(win ? t.stake * (1 / t.entry - 1) : -t.stake).toFixed(2);
    return { ...t, status: win ? "won" : "lost", pnl };
  });

  const resolved = trades.filter((t) => t.status !== "open");
  const wins = resolved.filter((t) => t.status === "won").length;
  const totalPnl = +resolved.reduce((a, t) => a + (t.pnl ?? 0), 0).toFixed(2);

  let equity = 0;
  const curve = resolved
    .sort((a, b) => a.ts - b.ts)
    .map((t) => { equity = +(equity + (t.pnl ?? 0)).toFixed(2); return { ts: t.ts, pnl: equity }; });

  return NextResponse.json({
    trades: trades.sort((a, b) => b.ts - a.ts).slice(0, 80),
    stats: {
      placed: trades.length,
      open: trades.length - resolved.length,
      resolved: resolved.length,
      wins,
      winRate: resolved.length ? +(wins / resolved.length).toFixed(4) : 0,
      totalPnl,
    },
    curve,
    generated: Date.now(),
  });
}
