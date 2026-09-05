import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileP = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");

// Canada-legal execution adapter (Questrade) status — honest connection state.
export async function GET() {
  try {
    const { stdout } = await execFileP(
      path.join(ROOT, ".venv", "bin", "python"),
      [path.join(ROOT, "execution", "broker_adapter.py")],
      { cwd: ROOT, timeout: 20_000 });
    return NextResponse.json(JSON.parse(stdout));
  } catch {
    return NextResponse.json({ broker: "questrade", configured: false, state: "adapter unreachable" });
  }
}
