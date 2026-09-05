import { NextResponse } from "next/server";

// Server-side Yahoo Finance quote proxy (no API key, avoids CORS).
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const symbols = (searchParams.get("symbols") ?? "NVDA").split(",").slice(0, 20);

  const results = await Promise.all(
    symbols.map(async (sym) => {
      try {
        const res = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.trim())}?range=5d&interval=1d`,
          {
            headers: { "User-Agent": "Mozilla/5.0" },
            next: { revalidate: 120 },
          },
        );
        if (!res.ok) return { symbol: sym, price: null };
        const data = await res.json();
        const meta = data.chart?.result?.[0]?.meta;
        if (!meta) return { symbol: sym, price: null };
        return {
          symbol: sym.trim(),
          price: meta.regularMarketPrice ?? null,
          previousClose: meta.chartPreviousClose ?? null,
          fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
          fiftyTwoWeekLow: meta.fiftyTwoWeekLow ?? null,
          currency: meta.currency ?? "USD",
        };
      } catch {
        return { symbol: sym, price: null };
      }
    }),
  );

  return NextResponse.json(results);
}
