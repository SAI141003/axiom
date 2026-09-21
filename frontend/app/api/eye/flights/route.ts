import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";

// Live aircraft. OpenSky's anonymous snapshot for a bounding box (whole world
// when none given), adsb.lol as the fallback when OpenSky is throttled, and
// adsb.lol's military feed as its own layer. Same sources as God's Eye View.
type Ac = { hex: string; call: string; lat: number; lon: number; alt: number; gs: number; hdg: number; src: string; mil?: boolean; type?: string; reg?: string };

async function opensky(bbox?: number[]) {
  const q = bbox ? `?lamin=${bbox[0]}&lomin=${bbox[1]}&lamax=${bbox[2]}&lomax=${bbox[3]}` : "";
  const r = await fetch(`https://opensky-network.org/api/states/all${q}`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`opensky ${r.status}`);
  const d = await r.json();
  return (d.states ?? []).filter((s: any[]) => s[5] != null && s[6] != null && !s[8]).map((s: any[]): Ac => ({ hex: s[0], call: String(s[1] ?? "").trim(), lat: s[6], lon: s[5], alt: s[13] ?? s[7] ?? 0, gs: s[9] ?? 0, hdg: s[10] ?? 0, src: "opensky" }));
}
async function adsblol(path: string, mil = false) {
  const r = await fetch(`https://api.adsb.lol/v2/${path}`, { headers: UA, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`adsb.lol ${r.status}`);
  const d = await r.json();
  return (d.ac ?? []).filter((a: any) => a.lat != null && a.alt_baro !== "ground").map((a: any): Ac => ({ hex: a.hex, call: String(a.flight ?? "").trim(), lat: a.lat, lon: a.lon, alt: (Number(a.alt_baro) || 0) * 0.3048, gs: (a.gs ?? 0) * 0.514, hdg: a.true_heading ?? a.track ?? 0, src: "adsb.lol", mil, type: a.t, reg: a.r }));
}

export async function GET(request: Request) {
  const u = new URL(request.url); const mil = u.searchParams.get("mil") === "1";
  const bbox = u.searchParams.get("bbox")?.split(",").map(Number);
  if (mil) { const c = await cached("mil", 20_000, () => adsblol("mil", true)); return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "adsb.lol military", items: c.data ?? [] }); }
  const key = bbox && bbox.length === 4 ? `os:${bbox.join(",")}` : "os:world";
  const c = await cached(key, 15_000, async () => {
    try { return await opensky(bbox && bbox.length === 4 ? bbox : undefined); }
    catch { if (bbox && bbox.length === 4) { const lat = (bbox[0] + bbox[2]) / 2, lon = (bbox[1] + bbox[3]) / 2; return adsblol(`point/${lat.toFixed(3)}/${lon.toFixed(3)}/250`); } throw new Error("opensky throttled"); }
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: c.data?.[0]?.src ?? "opensky", items: c.data ?? [] });
}
