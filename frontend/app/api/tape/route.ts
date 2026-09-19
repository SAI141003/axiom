import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");
export const dynamic = "force-dynamic";

async function lines(rel: string, max: number): Promise<any[]> {
  try {
    const raw = await fs.readFile(path.join(ROOT, "logs", rel), "utf-8");
    const out: any[] = [];
    for (const l of raw.split("\n").slice(-max)) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out;
  } catch { return []; }
}

// Frames are what the flow bot saw each cycle; events are what it did.
export async function GET() {
  const [frames, events] = await Promise.all([lines("flow_tape.jsonl", 6000), lines("flow_bot.jsonl", 2000)]);
  const symbols = Array.from(new Set(frames.map((f) => f.sym))).sort();
  return NextResponse.json({
    symbols, frames,
    events: events.filter((e) => e.type === "fentry" || e.type === "fclose").map((e) => ({
      type: e.type, sym: e.sym, ts: e.ts, price: e.type === "fentry" ? e.entry : e.exit, pnl: e.pnl, reason: e.reason, bias: e.bias,
    })),
    thresholds: { enter: 0.25, exit: -0.1 },
  });
}
