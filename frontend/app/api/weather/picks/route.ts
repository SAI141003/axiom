import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// LIVE WEATHER PICKS — the exact markets the bot's edge flags right now, with
// full names + the Polymarket link, so a human can review and act on them.
// Applies the same tuned gate the daemon trades (entry≥ENTRY_MIN, edge≤EDGE_CAP).
export async function GET() {
  let gate = { min: 0.75, max: 0.18 };
  try {
    const p = JSON.parse(await fs.readFile(path.join(ROOT, ".data", "tuned_params.json"), "utf-8"));
    gate = { min: p?.weather?.ENTRY_MIN?.value ?? 0.70, max: p?.weather?.EDGE_CAP?.value ?? 0.15 };
  } catch {}

  let raw = "";
  try { raw = await fs.readFile(path.join(ROOT, "logs", "dryrun_weather.jsonl"), "utf-8"); } catch {}
  const now = Date.now() / 1000;
  const bySlug = new Map<string, any>();          // latest pick per market
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let t: any; try { t = JSON.parse(line); } catch { continue; }
    if (t.type !== "wtrade") continue;
    if (!(t.entry >= gate.min && Math.abs(t.edge ?? 0) <= gate.max)) continue;
    if (now - (t.ts ?? 0) > 48 * 3600) continue;   // last 48h only
    const prev = bySlug.get(t.slug);
    if (!prev || t.ts > prev.ts) bySlug.set(t.slug, t);
  }

  const unit = (q: string) => (/°F|between .* and|\bF\b/.test(q) ? "°F" : "°C");
  const picks = Array.from(bySlug.values())
    .sort((a, b) => b.ts - a.ts)
    .map((t) => ({
      question: t.q,                               // FULL market name
      city: t.city,
      side: t.side,                                // YES / NO
      bucket: t.low === t.high ? `${t.low}${unit(t.q)}` : `${t.low}–${t.high}${unit(t.q)}`,
      entry: t.entry,                              // price you'd pay
      edge: Number((t.edge ?? 0).toFixed(2)),
      hoursAgo: Math.round((now - t.ts) / 3600),
      url: `https://polymarket.com/event/${t.slug}`,
      slug: t.slug,
    }));

  return NextResponse.json({ gate, count: picks.length, picks,
    note: "The bot's edge on these exact markets. Review before acting — venue access is your call." });
}
