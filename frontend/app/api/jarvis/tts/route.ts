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
const STT = process.env.STT_URL || "http://127.0.0.1:5002";

// AXIOM's voice: Piper (MIT), the open speech stack, kept warm beside the ears
// in signals/stt_server.py. It used to be Microsoft's neural Ryan over the
// network, which cost 5.7-9.1 s for a sentence it had not said before — that
// delay was most of what made AXIOM feel slow. Piper renders the same sentence
// here in 40-370 ms and never leaves the machine. edge-tts stays as the
// fallback for the case where the local service is down.
const VOICE = process.env.AXIOM_VOICE || "en-GB-RyanNeural";

// Which voice produced a clip has to be part of its name, or changing the
// voice leaves every sentence AXIOM has already said playing in the old one.
// The model and its prosody live in the speech service, so ask it — once a
// minute is plenty, and a failure falls back to a name that is still stable.
let voiceId = "piper";
let voiceCheckedAt = 0;
async function currentVoice(): Promise<string> {
  if (Date.now() - voiceCheckedAt < 60_000) return voiceId;
  try {
    const d = await (await fetch(`${STT}/`, { cache: "no-store", signal: AbortSignal.timeout(2500) })).json();
    if (d?.voice?.model) voiceId = `${d.voice.model}|${d.voice.rate ?? ""}`;
  } catch {}
  voiceCheckedAt = Date.now();
  return voiceId;
}

export async function POST(request: Request) {
  let text = "";
  try { text = String((await request.json()).text ?? ""); } catch {}
  text = text.replace(/[*_#`]/g, "").replace(/\s+/g, " ").trim().slice(0, 1800);
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const key = createHash("sha1").update(`${await currentVoice()}|${text}`).digest("hex");
  const file = path.join(CACHE, `${key}.wav`);
  try {
    const buf = await fs.readFile(file);
    return new NextResponse(buf, { headers: { "content-type": "audio/wav", "x-axiom-voice": "piper", "x-cache": "hit" } });
  } catch {}
  try {
    const r = await fetch(`${STT}/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }), signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`speak ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.mkdir(CACHE, { recursive: true }).then(() => fs.writeFile(file, buf)).catch(() => {});
    trim();
    return new NextResponse(buf, { headers: { "content-type": "audio/wav", "x-axiom-voice": "piper", "x-cache": "miss", "x-ms": r.headers.get("x-ms") ?? "" } });
  } catch {
    // the local voice is down — fall back to the network one rather than going mute
    try {
      const mp3 = path.join(CACHE, `${createHash("sha1").update(`${VOICE}|${text}`).digest("hex")}.mp3`);
      try { return new NextResponse(await fs.readFile(mp3), { headers: { "content-type": "audio/mpeg", "x-axiom-voice": VOICE, "x-cache": "hit" } }); } catch {}
      await fs.mkdir(CACHE, { recursive: true });
      await run(PY, ["-m", "edge_tts", "--voice", VOICE, "--rate=+4%", "--text", text, "--write-media", mp3], { timeout: 20_000 });
      trim();
      return new NextResponse(await fs.readFile(mp3), { headers: { "content-type": "audio/mpeg", "x-axiom-voice": VOICE, "x-cache": "miss", "x-fallback": "edge-tts" } });
    } catch (e: any) {
      return NextResponse.json({ error: `tts failed: ${String(e?.message ?? e).slice(0, 200)}` }, { status: 503 });
    }
  }
}

// keep the cache small: drop the oldest once past 300 clips
function trim() {
  fs.readdir(CACHE).then(async (names) => {
    if (names.length <= 300) return;
    const st = await Promise.all(names.map(async (f) => ({ f, t: (await fs.stat(path.join(CACHE, f))).mtimeMs })));
    for (const s of st.sort((a, b) => a.t - b.t).slice(0, 50)) fs.unlink(path.join(CACHE, s.f)).catch(() => {});
  }).catch(() => {});
}

export async function GET() {
  const t = Date.now();
  try {
    const d = await (await fetch(`${STT}/`, { cache: "no-store", signal: AbortSignal.timeout(3000) })).json();
    if (d?.voice?.ok) return NextResponse.json({ ok: true, voice: d.voice.model, engine: "piper (local, MIT)", warm: !!d.voice.warm, ms: Date.now() - t });
  } catch {}
  try {
    await run(PY, ["-c", "import edge_tts"], { timeout: 10_000 });
    return NextResponse.json({ ok: true, voice: VOICE, engine: "edge-tts fallback — piper service is down", ms: Date.now() - t });
  } catch { return NextResponse.json({ ok: false, voice: VOICE, engine: "no voice — start com.polymarket.stt", ms: Date.now() - t }); }
}
