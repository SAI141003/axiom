"""
Historical weather backtest — scores the weather-edge model against ALREADY
RESOLVED Polymarket temperature markets using ARCHIVED forecasts.

For each resolved "highest-temperature-in-<city>-on-<date>" event (last N days):
  1. archived forecast for that date (historical-forecast-api.open-meteo.com)
  2. model probability per bucket AS OF ~09:00 local (morning mode: observed
     max of first 9 hours is the floor, forecast peak of remaining hours drives)
  3. real market price per bucket at the same decision time (CLOB prices-history)
  4. actual winning bucket from Gamma outcomePrices
  → Brier (model vs market) + paper P&L on >8% edges at $10 stakes.

Only buckets within ±3°(C) / ±4°(F) of the forecast max are priced (the
informative zone) — far buckets are ~0 on both sides and just add API load.

Usage: .venv/bin/python dryrun/weather_backtest.py [days_back=10]
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import aiohttp

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
HIST = "https://historical-forecast-api.open-meteo.com/v1/forecast"
SEM = asyncio.Semaphore(8)
STAKE = 10.0

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june",
     "july", "august", "september", "october", "november", "december"])}
_geo: dict[str, dict | None] = {}


def norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def parse_bucket(q: str):
    r = re.search(r"between\s+(-?\d+)\s*-\s*(-?\d+)\s*°", q, re.I)
    if r:
        return int(r.group(1)), int(r.group(2))
    d = re.search(r"(-?\d+)\s*°", q)
    if not d:
        return None
    v = int(d.group(1))
    if re.search(r"or below|or lower", q, re.I):
        return -999, v
    if re.search(r"or above|or higher", q, re.I):
        return v, 999
    return v, v


def parse_date(slug: str):
    m = re.search(r"-on-([a-z]+)-(\d+)-(\d{4})$", slug)
    if not m or m.group(1) not in MONTHS:
        return None
    return f"{m.group(3)}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}"


async def jget(s, url, **kw):
    async with SEM:
        for _ in range(2):
            try:
                async with s.get(url, timeout=aiohttp.ClientTimeout(total=20), **kw) as r:
                    if r.status == 200:
                        return await r.json()
                    if r.status == 429:
                        await asyncio.sleep(3)
            except Exception:
                await asyncio.sleep(1)
    return None


async def geocode(s, city):
    if city in _geo:
        return _geo[city]
    d = await jget(s, "https://geocoding-api.open-meteo.com/v1/search",
                   params={"name": city, "count": 1})
    hit = (d or {}).get("results", [None])[0] if d else None
    _geo[city] = ({"lat": hit["latitude"], "lon": hit["longitude"], "tz": hit["timezone"]}
                  if hit else None)
    return _geo[city]


async def fetch_events(s, days_back: int):
    events = []
    for offset in range(0, 400, 100):
        d = await jget(s, f"{GAMMA}/events",
                       params={"tag_slug": "weather", "closed": "true", "limit": 100,
                               "offset": offset, "order": "endDate", "ascending": "false"})
        if not d:
            break
        events.extend(d)
        if len(d) < 100:
            break
    cutoff = (datetime.now() - timedelta(days=days_back)).strftime("%Y-%m-%d")
    out = []
    for e in events:
        slug = e.get("slug", "")
        if "highest-temperature-in-" not in slug:
            continue
        date = parse_date(slug)
        if date and date >= cutoff:
            out.append((e, date))
    return out


async def score_event(s, ev, date):
    slug = ev["slug"]
    m = re.match(r"highest-temperature-in-(.+?)-on-", slug)
    if not m:
        return None
    city = m.group(1).replace("-", " ")
    markets = ev.get("markets") or []
    if not markets:
        return None
    is_f = any("°F" in (mk.get("question") or "") for mk in markets)
    geo = await geocode(s, city)
    if not geo:
        return None

    # archived forecast for the event date
    params = {"latitude": geo["lat"], "longitude": geo["lon"],
              "start_date": date, "end_date": date,
              "hourly": "temperature_2m", "daily": "temperature_2m_max",
              "timezone": "auto"}
    if is_f:
        params["temperature_unit"] = "fahrenheit"
    wx = await jget(s, HIST, params=params)
    temps = (wx or {}).get("hourly", {}).get("temperature_2m") or []
    if len(temps) < 20 or any(t is None for t in temps):
        return None

    # morning-mode model as of 09:00 local (matches live scanner at 9h elapsed)
    observed = max(temps[:9])
    future = max(temps[9:])
    station_noise = 0.9 if is_f else 0.5
    forecast_noise = 2.2 if is_f else 1.2
    if observed >= future:
        center, sigma = observed, station_noise
    else:
        center = future
        rem = (24 - 9) / 24
        sigma = math.sqrt(station_noise ** 2 + (forecast_noise * rem) ** 2)

    # decision timestamp: 09:00 local → UTC
    try:
        dt = datetime.fromisoformat(f"{date}T09:00:00").replace(tzinfo=ZoneInfo(geo["tz"]))
        decision_ts = int(dt.timestamp())
    except Exception:
        return None

    # winning bucket + informative zone
    zone = 4 if is_f else 3
    rows = []
    for mk in markets:
        b = parse_bucket(mk.get("question") or "")
        if not b:
            continue
        try:
            won = float(json.loads(mk["outcomePrices"])[0]) > 0.5
        except Exception:
            continue
        # keep bucket if near forecast center OR it's the actual winner
        near = (b[0] - zone <= center <= b[1] + zone) or \
               (abs(b[0] - center) <= zone or abs(b[1] - center) <= zone)
        if not (near or won):
            continue
        try:
            token = json.loads(mk["clobTokenIds"])[0]
        except Exception:
            continue
        hist = await jget(s, f"{CLOB}/prices-history",
                          params={"market": token, "startTs": decision_ts - 5400,
                                  "endTs": decision_ts + 10800, "fidelity": 60})
        pts = (hist or {}).get("history") or []
        if not pts:
            continue
        market_p = float(pts[0]["p"])
        lo, hi = b[0] - 0.5, b[1] + 0.5
        p = norm_cdf((hi - center) / sigma) - norm_cdf((lo - center) / sigma)
        if b[1] + 0.5 < observed - station_noise:
            p = 0.0
        rows.append({"low": b[0], "high": b[1], "model": max(0.0, min(1.0, p)),
                     "market": market_p, "won": won})
    if len(rows) < 3:
        return None
    return {"slug": slug, "city": city, "date": date, "unit": "F" if is_f else "C",
            "center": center, "sigma": sigma, "buckets": rows}


async def main(days_back: int = 10):
    async with aiohttp.ClientSession() as s:
        pairs = await fetch_events(s, days_back)
        print(f"Resolved temperature events (last {days_back}d): {len(pairs)} — scoring…")
        results = []
        for ev, date in pairs:
            r = await score_event(s, ev, date)
            if r:
                results.append(r)

    n_b = 0
    mb = kb = 0.0
    edge_tot = edge_hit = 0
    pnl = 0.0
    per_city: dict[str, list[float]] = {}
    for r in results:
        for b in r["buckets"]:
            actual = 1.0 if b["won"] else 0.0
            mb += (b["model"] - actual) ** 2
            kb += (b["market"] - actual) ** 2
            n_b += 1
            edge = b["model"] - b["market"]
            if abs(edge) > 0.08 and 0.02 < b["market"] < 0.98:
                edge_tot += 1
                hit = (edge > 0) == b["won"]
                edge_hit += int(hit)
                if edge > 0:
                    p = STAKE * (1 / b["market"] - 1) if b["won"] else -STAKE
                else:
                    p = STAKE * (1 / (1 - b["market"]) - 1) if not b["won"] else -STAKE
                pnl += p
                per_city.setdefault(r["city"], []).append(p)

    print(f"\n{'='*70}")
    print(f"WEATHER MODEL HISTORICAL BACKTEST — decision time 09:00 local")
    print(f"{'='*70}")
    print(f"Events scored: {len(results)}   buckets priced: {n_b}")
    if n_b:
        print(f"Brier — model: {mb/n_b:.4f}   market: {kb/n_b:.4f}   "
              f"→ {'MODEL BEATS MARKET ✓' if mb < kb else 'market better ✗'}")
    if edge_tot:
        print(f"Edge plays (>8%, mkt 2-98¢): {edge_tot}  hit {edge_hit} "
              f"({100*edge_hit/edge_tot:.0f}%)  paper P&L ${pnl:+.2f} "
              f"({100*pnl/(edge_tot*STAKE):+.1f}% ROI)")
        top = sorted(per_city.items(), key=lambda kv: -sum(kv[1]))[:5]
        bot = sorted(per_city.items(), key=lambda kv: sum(kv[1]))[:3]
        print("  best cities:", ", ".join(f"{c} ${sum(v):+.0f}" for c, v in top))
        print("  worst cities:", ", ".join(f"{c} ${sum(v):+.0f}" for c, v in bot))


if __name__ == "__main__":
    asyncio.run(main(int(sys.argv[1]) if len(sys.argv) > 1 else 10))
