import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
// CelesTrak GP elements for the groups that matter to a desk: the stations,
// GPS, weather birds, the brightest. Propagated client-side with SGP4
// (satellite.js), exactly as God's Eye View does. Elements refresh every 2h.
const GROUPS = ["stations", "gps-ops", "weather", "visual", "science", "geo"];
export async function GET() {
  const c = await cached("tle", 2 * 3600_000, async () => {
    const all: any[] = [];
    for (const g of GROUPS) {
      const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`, { headers: UA, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) continue;
      for (const s of await r.json()) all.push({ ...s, group: g });
    }
    const seen = new Set<number>();
    return all.filter((s) => !seen.has(s.NORAD_CAT_ID) && seen.add(s.NORAD_CAT_ID));
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "CelesTrak", items: c.data ?? [] });
}
