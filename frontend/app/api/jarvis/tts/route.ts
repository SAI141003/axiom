import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { createHash } from "crypto";
import { promises as fs } from "fs";
import path from "path";

export const dynamic = "force-dynamic";
const run = promisify(execFile);
const ROOT = path.join(process.cwd(), "..");
const PY = path.join(ROOT, ".venv", "bin", "python");
const CACHE = path.join(ROOT, ".data", "tts");

// AXIOM's one voice. Microsoft's neural "Ryan" (en-GB) through edge-tts: free,
// no key, and it sounds like a person, not a synthesiser. The browser falls
// back to its own best en-GB voice only if this route fails.
const VOICE = process.env.AXIOM_VOICE || "en-GB-RyanNeural";

export async function POST(request: Request) {
  let text = "";
  try { text = String((await request.json()).text ?? ""); } catch {}
  text = text.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim().slice(0, 1800);
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const key = createHash("sha1").update(`${VOICE}|${text}`).digest("hex");
  const file = path.join(CACHE, `${key}.mp3`);
  try {
    const buf = await fs.readFile(file);
    return new NextResponse(buf, { headers: { "content-type": "audio/mpeg", "x-axiom-voice": VOICE, "x-cache": "hit" } });
  } catch {}
  try {
    await fs.mkdir(CACHE, { recursive: true });
    await run(PY, ["-m", "edge_tts", "--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", file], { timeout: 20_000 });
    const buf = await fs.readFile(file);
    // keep the cache small: drop the oldest once past 300 clips
    fs.readdir(CACHE).then(async (fs_) => { if (fs_.length > 300) { const st = await Promise.all(fs_.map(async (f) => ({ f, t: (await fs.stat(path.join(CACHE, f))).mtimeMs }))); for (const s of st.sort((a, b) => a.t - b.t).slice(0, 50)) fs.unlink(path.join(CACHE, s.f)).catch(() => {}); } }).catch(() => {});
    return new NextResponse(buf, { headers: { "content-type": "audio/mpeg", "x-axiom-voice": VOICE, "x-cache": "miss" } });
  } catch (e: any) {
    return NextResponse.json({ error: `tts failed: ${String(e?.message ?? e).slice(0, 200)}` }, { status: 503 });
  }
}

export async function GET() {
  const t = Date.now();
  try {
    await run(PY, ["-c", "import edge_tts"], { timeout: 10_000 });
    return NextResponse.json({ ok: true, voice: VOICE, engine: "edge-tts (Microsoft neural)", ms: Date.now() - t });
  } catch { return NextResponse.json({ ok: false, voice: VOICE, engine: "edge-tts missing — .venv/bin/pip install edge-tts", ms: Date.now() - t }); }
}
