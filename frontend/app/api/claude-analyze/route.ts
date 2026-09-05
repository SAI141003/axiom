import { NextResponse } from "next/server";
import { askLLM } from "@/lib/llm";

export async function POST(request: Request) {
  let body: { stats?: Record<string, unknown>; signals?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { stats = {}, signals = [] } = body;

  const prompt = `You are MiroFish, a Polymarket HFT trading analyst. Analyze these live trading stats and provide a 2-sentence insight on edge quality and risk state.

Stats: ${JSON.stringify(stats, null, 2)}
Recent signals (last 5): ${JSON.stringify(signals.slice(-5), null, 2)}

Reply with JSON: {"insight": "...", "risk_level": "LOW"|"MEDIUM"|"HIGH", "action": "..."}`;

  try {
    const text = await askLLM("Reply with strict JSON only.", prompt, 256);

    let parsed: Record<string, string>;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(match ? match[0] : text);
    } catch {
      parsed = { insight: text, risk_level: "MEDIUM", action: "Monitor" };
    }

    return NextResponse.json(parsed);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
