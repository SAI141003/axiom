import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// CCXT strategy bot — open paper positions (with live unrealized) + the $100 account.
export async function GET() {
  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", "ccxt_bot.jsonl"), "utf-8"); } catch {}
  const entries: any[] = [];
  const closes = new Set<string>();
  const resolved: Record<string, any> = {};
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === "sentry") entries.push(r);
    else if (r.type === "sclose") { closes.add(r.id); resolved[r.id] = r; }
  }
  const open = entries.filter((e) => !closes.has(e.id))
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({ sym: e.sym, entry: e.entry, stake: e.stake, net: e.net }));
  const done = entries.filter((e) => closes.has(e.id)).map((e) => ({ ...e, ...resolved[e.id] }));
  const wins = done.filter((d) => d.won).length;
  const pnl = done.reduce((a, d) => a + (d.pnl ?? 0), 0);
  return NextResponse.json({
    open,
    account: {
      value: Number((100 + pnl).toFixed(2)), pnl: Number(pnl.toFixed(2)),
      trades: done.length, wins, winRate: done.length ? wins / done.length : null,
      recent: done.slice(-8).reverse().map((d) => ({ sym: d.sym, won: d.won, pnl: d.pnl })),
    },
  });
}
