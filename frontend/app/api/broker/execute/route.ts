import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileP = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

// Route a brain signal to the Questrade adapter (paper unless BROKER_DRY_RUN=false).
export async function POST(request: Request) {
  let b: any; try { b = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  const sym = String(b.symbol ?? "").toUpperCase();
  const dir = b.direction === "DOWN" ? "DOWN" : "UP";
  const conv = String(Math.max(0, Math.min(1, Number(b.conviction) || 0)));
  const inst = b.instrument === "option" ? "option" : "equity";
  if (!/^[A-Z]{1,5}$/.test(sym)) return NextResponse.json({ error: "valid ticker required" }, { status: 400 });
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "execution", "broker_adapter.py"), "signal", sym, dir, conv, inst],
      { cwd: ROOT, timeout: 25_000 });
    return NextResponse.json(JSON.parse(stdout));
  } catch {
    return NextResponse.json({ status: "error", detail: "adapter unreachable" }, { status: 502 });
  }
}
