import { NextResponse } from "next/server";
import { fetchKalshiMarkets, type KalshiMarket } from "../../../lib/kalshi";

/**
 * Cross-venue arbitrage — priced at EXECUTABLE asks, complete baskets only.
 *
 * A real arb is: buy YES on one venue + NO on the other for < $1 total, net
 * of both venues' fees. Comparing mid-vs-mid overstates edge by both spreads
 * (the NegRisk "+153%" lesson). Polymarket legs price from the live book
 * (bestAsk for YES, 1−bestBid for NO); Kalshi legs need API creds — without
 * them pairs are returned as "candidates" with no fake edge attached.
 */

const GAMMA = "https://gamma-api.polymarket.com";

const STOP = new Set(["will", "the", "a", "an", "in", "on", "by", "of", "to",
  "be", "at", "is", "for", "and", "or", "before", "after", "than", "more",
  "2026", "2027"]);

function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  a.forEach((w) => { if (b.has(w)) inter++; });
  return inter / (a.size + b.size - inter);
}

// different numbers = different events ("above 90" vs "above 95")
function numbersMatch(a: string, b: string): boolean {
  const nums = (s: string) => new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number));
  const na = nums(a), nb = nums(b);
  if (na.size === 0 && nb.size === 0) return true;
  for (const n of na) if (!nb.has(n)) return false;
  for (const n of nb) if (!na.has(n)) return false;
  return true;
}

// Polymarket CLOB dynamic taker fee: peak × 4p(1−p); geopolitical/world free
function polyFee(p: number, category: string): number {
  const cat = category.toLowerCase();
  if (cat.includes("geopolit") || cat.includes("world")) return 0;
  const peak = cat.includes("polit") || cat.includes("finance") ? 0.01 : 0.02;
  return peak * 4 * p * (1 - p);
}

// Kalshi taker fee: 0.07 × p(1−p), rounded up per contract — use the curve
function kalshiFee(p: number): number {
  return 0.07 * p * (1 - p);
}

interface PolyMarket {
  question: string;
  slug: string;
  category: string;
  bestBid: number | null;
  bestAsk: number | null;
  liquidityNum: number;
  events?: { title?: string; category?: string }[];
}

async function fetchPoly(limit: number): Promise<PolyMarket[]> {
  const res = await fetch(
    `${GAMMA}/markets?active=true&closed=false&limit=${limit}&order=liquidityNum&ascending=false&enableOrderBook=true`,
    { next: { revalidate: 30 } },
  );
  if (!res.ok) return [];
  const raw = await res.json();
  return (raw as any[]).map((m) => ({
    question: m.question ?? "",
    slug: m.slug ?? "",
    category: m.events?.[0]?.category ?? m.category ?? "",
    bestBid: m.bestBid != null ? Number(m.bestBid) : null,
    bestAsk: m.bestAsk != null ? Number(m.bestAsk) : null,
    liquidityNum: Number(m.liquidityNum ?? 0),
  }));
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const minSim = Number(searchParams.get("minSim") ?? 0.5);

  const [poly, kalshi] = await Promise.all([fetchPoly(300), fetchKalshiMarkets(200)]);

  const kTok = kalshi.markets.map((k) => ({ k, t: tokens(k.title) }));
  const pairs: any[] = [];

  for (const p of poly) {
    if (p.bestAsk == null || p.bestBid == null) continue;
    const pt = tokens(p.question);
    let best: { k: KalshiMarket; sim: number } | null = null;
    for (const { k, t } of kTok) {
      const sim = jaccard(pt, t);
      if (sim >= minSim && numbersMatch(p.question, k.title)
          && (!best || sim > best.sim)) best = { k, sim };
    }
    if (!best) continue;

    const k = best.k;
    const pYesAsk = p.bestAsk;            // buy YES on Poly
    const pNoAsk = 1 - p.bestBid;         // buy NO on Poly = sell-side of book
    let executable = false;
    let bestBasket: any = null;

    if (k.yes_ask != null && k.no_ask != null) {
      executable = true;
      // basket A: Poly YES + Kalshi NO   → payoff $1 whichever way it resolves
      const costA = pYesAsk + k.no_ask
        + polyFee(pYesAsk, p.category) + kalshiFee(k.no_ask);
      // basket B: Kalshi YES + Poly NO
      const costB = k.yes_ask + pNoAsk
        + polyFee(pNoAsk, p.category) + kalshiFee(k.yes_ask);
      const [cost, legs] = costA <= costB
        ? [costA, `Buy YES on Polymarket @ ${pYesAsk.toFixed(2)} + NO on Kalshi @ ${k.no_ask.toFixed(2)}`]
        : [costB, `Buy YES on Kalshi @ ${k.yes_ask.toFixed(2)} + NO on Polymarket @ ${pNoAsk.toFixed(2)}`];
      bestBasket = { cost: Number(cost.toFixed(4)), edge: Number((1 - cost).toFixed(4)), legs };
    }

    pairs.push({
      polyQuestion: p.question,
      polySlug: p.slug,
      kalshiTitle: k.title,
      kalshiTicker: k.ticker,
      similarity: Number(best.sim.toFixed(3)),
      polyYesAsk: pYesAsk,
      polyNoAsk: Number(pNoAsk.toFixed(3)),
      kalshiYesAsk: k.yes_ask,
      kalshiNoAsk: k.no_ask,
      executable,
      basket: bestBasket,   // null when Kalshi quotes unavailable — no fake edge
    });
  }

  pairs.sort((a, b) => (b.basket?.edge ?? -1) - (a.basket?.edge ?? -1)
    || b.similarity - a.similarity);

  return NextResponse.json({
    generated: Date.now(),
    polyCount: poly.length,
    kalshiCount: kalshi.markets.length,
    kalshiQuotes: kalshi.quotesAvailable,
    pairs: pairs.slice(0, 50),
  });
}
