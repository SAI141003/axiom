import { NextResponse } from "next/server";
import { cached, UA } from "@/lib/eyeCache";
export const dynamic = "force-dynamic";
// The Space Devs Launch Library 2: the next launches and the last few, with pads.
export async function GET() {
  const c = await cached("ll2", 15 * 60_000, async () => {
    const [up, prev] = await Promise.all(["upcoming", "previous"].map(async (k) => { const r = await fetch(`https://ll.thespacedevs.com/2.3.0/launches/${k}/?limit=15&mode=normal`, { headers: UA, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw new Error(`ll2 ${r.status}`); return (await r.json()).results ?? []; }));
    const map = (l: any, phase: string) => ({ id: l.id, name: l.name, net: l.net, status: l.status?.abbrev, provider: l.launch_service_provider?.name, pad: l.pad?.name, location: l.pad?.location?.name, lat: Number(l.pad?.latitude), lon: Number(l.pad?.longitude), mission: l.mission?.description?.slice(0, 200), phase });
    return [...up.map((l: any) => map(l, "upcoming")), ...prev.map((l: any) => map(l, "recent"))].filter((l) => !isNaN(l.lat));
  });
  return NextResponse.json({ generated: Date.now(), age: c.age, error: c.error, source: "Launch Library 2", items: c.data ?? [] });
}
