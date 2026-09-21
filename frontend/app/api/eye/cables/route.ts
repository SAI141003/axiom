import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
// TeleGeography's public Submarine Cable Map GeoJSON, fetched at runtime under
// their terms (CC BY-NC-SA) — not vendored. Landing points as points, cables as paths.
export async function GET() {
  const c = await cached("cables", 24 * 3600_000, async () => {
    const [cab, lp] = await Promise.all(["cable/cable-geo.json", "landing-point/landing-point-geo.json"].map(async (p) => { const r = await fetch(`https://www.submarinecablemap.com/api/v3/${p}`, { headers: UA, signal: AbortSignal.timeout(30_000) }); if (!r.ok) throw new Error(`telegeography ${r.status}`); return r.json(); }));
    const cables = (cab.features ?? []).map((f: any) => ({ id: f.properties.id, name: f.properties.name, color: f.properties.color, coords: f.geometry.type === "MultiLineString" ? f.geometry.coordinates : [f.geometry.coordinates] }));
    const landings = (lp.features ?? []).map((f: any) => ({ id: f.properties.id, name: f.properties.name, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
    return { cables, landings };
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "TeleGeography Submarine Cable Map (CC BY-NC-SA)", ...(c.data ?? { cables: [], landings: [] }) });
}
