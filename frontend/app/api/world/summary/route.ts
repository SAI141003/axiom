import { NextResponse } from "next/server";
import { askLLM } from "@/lib/llm";

export const dynamic = "force-dynamic";

// The live summary beside the video wall: the freshest World Wire headlines,
// condensed by the desk's fast LLM into a situation picture and the two or
// three things that matter for the positions. Cached five minutes; if no LLM
// key is configured it degrades to a plain digest of the top headline per
// category, so the panel is never empty.
let cache: { at: number; payload: any } | null = null;

export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("refresh") === "1";
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return NextResponse.json(cache.payload);
  const base = new URL(request.url).origin;
  let world: any = null;
  try { world = await (await fetch(`${base}/api/world?cat=all`, { cache: "no-store" })).json(); } catch {}
  const cats: any[] = world?.categories ?? [];
  const lines = cats.flatMap((c) => c.items.slice(0, 5).map((it: any) => `[${c.label}] ${it.title} — ${it.source}`)).slice(0, 60);
  const digest = cats.map((c) => ({ label: c.label, top: c.items[0]?.title ?? "", source: c.items[0]?.source ?? "" })).filter((d) => d.top);
  let summary: string | null = null; let brain = "digest";
  if (lines.length) {
    try {
      summary = await askLLM(
        "You are the situation desk of a quantitative trading operation. Write for a trader glancing at a screen. Plain text, no markdown. Six short numbered lines: the five most consequential developments right now across markets, geopolitics, energy, crypto and tech, each one sentence with the source in parentheses; then a sixth line beginning 'For the desk:' naming what these mean for crypto, equities and weather/event markets in one sentence. Never invent facts not in the headlines.",
        `Time: ${new Date().toUTCString()}\nFreshest headlines:\n${lines.join("\n")}`, 500);
      brain = "llm";
    } catch { summary = null; }
  }
  const payload = { generated: Date.now(), brain, summary, digest, headlines: lines.length };
  cache = { at: Date.now(), payload };
  return NextResponse.json(payload);
}
