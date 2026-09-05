import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// Backtest Lab — the last backtest report + honest CCXT adapter gate status.
export async function GET() {
  let report: any = null, batch: any = null, optimize: any = null, experiments: any = null, forward: any = null;
  try { report = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "backtest_report.json"), "utf-8")); } catch {}
  try { batch = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "backtest_batch.json"), "utf-8")); } catch {}
  try { optimize = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "optimize_report.json"), "utf-8")); } catch {}
  try { experiments = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "experiments_report.json"), "utf-8")); } catch {}
  let perSymbol: any = null;
  try { perSymbol = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "per_symbol_report.json"), "utf-8")); } catch {}
  try { forward = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "forward_perf.json"), "utf-8")); } catch {}

  // honest CCXT adapter status from .env (never exposes key material)
  let env: Record<string, string> = {};
  try {
    const raw = await fs.readFile(path.join(ROOT, ".env"), "utf-8");
    for (const l of raw.split("\n")) {
      const t = l.trim();
      if (t && !t.startsWith("#") && t.includes("=")) { const i = t.indexOf("="); env[t.slice(0, i)] = t.slice(i + 1); }
    }
  } catch {}
  const ccxt = {
    exchange: env.CCXT_EXCHANGE || "kraken",
    dryRun: (env.CCXT_DRY_RUN ?? "true").toLowerCase() !== "false",
    configured: !!(env.CCXT_API_KEY && env.CCXT_SECRET),
    maxOrder: Number(env.CCXT_MAX_ORDER_USD ?? 5) || 5,
    dailyCap: Number(env.CCXT_DAILY_CAP_USD ?? 20) || 20,
    slippageBps: Number(env.CCXT_SLIPPAGE_BPS ?? 30) || 30,
  };
  return NextResponse.json({ report, batch, optimize, experiments, perSymbol, forward, ccxt });
}
