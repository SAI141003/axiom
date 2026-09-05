import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";

const run = promisify(exec);
const ROOT = path.join(process.cwd(), "..");
const LOGS = path.join(ROOT, "logs");

/**
 * THE WORKFORCE — the system's AI agents as named employees. Each one maps to a
 * REAL running daemon (or on-demand engine); its "current task" is the latest
 * line from that daemon's own log, so you see exactly what each is doing right
 * now — no theatre, just the live work feed.
 */

type Kind = "daemon" | "swarm" | "on-demand" | "nightly";
interface Agent {
  id: string; name: string; title: string; dept: string; emoji: string;
  does: string; label?: string; log?: string; kind: Kind; file?: string;
}

const ROSTER: Agent[] = [
  { id: "kronos", name: "KRONOS", title: "Chief Orchestrator", dept: "Core", emoji: "🧠", kind: "nightly",
    does: "Reviews every trade nightly, scores each strategy vs breakeven, meta-labels signals, and rewrites the rules the others trade by.",
    file: ".data/engine_status.json" },
  { id: "atlas", name: "Atlas", title: "Execution & Arbitrage Lead", dept: "Trading", emoji: "⚙️", kind: "daemon",
    does: "Scans every Polymarket negative-risk basket for a risk-free arb and routes paper orders.",
    label: "com.polymarket.bot", log: "bot.log" },
  { id: "nova", name: "Nova", title: "Crypto Latency Trader", dept: "Trading", emoji: "⚡", kind: "daemon",
    does: "Exploits the Chainlink→CLOB reprice lag on BTC 5-minute markets, fee-aware meta-label gated.",
    label: "com.polymarket.dryrun.oraclelag", log: "oraclelag_daemon.log" },
  { id: "dex", name: "Dex", title: "Options Desk", dept: "Trading", emoji: "🎯", kind: "daemon",
    does: "Runs the equity options book — opens main legs, marks 3×/day, stops losers, takes profit at target.",
    label: "com.polymarket.dryrun.options", log: "options_daemon.log" },
  { id: "sky", name: "Sky", title: "Weather Markets Analyst", dept: "Trading", emoji: "🌡️", kind: "daemon",
    does: "Trades temperature prediction markets late-day, backing favorites where informed specialists set the price.",
    label: "com.polymarket.dryrun.weather", log: "weather_daemon.log" },
  { id: "beacon", name: "Beacon", title: "News-Lag Trader", dept: "Trading", emoji: "📰", kind: "daemon",
    does: "Reads breaking headlines and races the 30–90s window before niche markets reprice.",
    label: "com.polymarket.dryrun.newslag", log: "newslag_daemon.log" },
  { id: "vera", name: "Vera", title: "Momentum Trader", dept: "Trading", emoji: "📈", kind: "daemon",
    does: "Trades the session-VWAP trend on QQQ/TQQQ, flat by close, chop-guarded after 4 flips.",
    label: "com.polymarket.dryrun.vwap", log: "vwap_daemon.log" },
  { id: "sage", name: "Sage", title: "Price Forecaster", dept: "Research", emoji: "🔮", kind: "daemon",
    does: "Runs the Kronos foundation model hourly for ETH/BTC 1-hour forecasts; only arms on full agreement.",
    label: "com.polymarket.dryrun.kronos1h", log: "kronos1h_daemon.log" },
  { id: "scout", name: "Scout", title: "Pre-Market Scout", dept: "Research", emoji: "🛰️", kind: "daemon",
    does: "Hunts overnight stock setups — prior-day sweep + reclaim — with enforced 2R targets.",
    label: "com.polymarket.dryrun.premarket", log: "premarket_daemon.log" },
  { id: "miro", name: "Miro", title: "Deliberation Council", dept: "Research", emoji: "🐟", kind: "swarm",
    does: "72 micro-agents (24 archetypes ×3) debate any forecast in 2 rounds, then vote influence-weighted.",
    label: "com.polymarket.mirofish", log: "mirofish_server.log" },
  { id: "delphi", name: "Delphi", title: "Chief Forecaster (Oracle)", dept: "Research", emoji: "◈", kind: "on-demand",
    does: "Answers any question — outside-view base rate → simulation → swarm → extremized verdict, Brier-scored.",
    file: "logs/oracle_predictions.jsonl" },
  { id: "quill", name: "Quill", title: "Earnings Analyst", dept: "Research", emoji: "📊", kind: "on-demand",
    does: "Forecasts EPS beats and post-earnings reactions from PEAD, dispersion, revisions and implied move.",
    file: "logs/earnings_predictions.jsonl" },
  { id: "ledger", name: "Ledger", title: "Valuation Reviewer", dept: "Research", emoji: "🏦", kind: "on-demand",
    does: "Assesses if a stock is cheap or dear via DCF fair value, multiples, quality and leverage (FMP connector).",
    file: ".env" },
  { id: "taurus", name: "Taurus", title: "Bull Researcher", dept: "Research", emoji: "🐂", kind: "on-demand",
    does: "Argues the strongest possible YES case in every council debate — conviction, not balance (TradingAgents).",
    file: "logs/oracle_predictions.jsonl" },
  { id: "ursa", name: "Ursa", title: "Bear Researcher", dept: "Research", emoji: "🐻", kind: "on-demand",
    does: "Argues the strongest possible NO case — surfaces the risk everyone is ignoring (TradingAgents).",
    file: "logs/oracle_predictions.jsonl" },
  { id: "sentinel", name: "Sentinel", title: "Critic / Red-Team", dept: "Research", emoji: "🛡️", kind: "on-demand",
    does: "Reviews every council ruling for overconfidence, groupthink and blind spots — external verification, not self-correction.",
    file: "logs/council_rulings.jsonl" },
];

// Miro's 72-member council: each of the 24 persona archetypes gets a name; the
// 3 temperature-varied replicas are its "steady / balanced / bold" instances.
const COUNCIL: [string, string][] = [
  ["Ada", "Domain Expert"], ["Quinn", "Quant PM"], ["Ivo", "Insider/Specialist"],
  ["Pia", "Policy Analyst"], ["Noor", "News Reader"], ["Milo", "Momentum Chaser"],
  ["Sana", "Skeptic"], ["Rhea", "Risk Manager"], ["Remy", "Retail Crowd"],
  ["Cato", "Contrarian"], ["Hugo", "Historian"], ["Mara", "Market Maker"],
  ["Enzo", "Macro Economist"], ["Goran", "Geopolitics Analyst"], ["Wade", "Contrarian Whale"],
  ["Suki", "Sentiment Quant"], ["Vaughn", "Value Investor"], ["Odile", "Options Flow Reader"],
  ["Cruz", "Contrarian Retail"], ["Ezra", "Event Trader"], ["Stella", "Statistician"],
  ["Iris", "Insider Skeptic"], ["Mika", "Momentum Quant"], ["Rex", "Regime Analyst"],
];
const TEMPERS: [string, string][] = [["steady", "St"], ["balanced", "Ba"], ["bold", "Bo"]];

function buildCouncil() {
  const out: { name: string; role: string; temper: string }[] = [];
  for (const [name, role] of COUNCIL)
    for (const [temper, sfx] of TEMPERS) out.push({ name: `${name}·${sfx}`, role, temper });
  return out;   // 24 × 3 = 72 named micro-agents
}

async function tailLine(logFile: string): Promise<{ text: string; mtime: number } | null> {
  const p = path.join(LOGS, logFile);
  try {
    const stat = await fs.stat(p);
    const start = Math.max(0, stat.size - 8192);          // bounded tail read
    const fd = await fs.open(p, "r");
    const buf = Buffer.alloc(stat.size - start);
    await fd.read(buf, 0, buf.length, start);
    await fd.close();
    // meaningful = not blank, not a decorative separator, not startup boilerplate
    const decorative = /^[\s━│═─=+*.\-#]+$/;
    const boilerplate = /started — logging to|^\s*$/i;
    const lines = buf.toString("utf-8").split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !decorative.test(l) && !boilerplate.test(l));
    if (!lines.length) return { text: "", mtime: stat.mtimeMs };  // caller keeps the role blurb
    const last = lines[lines.length - 1];
    return { text: last.replace(/^\[[^\]]+\]\s*/, "").slice(0, 160), mtime: stat.mtimeMs };
  } catch {
    return null;
  }
}

async function fileMtime(rel: string): Promise<number | null> {
  try { return (await fs.stat(path.join(ROOT, rel))).mtimeMs; } catch { return null; }
}

export async function GET() {
  // launchd state map
  const state = new Map<string, "running" | "scheduled" | "down">();
  try {
    const { stdout } = await run("launchctl list | grep com.polymarket");
    for (const line of stdout.trim().split("\n")) {
      const [pid, exit, label] = line.split(/\s+/);
      const hasPid = pid !== "-" && pid !== "";
      state.set(label, hasPid ? "running" : (exit === "0" ? "scheduled" : "down"));
    }
  } catch { /* best-effort */ }

  const now = Date.now();
  const agents = await Promise.all(ROSTER.map(async (a) => {
    let status: "working" | "idle" | "down" | "standby" = "standby";
    let now_task = a.does;
    let lastActive: number | null = null;

    if (a.kind === "daemon" || a.kind === "swarm") {
      const s = a.label ? state.get(a.label) : undefined;
      status = s === "running" ? "working" : s === "down" ? "down" : "idle";
      const t = a.log ? await tailLine(a.log) : null;
      if (t) { if (t.text) now_task = t.text; lastActive = t.mtime; }
    } else if (a.kind === "nightly") {
      lastActive = a.file ? await fileMtime(a.file) : null;
      status = lastActive && now - lastActive < 36 * 3600e3 ? "standby" : "idle";
    } else { // on-demand
      lastActive = a.file ? await fileMtime(a.file) : null;
      status = "standby";
    }
    const idleMin = lastActive ? Math.round((now - lastActive) / 60000) : null;
    const council = a.id === "miro" ? buildCouncil() : undefined;
    return { ...a, status, now_task, lastActive, idleMin, council };
  }));

  const working = agents.filter((a) => a.status === "working").length;
  const down = agents.filter((a) => a.status === "down").length;
  return NextResponse.json({
    agents,
    summary: { total: agents.length, working, down,
               standby: agents.filter((a) => a.status === "standby" || a.status === "idle").length },
    generated: now,
  });
}
