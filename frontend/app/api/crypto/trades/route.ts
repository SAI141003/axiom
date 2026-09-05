import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// SINGLE SOURCE OF TRUTH: the ORACLE-LAG daemon's paper-trade log.
// The old dryrun_5m momentum bot was retired — its signal was pure noise on an
// efficient market (49% coin-flip, armed trades 39% last-7d, net negative before
// fees; no entry slice had edge). Oracle-lag (dryrun/btc_oraclelag_daemon.py)
// exploits the real Chainlink→CLOB reprice lag and is fee-true 65% gated.
const DAEMON_LOG = path.join(process.cwd(), "..", "logs", "dryrun_oraclelag.jsonl");

export interface PaperTrade {
  id: string;
  asset: string;
  windowStart: number;
  windowEnd: number;
  side: "UP" | "DOWN";
  entryPrice: number;
  stake: number;
  signal: string;
  spotAtEntry: number;
  status: "open" | "won" | "lost" | "void";
  pnl?: number;
  ts: number;
  traded: boolean;         // true = armed (passed the fee-aware meta-label gate)
  gated: boolean;          // true = also passes the CURRENT config gate (ask<=.65 & p_win>breakeven)
}

const STAKE = 10;

// Read the LIVE gate the auto-tuner deployed so this page's stats MATCH the
// dashboard banner exactly (was hardcoded ask≤0.65 → drifted from the banner).
async function liveGate(): Promise<{ min: number; max: number }> {
  try {
    const p = JSON.parse(await fs.readFile(path.join(process.cwd(), "..", ".data", "tuned_params.json"), "utf-8"));
    return { min: p?.oraclelag?.MIN_ENTRY?.value ?? 0.55, max: p?.oraclelag?.MAX_ENTRY?.value ?? 0.64 };
  } catch {
    return { min: 0.55, max: 0.64 };
  }
}

// The exact deployed gate: armed UP trade, inside the tuned ask band, in a QUIET
// window (news breaks the latency edge). Matches btc_oraclelag_daemon + brain.
function passesGate(e: Record<string, unknown>, ask: number, g: { min: number; max: number }): boolean {
  const news = Number(e.news_10m ?? 0) || 0;
  return Boolean(e.traded) && (e.side as string) === "UP"
    && ask >= g.min && ask <= g.max && news === 0;
}

async function readDaemonTrades(): Promise<PaperTrade[]> {
  let raw: string;
  try {
    raw = await fs.readFile(DAEMON_LOG, "utf-8");
  } catch {
    return [];
  }
  const g = await liveGate();

  const entries = new Map<number, Record<string, unknown>>();       // win → entry
  const resolves = new Map<number, Record<string, unknown>>();      // win → resolve
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(line); } catch { continue; }
    if (r.type === "olentry" && typeof r.win === "number") entries.set(r.win, r);
    else if (r.type === "olresolve" && typeof r.win === "number") resolves.set(r.win, r);
  }

  const trades: PaperTrade[] = [];
  for (const [win, e] of Array.from(entries)) {
    const side = ((e.side as string) === "UP" ? "UP" : "DOWN") as "UP" | "DOWN";
    const entryPrice = Number(e.ask);
    if (!(entryPrice > 0.01 && entryPrice < 1)) continue;     // skip un-priced windows
    const ts = Number(e.ts);
    const r = resolves.get(win);
    let status: PaperTrade["status"] = "open";
    let pnl: number | undefined;
    if (r) {
      const won = r.won === true;
      status = won ? "won" : "lost";
      pnl = typeof r.pnl === "number" ? r.pnl : (won ? STAKE * (1 / entryPrice - 1) : -STAKE);
    }
    const exch = (e.exch ?? {}) as Record<string, unknown>;
    trades.push({
      id: String(win),
      asset: "BTC",
      windowStart: ts,
      windowEnd: win,
      side,
      entryPrice,
      stake: STAKE,
      signal: `move=${e.move_bp}bp cl_lag=${e.cl_lag_bp}bp exch=${exch.consensus_bp ?? "?"}bp p_win=${e.p_win}`,
      spotAtEntry: Number(e.w_open),
      status,
      pnl,
      ts,
      traded: Boolean(e.traded),
      gated: passesGate(e, entryPrice, g),
    });
  }
  trades.sort((a, b) => a.ts - b.ts);
  return trades;
}

export async function GET() {
  const trades = await readDaemonTrades();
  // stats reflect the CURRENT-config gate so the page matches the LIVE ENGINE banner
  const gated = trades.filter((t) => t.gated);
  const resolved = gated.filter((t) => t.status === "won" || t.status === "lost");
  const wins = resolved.filter((t) => t.status === "won").length;
  const totalPnl = resolved.reduce((a, t) => a + (t.pnl ?? 0), 0);

  return NextResponse.json({
    trades: trades.slice(-200),
    stats: {
      total: trades.length,
      resolved: resolved.length,
      open: trades.filter((t) => t.status === "open").length,
      wins,
      winRate: resolved.length > 0 ? wins / resolved.length : 0,
      totalPnl: +totalPnl.toFixed(2),
    },
  });
}
