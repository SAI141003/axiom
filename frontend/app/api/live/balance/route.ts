import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const run = promisify(exec);
const ROOT = path.join(process.cwd(), "..");

/**
 * Live Polymarket balance — the REAL number from the CLOB collateral view
 * (signature_type=1). On-chain scanners can't see proxy L2 accounting, so we
 * ask the venue via a tiny Python one-shot. Also returns today's live spend/P&L
 * from the live_orders journal.
 */
export async function GET() {
  // ── CLOB collateral balance via authenticated Python ──────────────────────
  let balance: number | null = null, allowancesMaxed = false, err = "";
  try {
    const { stdout } = await run(
      `cd ${ROOT} && ./.venv/bin/python scripts/clob_balance.py`,
      { timeout: 45000, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout.trim().split("\n").pop() || "{}");
    if (parsed.error) err = parsed.error;
    else { balance = parsed.balance; allowancesMaxed = parsed.maxed; }
  } catch (e: any) {
    err = String(e?.message ?? e).slice(0, 200);
  }

  // ── today's live orders (journal) ─────────────────────────────────────────
  let liveToday = { sent: 0, spend: 0, filled: 0, rejected: 0, blocked: 0 };
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const { stdout } = await run(`grep '"date": "${today}"' "${ROOT}/logs/live_orders.jsonl" 2>/dev/null || true`,
                                 { maxBuffer: 8 * 1024 * 1024 });
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      try {
        const r = JSON.parse(line);
        if (r.status === "filled") { liveToday.filled++; liveToday.spend += r.usd || 0; }
        else if (r.status === "sent") { liveToday.sent++; liveToday.spend += r.usd || 0; }
        else if (r.status === "rejected" || r.status === "error") liveToday.rejected++;
        else if (r.status === "blocked") liveToday.blocked++;
      } catch {}
    }
  } catch {}

  // ── dry-run flag + config from .env ───────────────────────────────────────
  const cfg: Record<string, string> = {};
  try {
    const { stdout } = await run(`grep -E '^(DRY_RUN|LIVE_MICRO_USD|LIVE_DAILY_CAP_USD|LIVE_DAILY_PROFIT_TARGET|LIVE_STOP_LOSS_USD)=' "${ROOT}/.env" || true`);
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [k, v] = line.split("=", 2);
      cfg[k] = v;
    }
  } catch {}

  return NextResponse.json({
    balance, allowancesMaxed, err,
    dryRun: (cfg.DRY_RUN ?? "true").toLowerCase() !== "false",
    liveToday,
    config: {
      stakeUsd: parseFloat(cfg.LIVE_MICRO_USD ?? "1") || 1,
      dailyCapUsd: parseFloat(cfg.LIVE_DAILY_CAP_USD ?? "10") || 10,
      dailyProfitTarget: parseFloat(cfg.LIVE_DAILY_PROFIT_TARGET ?? "0") || 0,
      stopLossUsd: parseFloat(cfg.LIVE_STOP_LOSS_USD ?? "0") || 0,
    },
    generated: Date.now(),
  });
}
