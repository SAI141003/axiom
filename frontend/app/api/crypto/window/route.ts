import { NextResponse } from "next/server";

/**
 * Live Polymarket 5-minute Up/Down markets.
 * Event slug pattern: {asset}-updown-5m-{windowStartUnix} (multiples of 300s).
 *
 * Prices come from the CLOB ORDERBOOK (live midpoints per token) — Gamma's
 * outcomePrices lag the book and are kept only as fallback.
 */
const ASSETS = new Set(["btc", "eth", "sol", "xrp"]);

/**
 * ASK prices per token — matches what the Polymarket app displays and what a
 * buyer actually pays. CLOB semantics: side=SELL → best ask (side=BUY = bid).
 * Verified against the live app: asks sum slightly over $1 (e.g. 59¢+42¢).
 */
async function clobAsks(tokenIds: string[]): Promise<Record<string, number>> {
  try {
    const res = await fetch("https://clob.polymarket.com/prices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenIds.map((token_id) => ({ token_id, side: "SELL" }))),
      cache: "no-store",
    });
    if (!res.ok) return {};
    const d = await res.json();
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(d)) {
      const p = parseFloat((v as any)?.SELL ?? "");
      if (isFinite(p)) out[k] = p;
    }
    return out;
  } catch {
    return {};
  }
}

async function fetchWindow(asset: string, ts: number) {
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/events?slug=${asset}-updown-5m-${ts}`,
      { cache: "no-store" },
    );
    if (!res.ok) return null;
    const events = await res.json();
    const ev = events?.[0];
    const m = ev?.markets?.[0];
    if (!m) return null;

    // fallback prices from Gamma
    let up = 0.5, down = 0.5, source = "gamma";
    try {
      const prices = JSON.parse(m.outcomePrices).map(Number);
      up = prices[0]; down = prices[1];
    } catch {}

    // live ask prices from the CLOB — identical to the Polymarket app display
    let tokens: string[] = [];
    try { tokens = JSON.parse(m.clobTokenIds); } catch {}
    if (tokens.length === 2) {
      const asks = await clobAsks(tokens);
      const upAsk = asks[tokens[0]], downAsk = asks[tokens[1]];
      if (upAsk > 0 && upAsk < 1) { up = upAsk; source = "clob-ask"; }
      if (downAsk > 0 && downAsk < 1) { down = downAsk; if (source !== "clob-ask") source = "clob-ask"; }
      else if (source === "clob-ask") down = +(1 - up).toFixed(4);
    }

    return {
      slug: ev.slug,
      title: ev.title,
      windowStart: ts,
      windowEnd: ts + 300,
      upPrice: up,
      downPrice: down,
      priceSource: source,
      volume: Number(m.volume ?? 0),
      liquidity: Number(m.liquidity ?? 0),
      conditionId: m.conditionId,
      active: !!m.active && !m.closed,
    };
  } catch {
    return null;
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const asset = (searchParams.get("asset") ?? "btc").toLowerCase();
  if (!ASSETS.has(asset)) {
    return NextResponse.json({ error: "asset must be btc|eth|sol|xrp" }, { status: 400 });
  }

  const now = Math.floor(Date.now() / 1000);
  const currentTs = Math.floor(now / 300) * 300;

  const [current, next] = await Promise.all([
    fetchWindow(asset, currentTs),
    fetchWindow(asset, currentTs + 300),
  ]);

  return NextResponse.json({ asset, now, current, next });
}
