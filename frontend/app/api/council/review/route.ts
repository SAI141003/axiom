import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { askLLM } from "../../../../lib/llm";

const execFileP = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

/**
 * END-OF-DAY REVIEW — the council convenes over the day's REAL losses.
 * loss_review.py pulls every strategy's losing trades; then a domain analyst
 * (LLM) explains WHY each bled, names the gap, and gives one concrete fix.
 * KRONOS closes with the overall read. Grounded entirely in real numbers.
 */

const ANALYST: Record<string, string> = {
  options: "Dex, the Options Desk lead",
  oraclelag: "Nova, the Crypto Latency Trader",
  crypto: "Nova, the Crypto Latency Trader",
  weather: "Sky, the Weather Markets Analyst",
  premarket: "Scout, the Pre-Market Scout",
  vwap: "Vera, the Momentum Trader",
  "news-lag": "Beacon, the News-Lag Trader",
  kronos1h: "Sage, the Price Forecaster",
};

async function reviewData(): Promise<any> {
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "signals", "loss_review.py")],
      { cwd: ROOT, timeout: 40_000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function parseJSON(s: string): any {
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function GET() {
  const data = await reviewData();
  if (!data) return NextResponse.json({ error: "loss review unavailable" }, { status: 503 });
  if (!data.strategies?.length) {
    return NextResponse.json({ date: data.date, totalLoss: 0, verdicts: [],
      chair: "No losing trades resolved today — nothing to autopsy. Clean session.", generated: Date.now() });
  }

  // Each bleeder → its analyst explains why + the gap + one fix (parallel).
  const verdicts = await Promise.all(data.strategies.slice(0, 6).map(async (s: any) => {
    const who = ANALYST[s.strategy] ?? "the desk analyst";
    const worst = (s.worst ?? []).map((w: any) =>
      `pnl ${w.pnl}, entry ${w.entry ?? "?"}, ${w.side ?? ""} ${w.asset ?? ""}`).join("; ");
    const raw = await askLLM(
      `You are ${who}. Be blunt and specific — a trader's post-mortem, no hedging.`,
      `Your strategy "${s.strategy}" today: ${s.losses} losses of ${s.trades} trades ` +
      `(${(s.win_rate * 100).toFixed(0)}% win), gross loss $${s.gross_loss}, net $${s.net_pnl}. ` +
      `${s.pattern_hint ? "Pattern: " + s.pattern_hint + ". " : ""}Worst: ${worst}.\n` +
      `Reply ONLY as JSON: {"root_cause":"why it bled, one sentence","gap":"the specific weakness","recommendation":"one concrete change to make tomorrow"}`,
      280).catch(() => "");
    const v = parseJSON(raw) ?? {};
    return {
      strategy: s.strategy, losses: s.losses, trades: s.trades,
      winRate: s.win_rate, grossLoss: s.gross_loss, netPnl: s.net_pnl,
      patternHint: s.pattern_hint,
      rootCause: String(v.root_cause ?? "—").slice(0, 240),
      gap: String(v.gap ?? "—").slice(0, 200),
      recommendation: String(v.recommendation ?? "—").slice(0, 240),
    };
  }));

  const chair = await askLLM(
    `You are KRONOS, chair of the council, closing the trading day. 2-3 crisp sentences: the day's biggest leak, the common thread across strategies, and the single highest-priority fix. No preamble.`,
    `Date ${data.date}. Total gross loss $${data.total_gross_loss} across ${data.strategies_with_losses} strategies.\n` +
    verdicts.map((v) => `- ${v.strategy}: $${v.grossLoss} — ${v.rootCause}`).join("\n"),
    300).catch(() => "");

  const worst = verdicts[0];
  const fallbackChair = worst
    ? `Biggest leak today was ${worst.strategy} at $${worst.grossLoss} — ${worst.rootCause} `
      + `Total $${data.total_gross_loss} across ${data.strategies_with_losses} strategies. `
      + `Priority fix: ${worst.recommendation}`
    : "Review complete.";

  return NextResponse.json({
    date: data.date, totalLoss: data.total_gross_loss,
    strategiesWithLosses: data.strategies_with_losses,
    verdicts, chair: chair.trim() || fallbackChair, generated: Date.now(),
  });
}
