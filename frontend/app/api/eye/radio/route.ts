import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
// Radio Browser: geolocated internet radio, the most-voted 800 with a stream URL.
export async function GET() {
  const c = await cached("radio", 6 * 3600_000, async () => {
    const r = await fetch("https://de1.api.radio-browser.info/json/stations/search?has_geo_info=true&order=votes&reverse=true&limit=800&hidebroken=true", { headers: UA, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`radio-browser ${r.status}`);
    return (await r.json()).map((s: any) => ({ id: s.stationuuid, name: s.name, url: s.url_resolved || s.url, country: s.country, lat: s.geo_lat, lon: s.geo_long, tags: String(s.tags ?? "").split(",").slice(0, 3).join(", "), codec: s.codec, votes: s.votes }));
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "Radio Browser", items: c.data ?? [] });
}
