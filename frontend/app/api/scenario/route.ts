import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { promises as fs } from "fs";

const execFileP = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

// Company Scenario engine — quantum-inspired, REAL market data. Runs the live
// Python engine (superposition MC → interference → measurement) and returns its
// forecast. Also exposes the self-scored track record. Nothing mocked.
export async function POST(request: Request) {
  let body: { symbol?: string; horizon?: number };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const sym = (body.symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z]{1,5}$/.test(sym)) return NextResponse.json({ error: "valid ticker required" }, { status: 400 });
  const hz = String(Math.max(2, Math.min(120, Number(body.horizon) || 21)));
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "signals", "scenario_engine.py"), sym, hz],
      { cwd: ROOT, timeout: 30_000 });
    return NextResponse.json(JSON.parse(stdout));
  } catch {
    return NextResponse.json({ error: `could not fetch live data for ${sym}` }, { status: 502 });
  }
}

export async function GET() {
  // the self-scored track record (real Brier vs reality)
  try {
    const card = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "scenario_scorecard.json"), "utf-8"));
    return NextResponse.json(card);
  } catch {
    return NextResponse.json({ resolved: 0, verdict: "building record" });
  }
}
