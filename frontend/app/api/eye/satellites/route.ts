import { NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { cached, UA } from "@/lib/eyeCache";
const DISK = path.join(process.cwd(), "..", ".data", "eye_tle.json");   // last good elements survive a restart and a CelesTrak outage
export const dynamic = "force-dynamic";
// CelesTrak GP elements for the groups that matter to a desk: the stations,
// GPS, weather birds, the brightest. Propagated client-side with SGP4
// (satellite.js), exactly as God's Eye View does. Elements refresh every 2h.
const GROUPS = ["stations", "gps-ops", "weather", "visual", "science", "geo"];
export async function GET() {
  const c = await cached("tle", 2 * 3600_000, async () => {
    const all: any[] = []; let okGroups = 0;
    for (const g of GROUPS) {
      for (const host of ["celestrak.org", "celestrak.com"]) {
        try { const r = await fetch(`https://${host}/NORAD/elements/gp.php?GROUP=${g}&FORMAT=json`, { headers: UA, signal: AbortSignal.timeout(20_000) }); if (!r.ok) continue; for (const s of await r.json()) all.push({ ...s, group: g }); okGroups++; break; } catch {}
      }
    }
    if (!okGroups) throw new Error("CelesTrak unreachable");
    const seen = new Set<number>();
    const items = all.filter((s) => !seen.has(s.NORAD_CAT_ID) && seen.add(s.NORAD_CAT_ID));
    fs.writeFile(DISK, JSON.stringify({ at: Date.now(), items })).catch(() => {});
    return items;
  });
  let items = c.data ?? [], age = c.age, note: string | undefined;
  if (!items.length) { try { const d = JSON.parse(await fs.readFile(DISK, "utf-8")); items = d.items ?? []; age = Date.now() - d.at; note = "CelesTrak down — last good elements from disk"; } catch {} }
  return NextResponse.json({ generated: Date.now(), age, error: c.error, note, source: "CelesTrak", items });
}
