import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

// Serves the LAST auto-run of the end-of-day loop (real data written by
// dryrun/eod_council.py) plus the open actions and their observed outcomes.
// No computation, no fabrication — just the saved real report. Empty until the
// loop has run at least once.
const ROOT = path.join(process.cwd(), "..");

async function read(rel: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, rel), "utf-8")); }
  catch { return null; }
}

export async function GET() {
  const [review, actions, loop] = await Promise.all([
    read(".data/eod_review.json"),
    read(".data/eod_actions.json"),
    read(".data/eod_loop.jsonl").catch(() => null),
  ]);
  // loop file is jsonl; read last line for the latest run meta
  let lastRun: any = null;
  try {
    const raw = await fs.readFile(path.join(ROOT, ".data", "eod_loop.jsonl"), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    if (lines.length) lastRun = JSON.parse(lines[lines.length - 1]);
  } catch { /* none yet */ }

  return NextResponse.json({
    review: review ?? null,
    actions: actions?.open ?? [],
    lastRun,
    hasRun: !!review,
  });
}
