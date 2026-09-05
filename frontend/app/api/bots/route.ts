import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ENV = path.join(process.cwd(), "..", ".env");
const BOTS = [
  { key: "BOT_CRYPTO_ENABLED",    name: "Crypto 5-min",   desc: "BTC-only momentum (others disabled, were losers)" },
  { key: "BOT_ORACLELAG_ENABLED", name: "BTC Oracle-Lag", desc: "first-minute move edge (backtest +9.5σ, Binance leads Chainlink)" },
  { key: "BOT_WEATHER_ENABLED",   name: "Weather",        desc: "temperature-bucket station-edge trades" },
  { key: "BOT_KRONOS1H_ENABLED",  name: "Kronos 1-hour",  desc: "hourly BTC/ETH forecast (foundation model)" },
  { key: "BOT_PREMARKET_ENABLED", name: "Pre-Market",     desc: "under-$10 first-20-min stock picks" },
  { key: "BOT_OPTIONS_ENABLED",   name: "Options",        desc: "daily options paper positions" },
];

async function read() {
  try { return await fs.readFile(ENV, "utf-8"); } catch { return ""; }
}

export async function GET() {
  const raw = await read();
  const bots = BOTS.map((b) => {
    const m = raw.match(new RegExp(`^${b.key}=(.*)$`, "m"));
    return { ...b, enabled: m ? m[1].toLowerCase() !== "false" : true };
  });
  return NextResponse.json({ bots });
}

export async function POST(request: Request) {
  let body: { key?: string; enabled?: boolean };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!BOTS.find((b) => b.key === body.key)) return NextResponse.json({ error: "unknown bot" }, { status: 400 });
  let raw = await read();
  const line = `${body.key}=${body.enabled ? "true" : "false"}`;
  const re = new RegExp(`^${body.key}=.*$`, "m");
  raw = re.test(raw) ? raw.replace(re, line) : raw + (raw.endsWith("\n") ? "" : "\n") + line + "\n";
  await fs.writeFile(ENV, raw);
  return NextResponse.json({ ok: true, note: "Applied on the next trade cycle (≤5 min)." });
}
