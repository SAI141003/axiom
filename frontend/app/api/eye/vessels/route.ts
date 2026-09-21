import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
// AISStream (free key): a server-side WebSocket subscriber keeps the last
// position of every vessel heard; this route hands out the snapshot.
const positions = new Map<string, any>();
let sock: any = null, started = 0, err = "";
function start(key: string) {
  if (sock || Date.now() - started < 30_000) return; started = Date.now();
  try {
    const ws = new (globalThis as any).WebSocket("wss://stream.aisstream.io/v0/stream"); sock = ws;
    ws.onopen = () => ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[-90, -180], [90, 180]]], FilterMessageTypes: ["PositionReport"] }));
    ws.onmessage = (ev: any) => { try { const m = JSON.parse(ev.data); const p = m.Message?.PositionReport; const meta = m.MetaData; if (p && meta) positions.set(String(meta.MMSI), { mmsi: meta.MMSI, name: String(meta.ShipName ?? "").trim(), lat: p.Latitude, lon: p.Longitude, sog: p.Sog, cog: p.Cog, ts: Date.now() }); if (positions.size > 60_000) { const old = [...positions.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 10_000); for (const [k] of old) positions.delete(k); } } catch {} };
    ws.onerror = (e: any) => { err = String(e?.message ?? "ws error"); };
    ws.onclose = () => { sock = null; };
  } catch (e: any) { err = String(e?.message ?? e); sock = null; }
}
export async function GET() {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) return NextResponse.json({ generated: Date.now(), configured: false, source: "AISStream", note: "set AISSTREAM_API_KEY (free at aisstream.io)", items: [] });
  start(key);
  const cutoff = Date.now() - 20 * 60_000;
  return NextResponse.json({ generated: Date.now(), configured: true, connected: !!sock, error: err || undefined, source: "AISStream (20 min)", items: [...positions.values()].filter((v) => v.ts > cutoff) });
}
