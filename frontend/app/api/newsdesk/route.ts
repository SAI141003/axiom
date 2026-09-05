import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { askLLM } from "../../../lib/llm";

/**
 * QUANT NEWS DESK — live headlines classified the way a desk quant reads them:
 *   headline → event type → affected symbols (direct + chain) → direction,
 *   magnitude, horizon, vol effect → concrete stock play + options play.
 *
 * Quant framing per event type (encoded in the prompt):
 *   earnings/guidance = scheduled vol event (IV rich before, crushes after)
 *   M&A               = jump risk; target pins to offer, acquirer drifts
 *   regulatory        = slow drift + tail risk
 *   product/launch    = momentum + supplier chain spillover
 *   analyst action    = small drift, fades in days
 *   macro/Fed         = correlated beta move — trade index, not single names
 *   litigation        = tail event, options skew
 *
 * Every named symbol is validated against a live quote before it's shown
 * (LLM output is a candidate, never a fact). Each pass is appended to
 * logs/news_intel.jsonl so the brain can correlate news → P&L later.
 * Cache: 5 min per watchlist.
 */

const WATCHLIST = ["NVDA", "TSLA", "AAPL", "MSFT", "AMD", "GOOGL", "META", "MU", "SPY", "QQQ"];
const ROOT = path.join(process.cwd(), "..");

let _cache: { key: string; ts: number; payload: any } | null = null;

async function newsFor(sym: string): Promise<any[]> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v1/finance/search?q=${sym}&newsCount=6&quotesCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 300 } },
    );
    if (!res.ok) return [];
    return ((await res.json()).news ?? []).map((n: any) => ({
      sym,
      uuid: n.uuid,
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      published: (n.providerPublishTime ?? 0) * 1000,
    }));
  } catch {
    return [];
  }
}

async function liveQuotes(symbols: string[]): Promise<Record<string, { price: number; chgPct: number }>> {
  const out: Record<string, { price: number; chgPct: number }> = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${s}?range=1d&interval=1d`,
        { headers: { "User-Agent": "Mozilla/5.0" }, next: { revalidate: 120 } },
      );
      if (!res.ok) return;
      const meta = (await res.json())?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice != null) {
        const prev = meta.chartPreviousClose ?? meta.regularMarketPrice;
        out[s] = {
          price: meta.regularMarketPrice,
          chgPct: prev ? Number((((meta.regularMarketPrice - prev) / prev) * 100).toFixed(2)) : 0,
        };
      }
    } catch {}
  }));
  return out;
}

const SYSTEM_PROMPT = `You are a desk quant triaging live headlines. For each headline return a JSON object:
{"uuid": "...", "event_type": "earnings|guidance|mna|regulatory|product|analyst|macro|litigation|supply_chain|other",
 "direction": "bull|bear|mixed", "magnitude": 1-5, "horizon": "intraday|days|weeks",
 "affected": [{"sym": "TICKER", "relation": "direct|supplier|customer|competitor|sector", "direction": "bull|bear"}],
 "vol_effect": "spike|crush_after_event|skew|none",
 "stock_play": "one concrete sentence", "options_play": "one concrete sentence"}
Rules: think in expected move and vol, not stories. Earnings before the event = long vol only if IV premium is low; after = expect IV crush. Macro headlines → index (SPY/QQQ) beta move, not single names. M&A target pins near offer price. Only include symbols genuinely affected. Reply with a JSON array ONLY, no prose. Skip headlines with no tradable implication by returning magnitude 1.`;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = (searchParams.get("symbols")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    ?? []).slice(0, 12);
  const watch = symbols.length ? symbols : WATCHLIST;
  const key = watch.join(",");

  if (_cache && _cache.key === key && Date.now() - _cache.ts < 5 * 60_000) {
    return NextResponse.json(_cache.payload);
  }

  // 1. Ingest — dedupe by uuid, last 48h, newest first
  const all = (await Promise.all(watch.map(newsFor))).flat();
  const seen = new Set<string>();
  const items = all
    .filter((n) => n.published > Date.now() - 48 * 3600_000)
    .filter((n) => (seen.has(n.uuid) ? false : (seen.add(n.uuid), true)))
    .sort((a, b) => b.published - a.published)
    .slice(0, 24);

  // 2. Classify with the LLM chain (Groq→Cerebras→…) — one batched call
  let classified: any[] = [];
  if (items.length) {
    try {
      const user = items.map((n) => JSON.stringify({ uuid: n.uuid, about: n.sym, title: n.title })).join("\n");
      const raw = await askLLM(SYSTEM_PROMPT, user, 3000);
      const jsonStr = raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
      classified = JSON.parse(jsonStr);
    } catch {
      classified = [];
    }
  }
  const byUuid = new Map(classified.map((c: any) => [c.uuid, c]));

  // 3. Validate every named symbol against a live quote (reality co-signs)
  const namedSyms = new Set<string>(watch);
  for (const c of classified) for (const a of c.affected ?? []) namedSyms.add(String(a.sym).toUpperCase());
  const quotes = await liveQuotes([...namedSyms].slice(0, 40));

  const cards = items.map((n) => {
    const c = byUuid.get(n.uuid);
    const affected = (c?.affected ?? [])
      .map((a: any) => ({ ...a, sym: String(a.sym).toUpperCase() }))
      .filter((a: any) => quotes[a.sym])                 // drop hallucinated tickers
      .map((a: any) => ({ ...a, ...quotes[a.sym] }));
    return {
      ...n,
      quote: quotes[n.sym] ?? null,
      eventType: c?.event_type ?? "other",
      direction: c?.direction ?? "mixed",
      magnitude: c?.magnitude ?? 1,
      horizon: c?.horizon ?? "days",
      volEffect: c?.vol_effect ?? "none",
      stockPlay: c?.stock_play ?? null,
      optionsPlay: c?.options_play ?? null,
      affected,
    };
  }).sort((a, b) => b.magnitude - a.magnitude || b.published - a.published);

  const payload = {
    generated: Date.now(),
    watchlist: watch,
    llmActive: classified.length > 0,
    cards,
  };

  // 4. Persist for the brain (news → later P&L correlation)
  try {
    const line = JSON.stringify({ ts: Math.floor(Date.now() / 1000), type: "newsdesk",
      cards: cards.filter((c) => c.magnitude >= 2).map((c) => ({
        uuid: c.uuid, sym: c.sym, title: c.title, eventType: c.eventType,
        direction: c.direction, magnitude: c.magnitude,
        affected: c.affected.map((a: any) => a.sym) })) }) + "\n";
    await fs.appendFile(path.join(ROOT, "logs", "news_intel.jsonl"), line);
  } catch {}

  _cache = { key, ts: Date.now(), payload };
  return NextResponse.json(payload);
}
