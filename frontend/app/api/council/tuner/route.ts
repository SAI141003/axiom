import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// The council's autonomous auto-tuner: the knobs it currently owns + its recent
// self-fix decisions (each backtested on real data, both-halves-stable). Live.
export async function GET() {
  let params: any = {};
  let audit: any[] = [];
  try { params = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "tuned_params.json"), "utf-8")); } catch {}
  try {
    const raw = await fs.readFile(path.join(ROOT, ".data", "tuner_audit.jsonl"), "utf-8");
    audit = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(-12).reverse();
  } catch {}
  const knobs: any[] = [];
  for (const [strat, ks] of Object.entries(params)) {
    if (strat.startsWith("_")) continue;
    for (const [knob, v] of Object.entries(ks as any)) {
      knobs.push({ strategy: strat, knob, ...(v as any) });
    }
  }
  return NextResponse.json({ updated: params._updated ?? null, knobs, audit });
}
