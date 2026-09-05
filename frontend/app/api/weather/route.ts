import { NextResponse } from "next/server";

/**
 * Weather edge scanner — live Polymarket temperature markets vs live meteorology.
 *
 * Playbook:
 *   Polymarket runs daily "Highest temperature in <City> on <date>?" events with
 *   one market per °C bucket, resolved from a specific airport/observatory station.
 *   Open-Meteo gives free hourly forecast + today's observed hourly temps for any
 *   city. Late in the local day the running max is already locked in — any bucket
 *   the market still prices below ~90¢ that contains the observed max is edge.
 *   Early in the day, the ensemble forecast max ± σ gives a model distribution
 *   over buckets to compare against market prices.
 */

interface Bucket {
  question: string;
  low: number;          // inclusive °C lower bound
  high: number;         // inclusive upper bound
  marketYes: number;
  modelProb: number;
  edge: number;
}

interface CityReport {
  slug: string;
  title: string;
  city: string;
  station: string;
  obsSource: string;            // "metar" (resolution-grade) | "grid"
  metarN: number;               // station readings used today
  gridObserved: number | null;  // grid value kept for comparison
  probSource: string;           // "ensemble" | "gaussian"
  nMembers: number;             // ensemble members used
  forecastMax: number | null;
  observedMax: number | null;   // running max so far today (local)
  hoursElapsed: number;         // local hours into the day
  sigma: number;
  buckets: Bucket[];
  bestPlay: string | null;
  endDate: string | null;
  unit: "C" | "F";
}

// city geocode cache (module-scope, survives across requests in dev)
const geoCache: Record<string, { lat: number; lon: number; tz: string } | null> = {};

// ── STATION-GRADE DATA ────────────────────────────────────────────────────────
// Polymarket resolves on a specific station whose ICAO is embedded in the
// Wunderground URL of every description (e.g. .../LFPB — Paris = Le Bourget!).
// METAR (aviationweather.gov) = the station's actual readings = resolution-grade.
function icaoFromDescription(desc: string): string | null {
  const m = (desc ?? "").match(/wunderground\.com\/history\/daily\/[^\s"']*\/([A-Z0-9]{4})/);
  return m ? m[1] : null;
}

async function metarObservedMax(
  icao: string, eventDate: string, tz: string, isF: boolean,
): Promise<{ max: number | null; n: number }> {
  try {
    const res = await fetch(
      `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=30`,
      { next: { revalidate: 600 } },
    );
    if (!res.ok) return { max: null, n: 0 };
    const obs = await res.json();
    const temps: number[] = [];
    for (const o of obs) {
      const t = o.temp;
      const ts = o.obsTime ?? o.reportTime;
      if (t == null || ts == null) continue;
      const when = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
      const local = when.toLocaleDateString("sv-SE", { timeZone: tz });
      if (local !== eventDate) continue;
      temps.push(isF ? t * 9 / 5 + 32 : t);
    }
    if (!temps.length) return { max: null, n: 0 };
    // Wunderground (the resolution source) rounds to whole degrees
    return { max: Math.round(Math.max(...temps)), n: temps.length };
  } catch {
    return { max: null, n: 0 };
  }
}

async function ensembleMemberMaxes(
  lat: number, lon: number, eventDate: string, nowKey: string, isF: boolean,
): Promise<number[]> {
  try {
    const unit = isF ? "&temperature_unit=fahrenheit" : "";
    const res = await fetch(
      `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${lat}&longitude=${lon}` +
      `&hourly=temperature_2m&models=ecmwf_ifs025,gfs025&forecast_days=3&timezone=auto${unit}`,
      { next: { revalidate: 1800 } },
    );
    if (!res.ok) return [];
    const d = await res.json();
    const h = d.hourly ?? {};
    const times: string[] = h.time ?? [];
    const idx = times.map((t, i) => ({ t, i }))
      .filter(({ t }) => t.startsWith(eventDate) && t.slice(0, 13) > nowKey)
      .map(({ i }) => i);
    if (!idx.length) return [];
    const maxes: number[] = [];
    for (const key of Object.keys(h)) {
      if (!key.startsWith("temperature_2m") || !Array.isArray(h[key])) continue;
      const vals = idx.map((i) => h[key][i]).filter((v: any) => v != null);
      if (vals.length) maxes.push(Math.max(...vals));
    }
    return maxes;
  } catch {
    return [];
  }
}

async function geocode(city: string) {
  if (city in geoCache) return geoCache[city];
  try {
    const res = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      { next: { revalidate: 86400 } },
    );
    const data = await res.json();
    const hit = data?.results?.[0];
    geoCache[city] = hit ? { lat: hit.latitude, lon: hit.longitude, tz: hit.timezone } : null;
  } catch {
    geoCache[city] = null;
  }
  return geoCache[city];
}

function normCdf(x: number): number {
  // Abramowitz-Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (x > 0) p = 1 - p;
  return p;
}

// parse bucket bounds from a question like:
//  "…be 28°C or below…" | "…be 29°C on…" | "…be 34°C or above…"
//  Fahrenheit cities use 2° buckets: "…be between 74-75°F…"
function parseBucket(q: string): { low: number; high: number } | null {
  const range = q.match(/between\s+(-?\d+)\s*-\s*(-?\d+)\s*°/i);
  if (range) return { low: parseInt(range[1]), high: parseInt(range[2]) };
  const deg = q.match(/(-?\d+)\s*°/);
  if (!deg) return null;
  const v = parseInt(deg[1]);
  if (/or below|or lower|or less/i.test(q)) return { low: -999, high: v };
  if (/or above|or higher|or more/i.test(q)) return { low: v, high: 999 };
  return { low: v, high: v };
}

const MONTHS: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

// "highest-temperature-in-los-angeles-on-july-6-2026" → "2026-07-06"
function parseEventDate(slug: string): string | null {
  const m = slug.match(/-on-([a-z]+)-(\d+)-(\d{4})$/);
  if (!m) return null;
  const mo = MONTHS[m[1]];
  if (!mo) return null;
  return `${m[3]}-${String(mo).padStart(2, "0")}-${String(parseInt(m[2])).padStart(2, "0")}`;
}

export async function GET() {
  // 1. Live weather events from Gamma
  let events: any[] = [];
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/events?limit=60&closed=false&tag_slug=weather&order=endDate&ascending=true",
      { cache: "no-store" },
    );
    events = await res.json();
  } catch {
    return NextResponse.json({ error: "gamma fetch failed" }, { status: 502 });
  }

  const tempEvents = events.filter((e) => /highest-temperature-in-/.test(e.slug ?? ""));

  const reports: CityReport[] = [];

  await Promise.all(tempEvents.slice(0, 30).map(async (ev) => {
    const m = ev.slug.match(/highest-temperature-in-(.+?)-on-/);
    if (!m) return;
    const city = m[1].replace(/-/g, " ");
    const eventDate = parseEventDate(ev.slug);
    if (!eventDate) return;
    const isF = (ev.markets ?? []).some((mk: any) => /°F/.test(mk.question ?? ""));

    const geo = await geocode(city);
    if (!geo) return;

    // 2. Live forecast + observed hourlies from Open-Meteo for the EVENT date
    let forecastMax: number | null = null;
    let observedMax: number | null = null;
    let hoursElapsed = 0;
    try {
      const unitParam = isF ? "&temperature_unit=fahrenheit" : "";
      const res = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}` +
        `&hourly=temperature_2m&daily=temperature_2m_max&forecast_days=3&past_days=1&timezone=auto${unitParam}`,
        { next: { revalidate: 600 } },
      );
      const wx = await res.json();

      // find the daily entry matching the event's date
      const dayIdx = (wx?.daily?.time ?? []).indexOf(eventDate);
      if (dayIdx < 0) return;   // event date outside forecast window (stale market)
      forecastMax = wx.daily.temperature_2m_max[dayIdx] ?? null;

      // hourly temps on the event date, split into elapsed vs remaining
      const times: string[] = wx?.hourly?.time ?? [];
      const temps: number[] = wx?.hourly?.temperature_2m ?? [];
      const nowLocal = new Date().toLocaleString("sv-SE", { timeZone: geo.tz }).replace(" ", "T").slice(0, 13);
      let maxSoFar = -Infinity;
      let futureMax = -Infinity;
      let count = 0;
      for (let i = 0; i < times.length; i++) {
        if (times[i].slice(0, 10) !== eventDate) continue;
        if (times[i].slice(0, 13) <= nowLocal) {
          maxSoFar = Math.max(maxSoFar, temps[i]);
          count++;
        } else {
          futureMax = Math.max(futureMax, temps[i]);
        }
      }
      observedMax = count > 0 ? maxSoFar : null;
      hoursElapsed = count;
      // stash remaining-hours forecast peak for the model below
      (geo as any)._futureMax = futureMax > -Infinity ? futureMax : null;
    } catch {}

    if (forecastMax == null) return;

    // 3a. STATION-GRADE observed max — METAR from the actual resolution airport
    const gridObserved = observedMax;
    const icao = icaoFromDescription(ev.description ?? "");
    let obsSource = "grid";
    let metarN = 0;
    if (icao) {
      const m = await metarObservedMax(icao, eventDate, geo.tz, isF);
      if (m.max != null) {
        observedMax = m.max;
        metarN = m.n;
        obsSource = "metar";
      }
    }

    // 3b. Model: ensemble members (ECMWF+GFS) when available, Gaussian fallback
    const futureMax: number | null = (geo as any)._futureMax ?? null;
    const dayComplete = hoursElapsed >= 24 || futureMax == null;
    // METAR = same data Wunderground resolves on → only rounding noise remains
    const stationNoise = obsSource === "metar" ? (isF ? 0.6 : 0.35) : (isF ? 0.9 : 0.5);
    const forecastNoise = isF ? 2.2 : 1.2;

    const nowKey = new Date().toLocaleString("sv-SE", { timeZone: geo.tz }).replace(" ", "T").slice(0, 13);
    let memberMaxes: number[] = [];
    if (!dayComplete) {
      memberMaxes = await ensembleMemberMaxes(geo.lat, geo.lon, eventDate, nowKey, isF);
    }
    const probSource = memberMaxes.length >= 15 ? "ensemble" : "gaussian";

    let center: number;
    let sigma: number;
    if (dayComplete) {
      center = observedMax ?? forecastMax;
      sigma = stationNoise;
    } else if (observedMax != null && observedMax >= futureMax) {
      center = observedMax;
      sigma = stationNoise;
    } else {
      center = Math.max(observedMax ?? -Infinity, futureMax);
      const remainingFrac = Math.max(0.15, Math.min(1, (24 - hoursElapsed) / 24));
      sigma = Math.sqrt(stationNoise ** 2 + (forecastNoise * remainingFrac) ** 2);
    }

    const bucketProb = (lo: number, hi: number): number => {
      if (probSource === "ensemble") {
        // mixture over member day-maxes. A member only pushes the max HIGHER
        // if its remaining-hours peak exceeds the observed station max by ≥1
        // whole degree (Wunderground rounds; sub-degree exceedances are noise —
        // without this, late-day probability leaks above the locked-in max).
        const obs = observedMax ?? -Infinity;
        let acc = 0;
        for (const mm of memberMaxes) {
          const mDay = mm >= obs + 1.0 ? mm : (obs === -Infinity ? mm : obs);
          acc += normCdf((hi - mDay) / stationNoise) - normCdf((lo - mDay) / stationNoise);
        }
        return acc / memberMaxes.length;
      }
      return normCdf((hi - center) / sigma) - normCdf((lo - center) / sigma);
    };

    const buckets: Bucket[] = [];
    for (const mkt of ev.markets ?? []) {
      const b = parseBucket(mkt.question ?? "");
      if (!b) continue;
      let yes = 0.5;
      try { yes = parseFloat(JSON.parse(mkt.outcomePrices)[0]); } catch {}

      let p = bucketProb(b.low - 0.5, b.high + 0.5);
      if (observedMax != null && b.high + 0.5 < observedMax - stationNoise) p = 0;
      p = Math.max(0, Math.min(1, p));

      buckets.push({
        question: mkt.question,
        low: b.low, high: b.high,
        marketYes: yes,
        modelProb: parseFloat(p.toFixed(4)),
        edge: parseFloat((p - yes).toFixed(4)),
      });
    }
    buckets.sort((a, b) => a.low - b.low);

    // Only flag plays on days still in progress — completed days are resolving
    // on official station data and grid disagreement there is noise, not edge.
    // Cities excluded by the 10-day historical backtest (dryrun/weather_backtest.py):
    // chengdu/qingdao/cape town lost consistently (grid-vs-station mismatch).
    const unreliable = ["chengdu", "qingdao", "cape town"].includes(city) && obsSource !== "metar";
    const best = [...buckets].sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge))[0];
    const lateRise = best && observedMax != null && hoursElapsed >= 16 && best.edge > 0 && best.low > observedMax;
    const bestPlay = !dayComplete && !unreliable && !lateRise && best && Math.abs(best.edge) > 0.08
      ? `${best.edge > 0 ? "BUY YES" : "BUY NO"} "${best.question}" — model ${(best.modelProb * 100).toFixed(0)}% vs market ${(best.marketYes * 100).toFixed(0)}¢ (${best.edge > 0 ? "+" : ""}${(best.edge * 100).toFixed(1)}% edge)`
      : null;

    const stationMatch = (ev.description ?? "").match(/recorded (?:at|by) (?:the )?([^,.]+)/i);

    reports.push({
      slug: ev.slug,
      title: ev.title,
      city,
      station: (stationMatch?.[1]?.trim() ?? "official station") + (icao ? ` [${icao}]` : ""),
      obsSource, metarN, gridObserved, probSource,
      nMembers: memberMaxes.length,
      forecastMax, observedMax, hoursElapsed,
      sigma: parseFloat(sigma.toFixed(2)),
      buckets, bestPlay,
      endDate: ev.endDate ?? null,
      unit: isF ? "F" : "C",
    });
  }));

  reports.sort((a, b) => {
    const ae = Math.max(...a.buckets.map((x) => Math.abs(x.edge)), 0);
    const be = Math.max(...b.buckets.map((x) => Math.abs(x.edge)), 0);
    return be - ae;
  });

  return NextResponse.json({ generated: Date.now(), count: reports.length, reports });
}
