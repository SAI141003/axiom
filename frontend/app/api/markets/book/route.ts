import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Real CLOB order book + price history for one token — the terminal's book and
// chart. Nothing synthesised: if the CLOB has no book, the panel says so.
export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || !/^\d+$/.test(token)) return NextResponse.json({ error: "token required" }, { status: 400 });
  const [book, hist] = await Promise.all([
    fetch(`https://clob.polymarket.com/book?token_id=${token}`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(`https://clob.polymarket.com/prices-history?market=${token}&interval=1d&fidelity=15`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const lvl = (rows: any[], desc: boolean) => {
    const out = (rows ?? []).map((r) => ({ price: +r.price, size: +r.size, total: 0 }))
      .sort((a, b) => (desc ? b.price - a.price : a.price - b.price)).slice(0, 12);
    let t = 0; for (const l of out) { t += l.size; l.total = t; }
    return out;
  };
  const bids = lvl(book?.bids, true), asks = lvl(book?.asks, false);
  const mid = bids[0] && asks[0] ? (bids[0].price + asks[0].price) / 2 : null;
  return NextResponse.json({
    book: mid == null ? null : { bids, asks, mid_price: mid, spread: asks[0].price - bids[0].price, timestamp: Date.now() },
    history: (hist?.history ?? []).map((h: any) => ({ ts: h.t * 1000, yes_price: +h.p, no_price: 1 - +h.p })),
  });
}
