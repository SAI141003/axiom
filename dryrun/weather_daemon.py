"""
Weather edge DRY-RUN daemon — snapshots model-vs-market every 30 min, then
scores both against the actual resolved bucket. No orders.

Record types (logs/dryrun_weather.jsonl):
  {"type":"snapshot", slug, city, unit, event_date, hours_elapsed, observed_max,
   forecast_max, center, sigma, day_complete,
   buckets:[{q, low, high, market, model}], best_edge, ts}
  {"type":"resolve", slug, winning_bucket_q, winning_low, winning_high, ts}

Analyzer joins the LAST pre-resolution snapshot per event and compares Brier
scores: model vs market. If model Brier < market Brier, the edge is real.

Run:  nohup .venv/bin/python dryrun/weather_daemon.py >> logs/weather_daemon.log 2>&1 &
"""
from __future__ import annotations

import asyncio
import json
import math
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import aiohttp

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from tuned import tuned as _tuned          # live auto-tuner knob reads

GAMMA = "https://gamma-api.polymarket.com"
# Distrust the overconfident model: skip trades where |model−market| exceeds
# this. Measured — the model's big disagreements are anti-predictive (Brier
# 0.388). Robust across 0.15–0.25 (−$103 → +$270+ on the recent sample), but
# 2nd-half stability is weak, so the learner should keep validating it.
# 245-trade autopsy (2026-07-24): the raw book was 41%/−$220, and the old
# 0.20/0.50 gates still leaked. Only ONE config is positive in BOTH halves:
# |edge| ≤ 0.15 AND entry ≥ 0.70 → 89% (17/19), +$26 (H1 +$12 / H2 +$14).
# WHY: |edge|>0.15 is anti-predictive (big model-vs-market gaps: −$124/−$95/−$158
# by bucket — the model is wrong exactly when it's most confident), and only
# strong favorites (≥0.70) clear the fee at these small per-trade payoffs.
EDGE_CAP = 0.15          # tightened from 0.20 — |edge| 0.15-0.20 lost −$124
ENTRY_MIN = 0.70         # raised from 0.50 — only strong favorites are +EV both halves
# LATE-DAY ONLY: after ~14h local the day's max is substantially OBSERVED —
# we're betting with near-locked physical reality while the market still
# prices residual uncertainty. Measured: h≥14 favorites 73% win (+$),
# h<14 favorites 50-56% win (−$). Early = forecasting (we lose);
# late = observing (we win).
HOUR_MIN = 14
LOG = Path(__file__).resolve().parent.parent / "logs" / "dryrun_weather.jsonl"
SCAN_INTERVAL_S = 1800

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june",
     "july", "august", "september", "october", "november", "december"])}

_geo: dict[str, dict | None] = {}
_seen_resolved: set[str] = set()
_placed_trades: set[str] = set()

# Baseline exclusions (10-day historical backtest); the nightly learner
# (dryrun/learner.py → .data/params_weather.json) overrides these with
# stability-tested per-city results as forward data accumulates.
UNRELIABLE_CITIES = {"chengdu", "qingdao", "cape town"}
_WPARAMS = Path(__file__).resolve().parent.parent / ".data" / "params_weather.json"


def learned_weather_params() -> tuple[set[str], float]:
    """(disabled_cities, min_flag_edge) — learner output, defaults if absent."""
    try:
        p = json.loads(_WPARAMS.read_text())["params"]
        return set(p.get("disabled_cities", [])), float(p.get("min_flag_edge", 0.08))
    except Exception:
        return UNRELIABLE_CITIES, 0.08

# ── STATION-GRADE DATA ────────────────────────────────────────────────────────
# Polymarket resolves each city on a SPECIFIC station (from event descriptions)
# — almost always an airport. METAR gives the station's ACTUAL readings
# (aviationweather.gov, free) = resolution-grade observed max, eliminating the
# ~1° grid-vs-station error that was our biggest loss source.
CITY_ICAO = {
    "nyc": "KLGA", "los angeles": "KLAX", "san francisco": "KSFO",
    "seattle": "KSEA", "miami": "KMIA", "chicago": "KORD", "atlanta": "KATL",
    "dallas": "KDAL", "austin": "KAUS", "houston": "KHOU", "denver": "KBKF",
    "london": "EGLC", "paris": "LFPB", "amsterdam": "EHAM", "madrid": "LEMD",
    "warsaw": "EPWA", "toronto": "CYYZ", "mexico city": "MMMX",
    "sao paulo": "SBGR", "panama city": "MPMG", "buenos aires": "SAEZ",
    "seoul": "RKSI", "tokyo": "RJTT", "shanghai": "ZSPD", "qingdao": "ZSQD",
    "jinan": "ZSJN", "zhengzhou": "ZHCC", "chongqing": "ZUCK",
    "taipei": "RCSS", "singapore": "WSSS", "jeddah": "OEJN",
    "lucknow": "VILK", "wellington": "NZWN", "sydney": "YSSY",
    # hong kong resolves on HK Observatory (not an airport) — grid fallback
}


def icao_from_description(desc: str) -> str | None:
    """
    The exact resolution station's ICAO is embedded in the Wunderground URL in
    every market description (e.g. .../history/daily/fr/bonneuil-en-france/LFPB).
    Ground truth — beats any hand-made map (Paris is LFPB Le Bourget, not CDG!).
    """
    m = re.search(r"wunderground\.com/history/daily/[^\s\"']*/([A-Z0-9]{4})", desc or "")
    return m.group(1) if m else None


async def metar_observed_max(s: aiohttp.ClientSession, icao: str,
                             event_date: str, tz: str, is_f: bool):
    """True observed max at the RESOLUTION station for the event's local date."""
    import zoneinfo
    d = await jget(s, "https://aviationweather.gov/api/data/metar",
                   params={"ids": icao, "format": "json", "hours": 30})
    if not d:
        return None, 0
    z = zoneinfo.ZoneInfo(tz)
    temps = []
    for o in d:
        t = o.get("temp")
        ts = o.get("obsTime") or o.get("reportTime")
        if t is None or ts is None:
            continue
        try:
            when = (datetime.fromtimestamp(ts, timezone.utc) if isinstance(ts, (int, float))
                    else datetime.fromisoformat(str(ts).replace("Z", "+00:00")))
            if when.astimezone(z).strftime("%Y-%m-%d") != event_date:
                continue
        except Exception:
            continue
        temps.append(t * 9 / 5 + 32 if is_f else t)
    if not temps:
        return None, 0
    # Wunderground (the official resolution source) rounds to whole degrees
    return float(round(max(temps))), len(temps)


async def ensemble_member_maxes(s: aiohttp.ClientSession, lat: float, lon: float,
                                event_date: str, now_key: str, is_f: bool):
    """
    Per-member forecast peak of the REMAINING hours of the event date, from
    ECMWF + GFS ensembles (~80 members) — a real probability distribution
    instead of a Gaussian guess.
    """
    params = {"latitude": lat, "longitude": lon, "hourly": "temperature_2m",
              "models": "ecmwf_ifs025,gfs025", "forecast_days": 3, "timezone": "auto"}
    if is_f:
        params["temperature_unit"] = "fahrenheit"
    d = await jget(s, "https://ensemble-api.open-meteo.com/v1/ensemble", params=params)
    h = (d or {}).get("hourly") or {}
    times = h.get("time") or []
    idx = [i for i, t in enumerate(times)
           if t.startswith(event_date) and t[:13] > now_key]
    if not idx:
        return []
    maxes = []
    for key, vals in h.items():
        if not key.startswith("temperature_2m") or not isinstance(vals, list):
            continue
        member = [vals[i] for i in idx if i < len(vals) and vals[i] is not None]
        if member:
            maxes.append(max(member))
    return maxes


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


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
    if re.search(r"or below|or lower|or less", q, re.I):
        return -999, v
    if re.search(r"or above|or higher|or more", q, re.I):
        return v, 999
    return v, v


def parse_event_date(slug: str):
    m = re.search(r"-on-([a-z]+)-(\d+)-(\d{4})$", slug)
    if not m or m.group(1) not in MONTHS:
        return None
    return f"{m.group(3)}-{MONTHS[m.group(1)]:02d}-{int(m.group(2)):02d}"


async def jget(s: aiohttp.ClientSession, url: str, **kw):
    try:
        async with s.get(url, timeout=aiohttp.ClientTimeout(total=15), **kw) as r:
            if r.status == 200:
                return await r.json()
    except Exception:
        pass
    return None


async def geocode(s: aiohttp.ClientSession, city: str):
    if city in _geo:
        return _geo[city]
    d = await jget(s, "https://geocoding-api.open-meteo.com/v1/search",
                   params={"name": city, "count": 1})
    hit = (d or {}).get("results", [None])[0] if d else None
    _geo[city] = ({"lat": hit["latitude"], "lon": hit["longitude"], "tz": hit["timezone"]}
                  if hit else None)
    return _geo[city]


async def scan_once(s: aiohttp.ClientSession) -> int:
    # limit=100 (was 25): there are ~100 open weather events but only 25 were
    # scanned — 75% of the universe unseen. Cities span timezones, so events
    # already late-day/observed (0.70+ favorites) routinely fell outside the
    # 25 soonest-ending. Same entry≥0.70/edge≤0.15 gate filters them → pure
    # frequency, zero edge dilution (the extra niche markets fit the thesis).
    events = await jget(s, f"{GAMMA}/events",
                        params={"limit": 100, "closed": "false", "tag_slug": "weather",
                                "order": "endDate", "ascending": "true"})
    if not events:
        return 0
    n = 0
    for ev in events:
        slug = ev.get("slug", "")
        m = re.match(r"highest-temperature-in-(.+?)-on-", slug)
        if not m:
            continue
        city = m.group(1).replace("-", " ")
        event_date = parse_event_date(slug)
        if not event_date:
            continue
        markets = ev.get("markets") or []
        is_f = any("°F" in (mk.get("question") or "") for mk in markets)
        geo = await geocode(s, city)
        if not geo:
            continue

        params = {"latitude": geo["lat"], "longitude": geo["lon"],
                  "hourly": "temperature_2m", "daily": "temperature_2m_max",
                  "forecast_days": 3, "past_days": 1, "timezone": "auto"}
        if is_f:
            params["temperature_unit"] = "fahrenheit"
        wx = await jget(s, "https://api.open-meteo.com/v1/forecast", params=params)
        if not wx:
            continue
        daily_times = wx.get("daily", {}).get("time", [])
        if event_date not in daily_times:
            continue
        forecast_max = wx["daily"]["temperature_2m_max"][daily_times.index(event_date)]
        if forecast_max is None:
            continue

        now_local = datetime.now(timezone.utc).astimezone().astimezone()  # placeholder
        # city-local "now" via tz database name
        import zoneinfo
        now_city = datetime.now(zoneinfo.ZoneInfo(geo["tz"]))
        now_key = now_city.strftime("%Y-%m-%dT%H")

        obs_max, fut_max, count = -1e9, -1e9, 0
        for t, temp in zip(wx["hourly"]["time"], wx["hourly"]["temperature_2m"]):
            if temp is None or not t.startswith(event_date):
                continue
            if t[:13] <= now_key:
                obs_max = max(obs_max, temp)
                count += 1
            else:
                fut_max = max(fut_max, temp)
        grid_observed = obs_max if count else None
        future_max = fut_max if fut_max > -1e9 else None

        # ── STATION-GRADE observed max (METAR from the resolution airport) ──
        icao = icao_from_description(ev.get("description") or "") or CITY_ICAO.get(city)
        metar_max = metar_n = None
        if icao:
            metar_max, metar_n = await metar_observed_max(s, icao, event_date, geo["tz"], is_f)
        obs_source = "metar" if metar_max is not None else "grid"
        observed_max = metar_max if metar_max is not None else grid_observed
        # METAR = the same data Wunderground shows → only rounding noise left
        station_noise = (0.6 if is_f else 0.35) if obs_source == "metar" else (0.9 if is_f else 0.5)
        forecast_noise = 2.2 if is_f else 1.2

        day_complete = count >= 24 or future_max is None

        # ── ENSEMBLE bucket probabilities (ECMWF+GFS members) ────────────────
        member_maxes: list[float] = []
        if not day_complete:
            member_maxes = await ensemble_member_maxes(
                s, geo["lat"], geo["lon"], event_date, now_key, is_f)
        prob_source = "ensemble" if len(member_maxes) >= 15 else "gaussian"

        # Gaussian fallback parameters (also used for center/sigma reporting)
        if day_complete:
            center, sigma = (observed_max if observed_max is not None else forecast_max), station_noise
        elif observed_max is not None and future_max is not None and observed_max >= future_max:
            center, sigma = observed_max, station_noise
        else:
            center = max(observed_max if observed_max is not None else -1e9, future_max or -1e9)
            rem = max(0.15, min(1.0, (24 - count) / 24))
            sigma = math.sqrt(station_noise ** 2 + (forecast_noise * rem) ** 2)

        def bucket_prob(lo: float, hi: float) -> float:
            if prob_source == "ensemble":
                # mixture over member day-maxes. CRITICAL: a member only counts
                # as pushing the max HIGHER if its remaining-hours peak exceeds
                # the observed station max by ≥1 whole degree — Wunderground
                # rounds to whole degrees, and sub-degree "exceedances" are
                # forecast noise. Without this, late-day probability leaks into
                # higher buckets after the real peak passed (gap-test round 1:
                # 10/12 losses were NO bets against the locked-in max bucket).
                obs = observed_max if observed_max is not None else -1e9
                acc = 0.0
                for mm in member_maxes:
                    m_day = mm if mm >= obs + 1.0 else obs
                    if m_day < -1e8:
                        m_day = mm
                    acc += (norm_cdf((hi - m_day) / station_noise)
                            - norm_cdf((lo - m_day) / station_noise))
                return acc / len(member_maxes)
            return norm_cdf((hi - center) / sigma) - norm_cdf((lo - center) / sigma)

        buckets = []
        for mk in markets:
            b = parse_bucket(mk.get("question") or "")
            if not b:
                continue
            try:
                yes = float(json.loads(mk["outcomePrices"])[0])
            except Exception:
                yes = 0.5
            p = bucket_prob(b[0] - 0.5, b[1] + 0.5)
            # dead-bucket: with METAR the observed max IS resolution data — only
            # rounding margin needed; with grid keep the wider safety margin
            if observed_max is not None and b[1] + 0.5 < observed_max - station_noise:
                p = 0.0
            try:
                toks = json.loads(mk.get("clobTokenIds") or "[]")
            except Exception:
                toks = []
            buckets.append({"q": mk.get("question"), "low": b[0], "high": b[1],
                            "market": yes, "model": round(max(0.0, min(1.0, p)), 4),
                            "toks": toks})
        if not buckets:
            continue
        disabled_cities, min_flag_edge = learned_weather_params()
        best_edge = max((abs(b["model"] - b["market"]) for b in buckets), default=0.0)
        if best_edge < min_flag_edge:
            best_edge = 0.0
        if city in disabled_cities and obs_source != "metar":
            best_edge = 0.0   # learner-disabled, only while stuck on grid data

        # ── master switch: skip trading when the weather bot is turned off ──
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).resolve().parent))
        from bot_switch import bot_enabled
        _weather_on = bot_enabled("weather")

        # ── LIVE PAPER TRADE on the flagged edge (gap measurement) ────────────
        # One trade per slug+bucket+side; entry = the real market price at this
        # moment. Resolution joins the winning bucket → exact model-vs-market gap.
        if best_edge > 0 and not day_complete and _weather_on:
            bb = max(buckets, key=lambda b: abs(b["model"] - b["market"]))
            edge = bb["model"] - bb["market"]
            # EDGE CAP (measured, not assumed): backtest showed the model's LARGE
            # disagreements are anti-predictive — when it screams the market is
            # very wrong, the market is right (Brier 0.388 = overconfident). Only
            # act on MODERATE edges; skip the toxic overconfident tail.
            if abs(edge) > _tuned("weather", "EDGE_CAP", EDGE_CAP):
                bb = None
            elif 0.02 < bb["market"] < 0.98:
                side = "YES" if edge > 0 else "NO"
                # guard 1: after 14h local the observed max is essentially
                # locked — never bet NO against the bucket that contains it
                if (side == "NO" and observed_max is not None and count >= 14
                        and bb["low"] - 0.5 <= observed_max <= bb["high"] + 0.5):
                    bb = None
                # guard 2: NO below 15¢ = fighting near-certainty for pennies
                elif side == "NO" and (1 - bb["market"]) < 0.15:
                    bb = None
                # guard 3: don't bet YES on a bucket ABOVE the observed max after
                # ~16h local — the daily peak is behind us and temps fall in the
                # evening; betting a late rise is the mirror of the guard-1 error.
                elif (side == "YES" and observed_max is not None and count >= 16
                      and bb["low"] > observed_max):
                    bb = None
            else:
                bb = None
            if bb is not None:
                entry_px = bb["market"] if side == "YES" else round(1 - bb["market"], 4)
                if entry_px < _tuned("weather", "ENTRY_MIN", ENTRY_MIN):  # auto-tuner
                    bb = None
                elif count < HOUR_MIN:        # late-day only: observe, don't forecast
                    bb = None
            if bb is not None:
                tid = f"{slug}|{bb['low']}|{bb['high']}|{side}"
                if tid not in _placed_trades:
                    _placed_trades.add(tid)
                    entry = entry_px
                    log_write({"type": "wtrade", "tid": tid, "slug": slug,
                               "city": city, "q": bb["q"], "low": bb["low"],
                               "high": bb["high"], "side": side, "entry": entry,
                               "model": bb["model"], "market": bb["market"],
                               "edge": round(edge, 4), "stake": 10.0,
                               "obs_source": obs_source, "prob_source": prob_source,
                               "hours_elapsed": count, "ts": int(time.time())})
                    print(f"[weather-daemon] TRADE {city} {side} '{bb['q'][:40]}' "
                          f"@ {entry} (edge {edge:+.2f})", flush=True)
                    try:
                        import sys as _sys
                        _sys.path.insert(0, str(Path(__file__).resolve().parent))
                        from live_micro import live_config, place_micro_buy
                        toks = bb.get("toks") or []
                        if live_config()[0] and len(toks) == 2:
                            tok = toks[0] if side == "YES" else toks[1]
                            place_micro_buy("weather", tok, f"{city} {side} {bb['low']}-{bb['high']}", entry)
                    except Exception as exc:
                        print(f"[weather-daemon] live-micro error: {exc}", flush=True)
        log_write({"type": "snapshot", "slug": slug, "city": city,
                   "unit": "F" if is_f else "C", "event_date": event_date,
                   "hours_elapsed": count, "observed_max": observed_max,
                   "grid_observed": grid_observed, "forecast_max": forecast_max,
                   "icao": icao, "obs_source": obs_source, "metar_n": metar_n,
                   "prob_source": prob_source, "n_members": len(member_maxes),
                   "center": round(center, 2), "sigma": round(sigma, 3),
                   "day_complete": day_complete,
                   "buckets": buckets, "best_edge": round(best_edge, 4),
                   "ts": int(time.time())})
        n += 1
    return n


async def resolve_pass(s: aiohttp.ClientSession) -> int:
    """Find resolved events we snapshotted and record the winning bucket."""
    if not LOG.exists():
        return 0
    slugs = set()
    for line in LOG.open():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r["type"] == "snapshot":
            slugs.add(r["slug"])
        elif r["type"] == "resolve":
            _seen_resolved.add(r["slug"])
    n = 0
    for slug in slugs - _seen_resolved:
        ev = await jget(s, f"{GAMMA}/events", params={"slug": slug})
        if not ev:
            continue
        markets = ev[0].get("markets") or []
        if not markets or not all(m.get("closed") for m in markets):
            continue
        winner = None
        for mk in markets:
            try:
                if float(json.loads(mk["outcomePrices"])[0]) > 0.5:
                    winner = mk
                    break
            except Exception:
                pass
        if winner is None:
            continue
        b = parse_bucket(winner.get("question") or "") or (None, None)
        log_write({"type": "resolve", "slug": slug,
                   "winning_bucket_q": winner.get("question"),
                   "winning_low": b[0], "winning_high": b[1],
                   "ts": int(time.time())})
        _seen_resolved.add(slug)
        n += 1
    return n


def _load_placed() -> None:
    if not LOG.exists():
        return
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r.get("type") == "wtrade":
                _placed_trades.add(r["tid"])
        except Exception:
            pass


async def main() -> None:
    print(f"[weather-daemon] started — logging to {LOG}", flush=True)
    _load_placed()
    async with aiohttp.ClientSession() as s:
        while True:
            try:
                n_snap = await scan_once(s)
                n_res = await resolve_pass(s)
                print(f"[weather-daemon] {time.strftime('%H:%M')} snapshots={n_snap} resolved={n_res}",
                      flush=True)
            except Exception as exc:
                print(f"[weather-daemon] scan error: {exc}", flush=True)
            await asyncio.sleep(SCAN_INTERVAL_S)


if __name__ == "__main__":
    asyncio.run(main())
