import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";

const run = promisify(exec);

// Whitelisted launchd services the UI may restart (local single-user tool)
const SERVICES: Record<string, string> = {
  bot: "com.polymarket.bot",
  weather: "com.polymarket.dryrun.weather",
  crypto: "com.polymarket.dryrun.crypto",
  premarket: "com.polymarket.dryrun.premarket",
};

export async function POST(request: Request) {
  let body: { service?: string };
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const label = SERVICES[body.service ?? ""];
  if (!label) return NextResponse.json({ error: "unknown service" }, { status: 400 });

  try {
    const { stdout } = await run(`id -u`);
    await run(`launchctl kickstart -k gui/${stdout.trim()}/${label}`);
    return NextResponse.json({ ok: true, restarted: label });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
