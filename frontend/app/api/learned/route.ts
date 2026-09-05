import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// Serves the self-learner's parameter files (dryrun/learner.py, nightly)
// with their evidence trails — the UI shows WHAT was learned and WHY.
export async function GET() {
  const dir = path.join(process.cwd(), "..", ".data");
  const out: Record<string, unknown> = {};
  for (const name of ["crypto", "weather", "premarket"]) {
    try {
      out[name] = JSON.parse(await fs.readFile(path.join(dir, `params_${name}.json`), "utf-8"));
    } catch {
      out[name] = null;
    }
  }
  return NextResponse.json(out);
}
