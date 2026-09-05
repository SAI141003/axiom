import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Gamma Pulse — current open paper positions (with their dealer-gamma read) +
// the $100 account. Fast file read of the daemon's log; no live recompute.
export async function GET() {
  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", "gamma_pulse_paper.jsonl"), "utf-8"); } catch {}
  const entries: any[] = [], resolves = new Set<string>();
  const resolved: Record<string, any> = {};
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === "gentry") entries.push(r);
    else if (r.type === "gresolve") { resolves.add(r.id); resolved[r.id] = r; }
  }
  const open = entries.filter((e) => !resolves.has(e.id))
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      symbol: e.symbol, side: e.side, entry: e.entry, regime: e.regime,
      shortGamma: e.short_gamma, recent5d: e.recent_5d,
      callWall: e.call_wall, putWall: e.put_wall, zeroGamma: e.zero_gamma,
    }));
  const done = entries.filter((e) => resolves.has(e.id)).map((e) => ({ ...e, ...resolved[e.id] }));
  const wins = done.filter((d) => d.won).length;
  const pnl = done.reduce((a, d) => a + (d.pnl ?? 0), 0);
  return NextResponse.json({
    open,
    account: {
      value: Number((100 + pnl).toFixed(2)), pnl: Number(pnl.toFixed(2)),
      trades: done.length, wins, winRate: done.length ? wins / done.length : null,
      recent: done.slice(-8).reverse().map((d) => ({ symbol: d.symbol, side: d.side, won: d.won, pnl: d.pnl })),
    },
  });
}
