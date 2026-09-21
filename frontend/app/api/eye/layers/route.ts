import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
export const dynamic = "force-dynamic";
// The desk's own geography for the Eye: the weather bot's stations with their
// live positions, the exchanges and chokepoints the fleet watches.
export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  const [wt, map] = await Promise.all([
    fetch(`${base}/api/weather-trades`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    fetch(`${base}/api/world/map`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
  ]);
  let cities: Record<string, any> = {};
  try { cities = JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "eye", "stations.json"), "utf-8")); } catch {}
  const open = (wt?.trades ?? []).filter((t: any) => t.status === "open");
  const stations = Object.entries(cities).map(([city, c]) => ({ city, ...c, open: open.filter((t: any) => t.city === city).map((t: any) => ({ q: t.q, side: t.side, entry: t.entry, stake: t.stake, hours: t.hours_elapsed })) }));
  return NextResponse.json({ generated: Date.now(), stations, exchanges: map?.exchanges ?? [], chokepoints: map?.chokepoints ?? [], regions: map?.regions ?? [] });
}
