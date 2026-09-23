import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";

export const dynamic = "force-dynamic";

// Public webcams on God's Eye — the last of the open signals Sai listed, next
// to the transponders, the orbits and the seismographs. Windy runs the only
// worldwide index with a free tier; without a key the layer says so rather
// than pretending to be empty, the same as the vessels and fires layers.
export async function GET() {
  const key = process.env.WINDY_WEBCAMS_KEY;
  if (!key) {
    return NextResponse.json({
      generated: Date.now(), configured: false, source: "Windy Webcams",
      note: "set WINDY_WEBCAMS_KEY (free at api.windy.com/webcams)", items: [],
    });
  }
  const c = await cached("cameras", 10 * 60_000, async () => {
    // The free tier caps a page at 50 and the offset at 1000, so the layer is
    // six pages fetched together rather than one big call.
    const pages = await Promise.all([0, 50, 100, 150, 200, 250].map(async (offset) => {
      const r = await fetch(`https://api.windy.com/webcams/api/v3/webcams?limit=50&offset=${offset}&include=location,images,player`,
        { headers: { ...UA, "x-windy-api-key": key }, signal: AbortSignal.timeout(12_000) });
      if (!r.ok) throw new Error(`windy ${r.status}`);
      return (await r.json()).webcams ?? [];
    }));
    return pages.flat().map((w: any) => ({
      id: String(w.webcamId ?? w.id),
      title: w.title,
      lat: w.location?.latitude, lon: w.location?.longitude,
      city: w.location?.city, country: w.location?.country,
      status: w.status,
      thumb: w.images?.current?.preview ?? w.images?.daylight?.preview ?? null,
      // Only about one camera in five actually streams; the rest offer a day
      // timelapse. Say which this is rather than calling both "live".
      isLive: !!w.player?.live,
      player: w.player?.live ?? w.player?.day ?? null,
      updated: w.lastUpdatedOn ?? null,
    })).filter((w: any) => Number.isFinite(w.lat) && Number.isFinite(w.lon) && w.player)
      .sort((a: any, b: any) => Number(b.isLive) - Number(a.isLive));
  });
  const items = c.data ?? [];
  return NextResponse.json({ generated: Date.now(), configured: true, age: c.age, error: c.error,
    source: "Windy Webcams", live: items.filter((i: any) => i.isLive).length, items });
}
