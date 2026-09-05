import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const ENV = path.join(process.cwd(), "..", ".env");

// Explicit live master switch. Turning ON requires typed confirmation; turning
// OFF is always allowed (safe). Only touches DRY_RUN + the kill switch.
export async function POST(request: Request) {
  let b: any; try { b = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const enable = b?.enable === true;
  if (enable && b?.confirm !== "GO LIVE") {
    return NextResponse.json({ error: "type GO LIVE to confirm" }, { status: 400 });
  }
  let raw = ""; try { raw = await fs.readFile(ENV, "utf-8"); } catch {}
  const val = enable ? "false" : "true";
  raw = /^DRY_RUN=.*$/m.test(raw) ? raw.replace(/^DRY_RUN=.*$/m, `DRY_RUN=${val}`)
                                  : raw + `\nDRY_RUN=${val}\n`;
  await fs.writeFile(ENV, raw);

  // kill switch: released when going live, re-armed when going paper (belt+suspenders)
  try {
    await execFileP("redis-cli", enable ? ["del", "system:kill"] : ["set", "system:kill", "1"], { timeout: 5000 });
  } catch {}

  return NextResponse.json({
    ok: true, dryRun: !enable,
    state: enable ? "LIVE — real orders enabled (capped)" : "DRY-RUN — paper, safe",
    warning: enable
      ? "Polymarket geoblocks Canada — orders will be refused (403) from a Canadian connection. The switch is on; the venue still decides."
      : null,
  });
}
