import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { spawn } from "child_process";

export const dynamic = "force-dynamic";

const ROOT = path.join(process.cwd(), "..");
const FILE = path.join(ROOT, ".data", "client_profile.json");
const RISKS = ["conservative", "balanced", "growth", "aggressive"];

// Save the investor's plan (one per market) and run the advisor at once so
// the calls appear without waiting for its 15-minute turn.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const market = b.market === "ca" ? "ca" : "us";
  if (b.remove) {
    const cur = await read();
    await write(cur.filter((p) => p.market !== market));
    return NextResponse.json({ ok: true, removed: market });
  }
  const monthly = Number(b.monthly), years = Number(b.years);
  if (!(monthly > 0) || !(years > 0)) return NextResponse.json({ error: "monthly and years must be positive" }, { status: 400 });
  const profile = { market, monthly, years, risk: RISKS.includes(b.risk) ? b.risk : "growth",
                    style: ["simple", "diy"].includes(b.style) ? b.style : "diversified", goal: Number(b.goal) > 0 ? Number(b.goal) : undefined, saved: Date.now() };
  const list = (await read()).filter((p) => p.market !== market).concat(profile);
  await write(list);
  try {
    const py = path.join(ROOT, ".venv", "bin", "python");
    spawn(py, [path.join(ROOT, "scripts", "advisor.py")], { cwd: ROOT, detached: true, stdio: "ignore" }).unref();
  } catch {}
  return NextResponse.json({ ok: true, profiles: list });
}

async function read(): Promise<any[]> {
  try { return JSON.parse(await fs.readFile(FILE, "utf-8")).profiles ?? []; } catch { return []; }
}
async function write(profiles: any[]) {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify({ profiles }, null, 2));
}
