import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

export const dynamic = "force-dynamic";
const run = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

// The Jev shadow judge's report card: every frozen typed judgment that has an
// outcome, Brier-scored against the base rate. Nothing here is a prediction
// of the future; it is the record of predictions already made.
export async function GET() {
  try {
    const { stdout } = await run(path.join(ROOT, ".venv", "bin", "python"), [path.join(ROOT, "signals", "jev.py")], { cwd: ROOT, timeout: 20_000 });
    return NextResponse.json({ generated: Date.now(), ...JSON.parse(stdout) });
  } catch (e: any) { return NextResponse.json({ error: String(e?.message ?? e).slice(0, 200) }, { status: 500 }); }
}
