import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ENV = path.join(process.cwd(), "..", ".env");

// Whitelisted, bounded live-trading knobs. DRY_RUN is deliberately NOT here.
const KNOBS: Record<string, { min: number; max: number }> = {
  LIVE_MICRO_USD:           { min: 0,  max: 5 },     // per-trade stake (hard code ceiling $5 too)
  LIVE_DAILY_CAP_USD:       { min: 1,  max: 50 },    // max spent per day
  LIVE_DAILY_PROFIT_TARGET: { min: 0,  max: 500 },   // stop trading after +$X (0 = off)
  LIVE_STOP_LOSS_USD:       { min: 0,  max: 100 },   // stop trading after −$X (0 = off)
};

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  let raw = "";
  try { raw = await fs.readFile(ENV, "utf-8"); } catch {}

  const applied: Record<string, number> = {};
  for (const [name, lim] of Object.entries(KNOBS)) {
    if (body[name] === undefined) continue;
    const v = Math.max(lim.min, Math.min(lim.max, parseFloat(String(body[name])) || 0));
    const line = `${name}=${v}`;
    const re = new RegExp(`^${name}=.*$`, "m");
    raw = re.test(raw) ? raw.replace(re, line) : raw + (raw.endsWith("\n") ? "" : "\n") + line + "\n";
    applied[name] = v;
  }
  await fs.writeFile(ENV, raw);
  return NextResponse.json({ ok: true, applied,
    note: "Applied immediately — live_micro reads .env on every trade decision." });
}
