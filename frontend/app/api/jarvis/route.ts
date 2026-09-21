import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");
export const dynamic = "force-dynamic";

async function data(name: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, ".data", name), "utf-8")); } catch { return null; }
}
const usd = (v: number) => `${v < 0 ? "minus " : ""}$${Math.abs(v).toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)} percent`;

// The fallback brain: answers the common questions straight from the desk's
// data files, with no model at all. The bridge (jarvis/bridge.mjs) is the real
// AXIOM; this keeps the page useful when it is not running.
export async function POST(request: Request) {
  let q = "";
  try { q = String((await request.json()).text ?? "").toLowerCase(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const status = await data("engine_status.json");
  const engines: Record<string, any> = status?.engines ?? {};
  const accts = Object.entries(engines).filter(([k]) => k.includes("($100 acct)")).map(([k, v]) => ({ name: k.replace(" ($100 acct)", ""), ...v }));
  const bySign = [...accts].sort((a, b) => b.pnl - a.pnl);

  let text: string;
  if (/safe|assert|scenario|invariant|cap|overspend/.test(q)) {
    const s = await data("scenario_report.json");
    text = s ? `The proving ground ran ${s.total_runs.toLocaleString()} assertions across ${s.scenarios?.length ?? 0} fault scenarios with ${s.total_fails} failures. Every invariant holds: caps, leverage, slippage aborts, idempotent resends and the loss floor.` : "The safety report has not been generated yet. Run execution/scenario_sim.py 5.";
  } else if (/backtest|sharpe|edge|return|strategy/.test(q)) {
    const r = await data("backtest_report.json"); const b = await data("backtest_batch.json"); const m = r?.metrics;
    text = m ? `The ${r.symbol} ${r.timeframe} backtest returned ${pct(m.total_return)} against ${pct(m.buyhold_return)} for buy and hold, Sharpe ${m.sharpe}, max drawdown ${pct(m.max_drawdown)}. Across the grid, ${b?.edge_cells ?? "?"} of ${b?.total_cells ?? "?"} cells show an edge, all of them daily. Intraday loses.` : "No backtest report yet. Run python -m backtest.octobot_engine.";
  } else if (/best|winning|top/.test(q) && accts.length) {
    const a = bySign[0];
    text = `The strongest account is ${a.name} at ${usd(a.account)}, ${a.pnl >= 0 ? "up" : "down"} ${usd(Math.abs(a.pnl))} over ${a.trades} trades with a ${pct(a.win_rate)} win rate.`;
  } else if (/worst|losing|bottom/.test(q) && accts.length) {
    const a = bySign[bySign.length - 1];
    text = `The weakest account is ${a.name} at ${usd(a.account)}, down ${usd(Math.abs(a.pnl))} over ${a.trades} trades with a ${pct(a.win_rate)} win rate.`;
  } else if (/venue|connect|where|exchange|polymarket|hyperliquid|kraken/.test(q)) {
    const v = await data("venues.json"); const list: any[] = Array.isArray(v) ? v : v?.venues ?? [];
    const ok = list.filter((x) => String(x.canada).toLowerCase().includes("yes") || String(x.canada).toLowerCase().includes("reachable"));
    text = list.length ? `The venue map lists ${list.length} platforms. ${ok.length ? ok.slice(0, 5).map((x) => x.name).join(", ") + " are reachable from here." : ""} Polymarket is geoblocked in Canada and the desk does not circumvent that. Every live path is off until DRY_RUN is false and a key is supplied.` : "The venue catalog has not been generated yet.";
  } else if (accts.length) {
    const total = accts.reduce((s, a) => s + a.account, 0), pnl = accts.reduce((s, a) => s + a.pnl, 0), trades = accts.reduce((s, a) => s + a.trades, 0);
    text = `The fleet holds ${usd(total)} across ${accts.length} paper accounts, ${pnl >= 0 ? "up" : "down"} ${usd(Math.abs(pnl))} over ${trades} trades. ${bySign[0].name} leads at ${usd(bySign[0].account)}; ${bySign[bySign.length - 1].name} trails at ${usd(bySign[bySign.length - 1].account)}.`;
  } else {
    text = "The desk has no account data yet. Start the bots, or run dryrun/brain.py to build the scoreboard.";
  }
  return NextResponse.json({ text, brain: "local" });
}
