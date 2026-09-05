import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";

const run = promisify(exec);
const ROOT = path.join(process.cwd(), "..");

/**
 * Agent Brain feed — REAL state only:
 *   - bot workers: live heartbeats from Redis (health:* keys)
 *   - dry-run daemons: live process checks
 *   - events: actual trades/picks/plays from the dry-run logs
 *   - suggestions: actual NegRisk opportunities from the bot log
 */

async function tailJsonl(file: string, n: number): Promise<any[]> {
  try {
    const { stdout } = await run(
      `tail -n ${n * 3} "${path.join(ROOT, "logs", file)}"`,
      { maxBuffer: 16 * 1024 * 1024 },   // jsonl tails can exceed exec's 1MB default
    );
    return stdout.trim().split("\n").map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).slice(-n * 3);
  } catch {
    return [];
  }
}

export async function GET() {
  // ── bot workers from Redis heartbeats ──────────────────────────────────────
  const agents: { id: string; label: string; group: string; alive: boolean; ageS: number | null }[] = [];
  try {
    const { stdout } = await run(`redis-cli --scan --pattern 'health:*' | head -20`);
    const names = stdout.trim().split("\n").filter(Boolean);
    const now = Date.now() / 1000;
    for (const key of names) {
      const { stdout: v } = await run(`redis-cli get "${key}"`);
      const ts = parseFloat(v.trim());
      const name = key.replace("health:", "");
      const group =
        name === "ingestion" ? "data"
        : ["signal", "quant_calibration"].includes(name) ? "signal"
        : ["execution", "paper"].includes(name) ? "execution"
        : name === "risk" ? "risk" : "signal";
      agents.push({
        id: name, label: name.replace("_", " "), group,
        alive: isFinite(ts) && now - ts < 45,
        ageS: isFinite(ts) ? Math.round(now - ts) : null,
      });
    }
  } catch { /* redis down → agents list empty, UI shows it */ }

  // ── dry-run strategy daemons (live process check) ──────────────────────────
  for (const [proc, id, label] of [
    ["crypto_daemon", "crypto", "crypto 5-min"],
    ["weather_daemon", "weather", "weather edge"],
    ["premarket_daemon", "premarket", "pre-market"],
  ] as const) {
    let alive = false;
    try { alive = (await run(`pgrep -f dryrun/${proc} | head -1`)).stdout.trim().length > 0; } catch {}
    agents.push({ id, label, group: "strategy", alive, ageS: null });
  }

  // ── real events: trades, plays, picks, suggestions ─────────────────────────
  const events: { id: string; kind: string; strategy: string; label: string;
                  side?: string; pnl?: number | null; ts: number }[] = [];

  for (const r of await tailJsonl("dryrun_5m.jsonl", 10)) {
    if (r.type === "resolve" && r.won != null) {
      events.push({ id: `c-${r.id}`, kind: "trade", strategy: "crypto",
                    label: r.id.split("-")[0].toUpperCase(),
                    side: r.up_won ? "UP" : "DOWN", pnl: r.pnl, ts: 0 });
    } else if (r.type === "entry" && r.traded) {
      events.push({ id: `co-${r.id}`, kind: "open", strategy: "crypto",
                    label: `${r.asset.toUpperCase()} ${r.side}`, pnl: null, ts: r.ts });
    }
  }
  for (const r of await tailJsonl("dryrun_weather.jsonl", 8)) {
    if (r.type === "snapshot" && (r.best_edge ?? 0) > 0.08) {
      events.push({ id: `w-${r.slug}-${r.ts}`, kind: "suggestion", strategy: "weather",
                    label: `${r.city} ${(r.best_edge * 100).toFixed(0)}%`, pnl: null, ts: r.ts });
    }
  }
  for (const r of await tailJsonl("dryrun_premarket.jsonl", 6)) {
    if (r.type === "outcome") {
      events.push({ id: `p-${r.date}-${r.symbol}`, kind: "trade", strategy: "premarket",
                    label: r.symbol, pnl: r.pnl, ts: r.ts });
    } else if (r.type === "pick") {
      events.push({ id: `pp-${r.date}-${r.symbol}`, kind: "suggestion", strategy: "premarket",
                    label: `${r.symbol} ${r.direction}`, pnl: null, ts: r.ts });
    }
  }
  // NegRisk suggestions straight from the live bot log
  try {
    const { stdout } = await run(
      `grep "NegRisk Dutch Book:" "${path.join(ROOT, "logs", "bot.log")}" | tail -5`);
    stdout.trim().split("\n").filter(Boolean).forEach((line, i) => {
      const m = line.match(/NegRisk Dutch Book: (.+?) \| (\w+) edge=([+\-0-9.%]+)/);
      if (m) events.push({ id: `n-${i}-${m[1].slice(0, 12)}`, kind: "suggestion", strategy: "negrisk",
                           label: `${m[1].trim().slice(0, 22)} ${m[3]}`, pnl: null, ts: 0 });
    });
  } catch {}

  // ── headline stats (real) ───────────────────────────────────────────────────
  let stats: Record<string, number> = {};
  try {
    const rows = await tailJsonl("dryrun_5m.jsonl", 4000);
    const resolved = rows.filter((r) => r.type === "resolve" && r.won != null);
    stats = {
      cryptoTrades: resolved.length,
      cryptoPnl: +resolved.reduce((a, r) => a + (r.pnl ?? 0), 0).toFixed(2),
      cryptoWins: resolved.filter((r) => r.won).length,
    };
  } catch {}

  return NextResponse.json({ agents, events: events.slice(-40), stats, generated: Date.now() });
}
