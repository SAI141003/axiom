import { NextResponse } from "next/server";
import { universe, type Market } from "@/lib/invest";
import { cachedRoute } from "@/lib/swr";

export const dynamic = "force-dynamic";

async function compute(req: Request) {
  const u = new URL(req.url);
  const market = (u.searchParams.get("market") === "ca" ? "ca" : "us") as Market;
  return NextResponse.json(await universe(market, u.searchParams.get("fresh") === "1"));
}

// answered from memory in milliseconds; refreshed in the background every 600s
export async function GET(req: Request) {
  return cachedRoute(req, "invest-universe", 600000, compute);
}
