import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const ROOT = path.join(process.cwd(), "..");
const SPECS = path.join(ROOT, ".data", "bots");
const PY = path.join(ROOT, ".venv", "bin", "python");
const execFileP = promisify(execFile);
export const dynamic = "force-dynamic";

async function readSpecs() {
  try {
    const files = (await fs.readdir(SPECS)).filter((f) => f.endsWith(".json"));
    return Promise.all(files.map(async (f) => JSON.parse(await fs.readFile(path.join(SPECS, f), "utf-8"))));
  } catch { return []; }
}
async function accountFor(id: string) {
  try {
    const { stdout } = await execFileP(PY, ["-c", `import sys,json;sys.path.insert(0,'.');from dryrun import botos;print(json.dumps(botos.account(${JSON.stringify(id)})))`], { cwd: ROOT, timeout: 20_000 });
    return JSON.parse(stdout);
  } catch { return null; }
}

export async function GET() {
  const specs = await readSpecs();
  const bots = await Promise.all(specs.map(async (s) => ({ ...s, book: await accountFor(s.id) })));
  return NextResponse.json({ bots });
}

// Create or update a bot from a spec. Validation runs in Python so the runner
// and the API can never disagree about what a legal spec is.
export async function POST(request: Request) {
  let spec: any; try { spec = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!spec.id && spec.name) spec.id = String(spec.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  try {
    const { stdout } = await execFileP(PY, [path.join(ROOT, "dryrun", "botos.py"), "validate", JSON.stringify(spec)], { cwd: ROOT, timeout: 20_000 });
    const v = JSON.parse(stdout);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    await fs.mkdir(SPECS, { recursive: true });
    await fs.writeFile(path.join(SPECS, `${v.spec.id}.json`), JSON.stringify(v.spec, null, 1));
    return NextResponse.json({ ok: true, spec: v.spec });
  } catch { return NextResponse.json({ error: "validator unavailable" }, { status: 500 }); }
}

export async function PATCH(request: Request) {
  let b: any; try { b = await request.json(); } catch { return NextResponse.json({ error: "bad json" }, { status: 400 }); }
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(String(b.id))) return NextResponse.json({ error: "bad id" }, { status: 400 });
  const f = path.join(SPECS, `${b.id}.json`);
  try {
    const spec = JSON.parse(await fs.readFile(f, "utf-8"));
    spec.enabled = !!b.enabled;
    await fs.writeFile(f, JSON.stringify(spec, null, 1));
    return NextResponse.json({ ok: true, spec });
  } catch { return NextResponse.json({ error: "no such bot" }, { status: 404 }); }
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id)) return NextResponse.json({ error: "bad id" }, { status: 400 });
  try { await fs.unlink(path.join(SPECS, `${id}.json`)); return NextResponse.json({ ok: true }); }
  catch { return NextResponse.json({ error: "no such bot" }, { status: 404 }); }
}
