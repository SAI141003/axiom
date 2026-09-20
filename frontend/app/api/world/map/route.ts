import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// AXIOM's own situation layer, all free: USGS earthquakes (24h, M4.5+), the
// chokepoints and exchanges that matter to a trading desk (fixed coordinates),
// and the World Wire's headline counts per region so the map shows where the
// news is coming from. No third-party dashboard in the loop.
const EXCHANGES = [
  { name: "NYSE / Nasdaq", lat: 40.71, lon: -74.01, tz: "America/New_York", open: "09:30", close: "16:00" },
  { name: "CME", lat: 41.88, lon: -87.63, tz: "America/Chicago", open: "17:00", close: "16:00" },
  { name: "TSX", lat: 43.65, lon: -79.38, tz: "America/Toronto", open: "09:30", close: "16:00" },
  { name: "LSE", lat: 51.51, lon: -0.09, tz: "Europe/London", open: "08:00", close: "16:30" },
  { name: "Euronext", lat: 48.86, lon: 2.35, tz: "Europe/Paris", open: "09:00", close: "17:30" },
  { name: "Xetra", lat: 50.11, lon: 8.68, tz: "Europe/Berlin", open: "09:00", close: "17:30" },
  { name: "SIX", lat: 47.37, lon: 8.54, tz: "Europe/Zurich", open: "09:00", close: "17:30" },
  { name: "Tadawul", lat: 24.71, lon: 46.68, tz: "Asia/Riyadh", open: "10:00", close: "15:00" },
  { name: "NSE India", lat: 19.08, lon: 72.88, tz: "Asia/Kolkata", open: "09:15", close: "15:30" },
  { name: "SGX", lat: 1.29, lon: 103.85, tz: "Asia/Singapore", open: "09:00", close: "17:00" },
  { name: "HKEX", lat: 22.32, lon: 114.17, tz: "Asia/Hong_Kong", open: "09:30", close: "16:00" },
  { name: "SSE Shanghai", lat: 31.23, lon: 121.47, tz: "Asia/Shanghai", open: "09:30", close: "15:00" },
  { name: "TSE Tokyo", lat: 35.68, lon: 139.69, tz: "Asia/Tokyo", open: "09:00", close: "15:30" },
  { name: "ASX", lat: -33.87, lon: 151.21, tz: "Australia/Sydney", open: "10:00", close: "16:00" },
  { name: "B3 São Paulo", lat: -23.55, lon: -46.63, tz: "America/Sao_Paulo", open: "10:00", close: "17:00" },
  { name: "JSE", lat: -26.2, lon: 28.05, tz: "Africa/Johannesburg", open: "09:00", close: "17:00" },
];
const CHOKEPOINTS = [
  { name: "Strait of Hormuz", lat: 26.57, lon: 56.25, what: "~20% of world oil" }, { name: "Suez Canal / Bab el-Mandeb", lat: 30.0, lon: 32.55, what: "12% of trade" },
  { name: "Strait of Malacca", lat: 2.5, lon: 101.5, what: "Asia energy corridor" }, { name: "Panama Canal", lat: 9.08, lon: -79.68, what: "5% of trade" },
  { name: "Bosphorus", lat: 41.12, lon: 29.07, what: "Black Sea grain & oil" }, { name: "Taiwan Strait", lat: 24.5, lon: 119.5, what: "semiconductors" },
  { name: "Danish Straits", lat: 55.9, lon: 12.6, what: "Baltic oil" }, { name: "Cape of Good Hope", lat: -34.36, lon: 18.47, what: "Suez bypass" },
];
const REGION = { us: [39, -98], europe: [50, 10], middleeast: [27, 45], gccNews: [24, 52], asia: [30, 105], latam: [-15, -60], africa: [2, 20] } as Record<string, [number, number]>;
function status(ex: typeof EXCHANGES[0]) {
  const now = new Date(); const f = new Intl.DateTimeFormat("en-GB", { timeZone: ex.tz, hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false }).formatToParts(now);
  const hm = `${f.find((p) => p.type === "hour")?.value}:${f.find((p) => p.type === "minute")?.value}`; const wd = f.find((p) => p.type === "weekday")?.value ?? "";
  const weekend = wd === "Sat" || wd === "Sun";
  const open = ex.open <= ex.close ? hm >= ex.open && hm < ex.close : hm >= ex.open || hm < ex.close;
  return { local: hm, open: !weekend && open };
}
let quakeCache: { at: number; items: any[] } | null = null;
export async function GET(request: Request) {
  const base = new URL(request.url).origin;
  let quakes: any[] = quakeCache && Date.now() - quakeCache.at < 10 * 60_000 ? quakeCache.items : [];
  if (!quakes.length) {
    try { const g = await (await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson", { signal: AbortSignal.timeout(12_000), cache: "no-store" })).json();
      quakes = g.features.map((f: any) => ({ mag: f.properties.mag, place: f.properties.place, time: f.properties.time, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] })); quakeCache = { at: Date.now(), items: quakes }; } catch {}
  }
  const regions: any[] = [];
  try {
    const w = await (await fetch(`${base}/api/world?cat=all`, { cache: "no-store" })).json();
    for (const r of Object.keys(REGION)) { const n = (w.catalog ?? {})[r] ?? 0; if (n) regions.push({ id: r, lat: REGION[r][0], lon: REGION[r][1], feeds: n }); }
    for (const r of regions) { try { const c = await (await fetch(`${base}/api/world?cat=${r.id}`, { cache: "no-store" })).json(); r.items = (c.items ?? []).slice(0, 4); r.fresh = (c.items ?? []).filter((x: any) => Date.now() - x.when < 6 * 3600_000).length; } catch { r.items = []; r.fresh = 0; } }
  } catch {}
  return NextResponse.json({ generated: Date.now(), exchanges: EXCHANGES.map((e) => ({ name: e.name, lat: e.lat, lon: e.lon, tz: e.tz, session: `${e.open}–${e.close}`, ...status(e) })), chokepoints: CHOKEPOINTS, quakes, regions });
}
