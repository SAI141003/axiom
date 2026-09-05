import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const run = promisify(exec);
const ROOT = path.join(process.cwd(), "..");

// SEMANTIC RECALL — query the system's accumulated knowledge by meaning
// (the obsidian-brain capability on our own stack; index built by
// signals/semantic_memory.py, refreshed each overnight loop).
// GET /api/recall?q=overconfident+model+lessons
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = (searchParams.get("q") ?? "").trim();
  if (!q) return NextResponse.json({ error: "q required" }, { status: 400 });
  try {
    const { stdout } = await run(
      `${ROOT}/.venv/bin/python ${ROOT}/signals/semantic_memory.py ${JSON.stringify(q)} 2>/dev/null`,
      { timeout: 60_000 },
    );
    const memories = stdout.trim().split("\n")
      .map((l) => l.match(/^\s*\[([\d.]+)\] \((.+?)\) (.*)$/))
      .filter(Boolean)
      .map((m) => ({ score: Number(m![1]), source: m![2], text: m![3] }));
    return NextResponse.json({ query: q, memories });
  } catch {
    return NextResponse.json({ error: "recall failed (index building?)" }, { status: 500 });
  }
}
