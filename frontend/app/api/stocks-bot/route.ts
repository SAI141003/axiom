import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Stocks bot — open positions + $100 account. Realized from closes; unrealized
// left to the daemon's next mark (this route is a fast file read, no live fetch).
export async function GET() {
  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", "stocks_bot.jsonl"), "utf-8"); } catch {}
  const entries: any[] = [], closedIds = new Set<string>(), closes: any[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let r: any; try { r = JSON.parse(l); } catch { continue; }
    if (r.type === "sentry") entries.push(r);
    else if (r.type === "sclose") { closedIds.add(r.id); closes.push(r); }
  }
  const open = entries.filter((e) => !closedIds.has(e.id)).sort((a, b) => b.conviction - a.conviction)
    .map((e) => ({ symbol: e.symbol, side: e.side, entry: e.entry, pUp: e.p_up, conviction: e.conviction }));
  const wins = closes.filter((c) => c.won).length;
  const realized = closes.reduce((a, c) => a + (c.pnl ?? 0), 0);
  return NextResponse.json({
    open,
    account: {
      value: Number((100 + realized).toFixed(2)), pnl: Number(realized.toFixed(2)),
      closed: closes.length, wins, winRate: closes.length ? wins / closes.length : null,
      openCount: open.length,
      recent: closes.slice(-10).reverse().map((c) => ({ symbol: c.symbol, side: c.side, won: c.won, pnl: c.pnl })),
    },
  });
}
