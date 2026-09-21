import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
export async function GET() {
  const c = await cached("usgs", 60_000, async () => {
    const r = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", { headers: UA, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`usgs ${r.status}`);
    const d = await r.json();
    return (d.features ?? []).map((f: any) => ({ id: f.id, mag: f.properties.mag, place: f.properties.place, time: f.properties.time, depth: f.geometry.coordinates[2], lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], url: f.properties.url }));
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "USGS (24h)", items: c.data ?? [] });
}
