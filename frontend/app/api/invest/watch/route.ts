import { NextResponse } from "next/server";
import { watch } from "@/lib/investSignals";
import { cachedRoute } from "@/lib/swr";

export const dynamic = "force-dynamic";

// ?symbols=VTI,VXUS&holdings=NVDA,AAPL  (holdings feed the news only)
async function compute(req: Request) {
  const u = new URL(req.url);
  const symbols = (u.searchParams.get("symbols") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 8);
  const holdings = (u.searchParams.get("holdings") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return NextResponse.json({ error: "symbols required" }, { status: 400 });
  const rows = await Promise.all(symbols.map((s) => watch(s, holdings)));
  return NextResponse.json({ generated: Date.now(), rows });
}

// answered from memory in milliseconds; refreshed in the background every 300s
export async function GET(req: Request) {
  return cachedRoute(req, "invest-watch", 300000, compute);
}
