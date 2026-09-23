import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";

const ROOT = path.join(process.cwd(), "..");

// LIVE WEATHER PICKS — the exact markets the bot's edge flags right now, with
// full names + the Polymarket link, so a human can review and act on them.
// Applies the same tuned gate the daemon trades (entry≥ENTRY_MIN, edge≤EDGE_CAP).
// Resolved markets are dropped, and each open pick carries its live price so the
// list says what can still be bought now, not what the bot bought yesterday.
export const dynamic = "force-dynamic";

async function livePrice(slug: string, question: string, side: string) {
  try {
    const r = await fetch(`https://gamma-api.polymarket.com/events?slug=${slug}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    const e = (await r.json())?.[0];
    const m = e?.markets?.find((x: any) => x.question === question);
    if (!m) return null;
    const [yes, no] = JSON.parse(m.outcomePrices ?? "[]").map(Number);
    const ended = e.endDate ? Date.parse(e.endDate) < Date.now() : false;
    return { now: side === "YES" ? yes : no, closed: Boolean(m.closed || e.closed), ended };
  } catch { return null; }
}

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
  const resolved = new Set<string>();
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let t: any; try { t = JSON.parse(line); } catch { continue; }
    if (t.type === "resolve") { resolved.add(t.slug); continue; }
    if (t.type !== "wtrade") continue;
    if (!(t.entry >= gate.min && Math.abs(t.edge ?? 0) <= gate.max)) continue;
    if (now - (t.ts ?? 0) > 48 * 3600) continue;   // last 48h only
    const prev = bySlug.get(t.slug);
    if (!prev || t.ts > prev.ts) bySlug.set(t.slug, t);
  }

  const unit = (q: string) => (/°F|between .* and|\bF\b/.test(q) ? "°F" : "°C");
  const open = Array.from(bySlug.values()).filter((t) => !resolved.has(t.slug));
  const live = await Promise.all(open.map((t) => livePrice(t.slug, t.q, t.side)));
  const picks = open
    .map((t, i) => ({ t, l: live[i] }))
    .filter(({ l }) => !l?.closed)
    .map(({ t, l }) => ({
      question: t.q,                               // FULL market name
      city: t.city,
      side: t.side,                                // YES / NO
      bucket: t.low === t.high ? `${t.low}${unit(t.q)}` : `${t.low}–${t.high}${unit(t.q)}`,
      entry: t.entry,                              // price you'd pay
      edge: Number((t.edge ?? 0).toFixed(2)),
      hoursAgo: Math.round((now - t.ts) / 3600),
      url: `https://polymarket.com/event/${t.slug}`,
      slug: t.slug,
      now: l?.now ?? null,                         // live price of the same side
      // buyable: still trading, not past its end, and the price is still inside
      // the band the bot enters (below 0.97 there is nothing left to earn)
      status: !l ? "unknown" : l.ended ? "settling" : l.now >= gate.min && l.now < 0.97 ? "buy" : "passed",
    }))
    .sort((a, b) => (a.status === "buy" ? 0 : 1) - (b.status === "buy" ? 0 : 1) || a.hoursAgo - b.hoursAgo);

  return NextResponse.json({ gate, count: picks.length, picks,
    note: "The bot's edge on these exact markets. Review before acting — venue access is your call." });
}
