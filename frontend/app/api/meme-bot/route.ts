import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Meme-coin bot — current open paper positions (with their momentum read) +
// the $100 account. Fast file read of the daemon's log; no live recompute.
export async function GET() {
  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", "meme_bot.jsonl"), "utf-8"); } catch {}
  const entries: any[] = [];
  const resolves = new Set<string>();
  const resolved: Record<string, any> = {};
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === "mentry") entries.push(r);
    else if (r.type === "mclose") { resolves.add(r.id); resolved[r.id] = r; }
  }
  const open = entries.filter((e) => !resolves.has(e.id))
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      sym: e.sym, coin: e.coin, entry: e.entry, m1h: e.m1h, m24h: e.m24h, score: e.score,
    }));
  const done = entries.filter((e) => resolves.has(e.id)).map((e) => ({ ...e, ...resolved[e.id] }));
  const wins = done.filter((d) => d.won).length;
  const pnl = done.reduce((a, d) => a + (d.pnl ?? 0), 0);
  return NextResponse.json({
    open,
    account: {
      value: Number((100 + pnl).toFixed(2)), pnl: Number(pnl.toFixed(2)),
      trades: done.length, wins, winRate: done.length ? wins / done.length : null,
      recent: done.slice(-8).reverse().map((d) => ({ sym: d.sym, won: d.won, pnl: d.pnl, reason: d.reason })),
    },
  });
}
