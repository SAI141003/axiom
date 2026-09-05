import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

async function readEnv(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(ROOT, ".env"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#") && t.includes("=")) {
        const i = t.indexOf("=");
        out[t.slice(0, i)] = t.slice(i + 1);
      }
    }
    return out;
  } catch { return {}; }
}

async function todaySpend(logFile: string, field: string): Promise<number> {
  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", logFile), "utf-8"); } catch { return 0; }
  const today = new Date().toISOString().slice(0, 10);
  let s = 0;
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (r.date === today && (r.outcome === "filled" || r.outcome === "partial")) s += Math.abs(r[field] ?? 0);
    } catch {}
  }
  return Math.round(s * 100) / 100;
}

// Proving Ground — the scenario-sim report + honest adapter status (dry-run,
// caps, whether a key is configured). Never exposes key material.
export async function GET() {
  const env = await readEnv();
  let report: any = null;
  try { report = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "scenario_report.json"), "utf-8")); } catch {}

  const num = (k: string, d: number) => Number(env[k] ?? d) || d;
  const adapters = [
    {
      venue: "Hyperliquid (perps)", custody: "non-custodial · agent key trades, can't withdraw",
      dryRun: (env.HL_DRY_RUN ?? "true").toLowerCase() !== "false",
      configured: !!(env.HL_API_WALLET_KEY && env.HL_API_WALLET_KEY.length > 0),
      maxOrder: num("HL_MAX_ORDER_USD", 5), dailyCap: num("HL_DAILY_CAP_USD", 20),
      maxLeverage: num("HL_MAX_LEVERAGE", 3), slippageBps: num("HL_SLIPPAGE_BPS", 50),
      todayCommitted: await todaySpend("hl_orders.jsonl", "margin"),
    },
    {
      venue: "Solana / Jupiter (meme spot)", custody: "non-custodial · you sign, funds stay in wallet",
      dryRun: (env.SOL_DRY_RUN ?? "true").toLowerCase() !== "false",
      configured: !!(env.SOL_WALLET_KEY && env.SOL_WALLET_KEY.length > 0),
      maxOrder: num("SOL_MAX_ORDER_USD", 5), dailyCap: num("SOL_DAILY_CAP_USD", 20),
      maxLeverage: null, slippageBps: num("SOL_SLIPPAGE_BPS", 150),
      todayCommitted: await todaySpend("sol_orders.jsonl", "size"),
    },
  ];
  return NextResponse.json({ report, adapters });
}
