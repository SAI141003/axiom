import { NextResponse } from "next/server";

/**
 * Light live-quote endpoint — BATCH via Yahoo v7/finance/quote (one request
 * for up to 64 symbols, crumb-authenticated), pre/post-market aware.
 * Fallback: per-symbol v8 chart when the batch endpoint fails.
 */
const UA = { "User-Agent": "Mozilla/5.0" };

let _auth: { cookie: string; crumb: string; ts: number } | null = null;

async function yahooAuth() {
  if (_auth && Date.now() - _auth.ts < 20 * 60_000) return _auth;
  const r1 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r1.headers.get("set-cookie") ?? "").split(";")[0];
  const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("{")) throw new Error("crumb failed");
  _auth = { cookie, crumb, ts: Date.now() };
  return _auth;
}

interface Row { symbol: string; price: number | null; prevClose?: number | null; ts?: number | null }

async function batchQuotes(symbols: string[]): Promise<Row[] | null> {
  try {
    const { cookie, crumb } = await yahooAuth();
    const by: Record<string, any> = {};
    // Yahoo accepts large batches, but chunk at 64 to stay well inside limits
    for (let i = 0; i < symbols.length; i += 64) {
      const chunk = symbols.slice(i, i + 64);
      const res = await fetch(
        `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${chunk.join(",")}` +
        `&crumb=${encodeURIComponent(crumb)}`,
        { headers: { ...UA, cookie }, cache: "no-store" },
      );
      if (res.status === 401) { _auth = null; return null; }
      if (!res.ok) continue;
      const d = await res.json();
      for (const q of d.quoteResponse?.result ?? []) by[q.symbol] = q;
    }
    return symbols.map((sym) => {
      const q = by[sym];
      if (!q) return { symbol: sym, price: null };
      // extended-hours aware: post > pre > regular
      const price = q.postMarketPrice ?? q.preMarketPrice ?? q.regularMarketPrice ?? null;
      return {
        symbol: sym,
        price,
        prevClose: q.regularMarketPreviousClose ?? null,
        ts: q.postMarketTime ?? q.preMarketTime ?? q.regularMarketTime ?? null,
      };
    });
  } catch {
    return null;
  }
}

async function chartQuote(sym: string): Promise<Row> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1m&includePrePost=true`,
      { headers: UA, cache: "no-store" },
    );
    if (!res.ok) return { symbol: sym, price: null };
    const r = (await res.json()).chart?.result?.[0];
    if (!r) return { symbol: sym, price: null };
    const q = r.indicators?.quote?.[0];
    let last: number | null = null, lastTs: number | null = null;
    for (let i = (r.timestamp?.length ?? 0) - 1; i >= 0; i--) {
      if (q?.close?.[i] != null) { last = q.close[i]; lastTs = r.timestamp[i]; break; }
    }
    return { symbol: sym, price: last ?? r.meta?.regularMarketPrice ?? null,
             prevClose: r.meta?.chartPreviousClose ?? null, ts: lastTs };
  } catch {
    return { symbol: sym, price: null };
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = (searchParams.get("symbols") ?? "")
    .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 160);
  if (symbols.length === 0) return NextResponse.json([]);

  const batch = await batchQuotes(symbols);
  if (batch && batch.some((r) => r.price != null)) return NextResponse.json(batch);

  // fallback: parallel per-symbol charts (capped to protect Yahoo rate limits)
  const rows = await Promise.all(symbols.slice(0, 28).map(chartQuote));
  return NextResponse.json(rows);
}
