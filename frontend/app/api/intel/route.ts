import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import { promises as fs } from "fs";
import path from "path";
import { askLLM } from "@/lib/llm";

const run = promisify(exec);
const ROOT = path.join(process.cwd(), "..");
const JOURNAL = path.join(ROOT, "logs", "journal.jsonl");
const ANALYZE_THROTTLE_MS = 8 * 60_000;

/**
 * Intelligence Desk — live opportunities from every strategy, AI multi-angle
 * review, and a JOURNAL the system learns from: each analysis receives the
 * last lessons as context, so reviews compound instead of restarting.
 * All inputs are live: bot log, dry-run logs, learner params, Redis kill state.
 */

async function tailJsonl(file: string, lines: number): Promise<any[]> {
  try {
    const { stdout } = await run(`tail -n ${lines} "${path.join(ROOT, "logs", file)}"`,
                                 { maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim().split("\n")
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

async function gather() {
  // opportunities — every angle, live
  const opportunities: { source: string; label: string; detail: string; ts?: number }[] = [];

  try {   // NegRisk from the live bot scanner
    const { stdout } = await run(
      `grep "NegRisk Dutch Book:" "${path.join(ROOT, "logs", "bot.log")}" | tail -6`);
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const m = line.match(/NegRisk Dutch Book: (.+?) \| (\w+) edge=([+\-0-9.%]+) legs=(\d+)/);
      if (m) opportunities.push({ source: "negrisk", label: m[1].trim().slice(0, 40),
                                  detail: `${m[2]} edge ${m[3]} (${m[4]} legs)` });
    }
  } catch {}

  for (const sn of await tailJsonl("dryrun_weather.jsonl", 60)) {   // weather edges
    if (sn.type === "snapshot" && (sn.best_edge ?? 0) > 0.08) {
      opportunities.push({ source: "weather", label: `${sn.city} (${sn.obs_source ?? "grid"})`,
                           detail: `edge ${(sn.best_edge * 100).toFixed(0)}% · obs ${sn.observed_max}°${sn.unit}`,
                           ts: sn.ts });
    }
  }
  for (const r of await tailJsonl("dryrun_premarket.jsonl", 12)) {   // premarket picks
    if (r.type === "pick") opportunities.push({ source: "premarket",
      label: `${r.symbol} ${r.direction}`, detail: `score ${r.score} gap ${r.gap_pct}%`, ts: r.ts });
  }

  // risk snapshot — live
  const crypto = await tailJsonl("dryrun_5m.jsonl", 1500);
  const resolved = crypto.filter((r) => r.type === "resolve" && r.won != null);
  const cryptoPnl = +resolved.reduce((a, r) => a + (r.pnl ?? 0), 0).toFixed(2);
  const optPos = (await tailJsonl("dryrun_options.jsonl", 200)).filter((r) => r.type === "position");
  let killActive = false;
  try { killActive = (await run(`redis-cli exists system:kill`)).stdout.trim() === "1"; } catch {}
  let learner: any = null;
  try { learner = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "params_crypto.json"), "utf-8")).params; } catch {}

  const risk = {
    killSwitch: killActive,
    cryptoRecentPnl: cryptoPnl,
    cryptoRecentTrades: resolved.filter((r) => r.pnl != null).length,
    optionsDeployed: +optPos.reduce((a, p) => a + p.cost, 0).toFixed(0),
    optionsPositions: optPos.length,
    learnerConfig: learner,
  };

  // journal (the memory it learns from)
  let journal: any[] = [];
  try {
    const raw = await fs.readFile(JOURNAL, "utf-8");
    journal = raw.trim().split("\n").map((l) => JSON.parse(l)).slice(-12).reverse();
  } catch {}

  return { opportunities: opportunities.slice(-24).reverse(), risk, journal };
}

export async function GET() {
  return NextResponse.json({ ...(await gather()), generated: Date.now() });
}

export async function POST() {
  const state = await gather();
  const last = state.journal[0];
  if (last && Date.now() - last.ts < ANALYZE_THROTTLE_MS) {
    return NextResponse.json({ ...state, throttled: true, generated: Date.now() });
  }

  const lessons = state.journal.slice(0, 5).map((j: any) =>
    `- [${new Date(j.ts).toISOString().slice(5, 16)}] ${j.lesson ?? j.action ?? ""}`).join("\n");

  const raw = await askLLM(
    "You are the desk's intelligence officer. Sharp, numeric, no fluff. " +
    "Respond with EXACTLY these sections: ===OPPORTUNITY===, ===RISK===, ===ACTION===, ===LESSON=== " +
    "(LESSON = one sentence worth remembering tomorrow, building on prior lessons, never repeating them).",
    `LIVE DESK STATE ${new Date().toISOString()}
Opportunities (live): ${JSON.stringify(state.opportunities.slice(0, 14))}
Risk snapshot: ${JSON.stringify(state.risk)}
PRIOR LESSONS (do not repeat — build on them):
${lessons || "- none yet"}

Analyze from every angle: (1) best opportunity right now and why, (2) biggest risk in the current book, (3) the single concrete action for the next hour, (4) the lesson.`,
    700,
  );

  const grab = (k: string) =>
    raw.match(new RegExp(`===${k}===\\s*([\\s\\S]*?)(?====|$)`))?.[1]?.trim() ?? "";
  const entry = {
    ts: Date.now(),
    opportunity: grab("OPPORTUNITY"),
    risk: grab("RISK"),
    action: grab("ACTION"),
    lesson: grab("LESSON"),
    inputs: { opps: state.opportunities.length, cryptoPnl: state.risk.cryptoRecentPnl },
  };
  await fs.appendFile(JOURNAL, JSON.stringify(entry) + "\n");

  return NextResponse.json({ ...state, journal: [entry, ...state.journal].slice(0, 12), generated: Date.now() });
}
