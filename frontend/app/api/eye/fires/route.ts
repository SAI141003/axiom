import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
// NASA FIRMS active fires (VIIRS, last 24h, worldwide) — needs a free FIRMS_MAP_KEY.
export async function GET() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return NextResponse.json({ generated: Date.now(), configured: false, source: "NASA FIRMS", note: "set FIRMS_MAP_KEY (free at firms.modaps.eosdis.nasa.gov/api/)", items: [] });
  const c = await cached("firms", 30 * 60_000, async () => {
    const r = await fetch(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/world/1`, { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`firms ${r.status}`);
    const [head, ...rows] = (await r.text()).trim().split("\n"); const h = head.split(",");
    return rows.slice(0, 20_000).map((l) => { const c = l.split(","); const o: any = {}; h.forEach((k, i) => (o[k] = c[i])); return { lat: +o.latitude, lon: +o.longitude, frp: +o.frp, conf: o.confidence, when: `${o.acq_date} ${o.acq_time}` }; });
  });
  return NextResponse.json({ generated: Date.now(), configured: true, age: c.age, error: c.error, source: "NASA FIRMS VIIRS 24h", items: c.data ?? [] });
}
