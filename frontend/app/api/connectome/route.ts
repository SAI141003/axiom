import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";
const ROOT = path.join(process.cwd(), "..");
const execFileP = promisify(execFile);
export const dynamic = "force-dynamic";
let last = 0;
export async function GET() {
  const f = path.join(ROOT, ".data", "connectome.json");
  if (Date.now() - last > 5 * 60_000) { try { await execFileP(path.join(ROOT, ".venv", "bin", "python"), [path.join(ROOT, "signals", "connectome.py")], { cwd: ROOT, timeout: 60_000 }); last = Date.now(); } catch {} }
  try { return NextResponse.json(JSON.parse(await fs.readFile(f, "utf-8"))); } catch { return NextResponse.json({ nodes: [], edges: [], layers: [], stats: {} }); }
}
