import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const STT = process.env.STT_URL || "http://127.0.0.1:5002";

// AXIOM's ears: Whisper (OpenAI's MIT weights) running on this machine through
// whisper.cpp, kept warm by signals/stt_server.py. The browser's own recogniser
// paraphrases — "Axiom" becomes "action", "yes Sai" becomes "yes sign" — this
// writes down what was said. The audio never leaves the machine.
export async function POST(request: Request) {
  const body = Buffer.from(await request.arrayBuffer());
  if (!body.length) return NextResponse.json({ error: "no audio" }, { status: 400 });
  try {
    const r = await fetch(`${STT}/transcribe`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body, signal: AbortSignal.timeout(45_000) });
    return NextResponse.json(await r.json(), { status: r.status });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e).slice(0, 160), hint: "launchctl kickstart -k gui/$UID/com.polymarket.stt" }, { status: 503 });
  }
}

export async function GET() {
  try {
    const r = await fetch(`${STT}/`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return NextResponse.json(await r.json());
  } catch { return NextResponse.json({ ok: false, engine: "whisper.cpp", note: "the local Whisper service is not running" }); }
}
