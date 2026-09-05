"""
Pre-market style FORWARD-TEST daemon — backtests the user's live strategy
($1,000 · under-$10 stocks · first-20-minutes exits) against real market data,
every trading day, automatically.

Daily cycle (all times ET):
  09:10  hit the local scanner API (/api/premarket) → log top-5 picks with plans
  10:05  fetch real 1-min candles for each pick → simulate the plan exactly:
         entry = 09:30 open, then first touch of target/stop wins (1m bars),
         else exit at the 09:50 close. Log per-pick P&L.

Records (logs/dryrun_premarket.jsonl):
  {"type":"pick", date, symbol, direction, shares, entry, target, stop, score, ts}
  {"type":"outcome", date, symbol, open_px, px_0950, hit, pnl, ts}

Run:  launchd com.polymarket.dryrun.premarket (KeepAlive)
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_premarket.jsonl"
SCANNER = "http://localhost:3000/api/premarket?budget=1000"
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}
TOP_N = 5


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def _logged(date: str, typ: str) -> set[str]:
    out = set()
    if LOG.exists():
        for line in LOG.open():
            try:
                r = json.loads(line)
                if r.get("date") == date and r.get("type") == typ:
                    out.add(r["symbol"])
            except Exception:
                pass
    return out


async def jget(s: aiohttp.ClientSession, url: str, **kw):
    for _ in range(3):
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=30), **kw) as r:
                if r.status == 200:
                    return await r.json()
        except Exception:
            await asyncio.sleep(3)
    return None


async def sweep_feature(s: aiohttp.ClientSession, sym: str) -> dict | None:
    """Liquidity-sweep detector (SMC): did premarket action sweep the PRIOR
    day's high/low and reclaim it? A sweep+reclaim marks a stop-hunt reversal
    level — logged as a feature so the meta-label can learn if it predicts.
    """
    try:
        d = await jget(s, "https://query1.finance.yahoo.com/v8/finance/chart/"
                          f"{sym}?range=2d&interval=1d&includePrePost=true")
        res = d["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        if len(q["high"]) < 2:
            return None
        prior_h, prior_l = q["high"][0], q["low"][0]
        meta = res["meta"]
        pre_h = meta.get("regularMarketDayHigh") or q["high"][1]
        pre_l = meta.get("regularMarketDayLow") or q["low"][1]
        px = meta.get("regularMarketPrice")
        if None in (prior_h, prior_l, pre_h, pre_l, px):
            return None
        return {
            "swept_low": bool(pre_l < prior_l and px > prior_l),   # hunt + reclaim
            "swept_high": bool(pre_h > prior_h and px < prior_h),
            "prior_high": round(prior_h, 4), "prior_low": round(prior_l, 4),
        }
    except Exception:
        return None


async def snapshot_picks(s: aiohttp.ClientSession, date: str) -> None:
    if _logged(date, "pick"):
        return
    d = await jget(s, SCANNER)
    if not d or not d.get("results"):
        print(f"[premarket-daemon] {date}: scanner returned nothing", flush=True)
        return
    for r in d["results"][:TOP_N]:
        p = r["plan"]
        sweep = await sweep_feature(s, r["symbol"])
        log_write({"type": "pick", "date": date, "symbol": r["symbol"],
                   "direction": p["direction"], "shares": p["shares"],
                   "entry": p["entry"], "target": p["target"], "stop": p["stop"],
                   "score": r["styleScore"], "gap_pct": r["gapPct"],
                   "sweep": sweep,
                   "ts": int(time.time())})
    print(f"[premarket-daemon] {date}: logged {min(TOP_N, len(d['results']))} picks", flush=True)


async def score_picks(s: aiohttp.ClientSession, date: str) -> None:
    picks = []
    if LOG.exists():
        for line in LOG.open():
            try:
                r = json.loads(line)
                if r.get("type") == "pick" and r.get("date") == date:
                    picks.append(r)
            except Exception:
                pass
    done = _logged(date, "outcome")
    for p in picks:
        if p["symbol"] in done:
            continue
        d = await jget(
            s, f"https://query1.finance.yahoo.com/v8/finance/chart/{p['symbol']}"
               f"?range=1d&interval=1m",
            headers=UA,
        )
        res = (d or {}).get("chart", {}).get("result", [None])[0]
        if not res or not res.get("timestamp"):
            continue
        q = res["indicators"]["quote"][0]
        # candles between 09:30 and 09:50 ET
        window = []
        for i, ts in enumerate(res["timestamp"]):
            t = datetime.fromtimestamp(ts, ET)
            if t.hour == 9 and 30 <= t.minute < 50 and q["open"][i] is not None:
                window.append((q["open"][i], q["high"][i], q["low"][i], q["close"][i]))
        if len(window) < 5:
            continue
        open_px = window[0][0]
        px_0950 = window[-1][3]
        long = p["direction"] == "LONG"
        # re-anchor target/stop to the REAL open (plan was set pre-market),
        # scaled by the learner's R-asymmetry params (target 1.6× / stop 0.8×
        # = 2R shape; the daemon previously ignored these entirely)
        try:
            _p = json.loads((ROOT / ".data" / "params_premarket.json").read_text())["params"]
            tm, sm = float(_p.get("target_mult", 1.6)), float(_p.get("stop_mult", 0.8))
        except Exception:
            tm, sm = 1.6, 0.8
        tgt_off = abs(p["target"] - p["entry"]) * tm
        stp_off = abs(p["entry"] - p["stop"]) * sm
        target = open_px + tgt_off if long else open_px - tgt_off
        stop = open_px - stp_off if long else open_px + stp_off
        hit = "time_exit"
        exit_px = px_0950
        for (_, h, l, _c) in window:
            if long and h >= target: hit, exit_px = "target", target; break
            if long and l <= stop:   hit, exit_px = "stop", stop; break
            if not long and l <= target: hit, exit_px = "target", target; break
            if not long and h >= stop:   hit, exit_px = "stop", stop; break
        pnl = round((exit_px - open_px) * p["shares"] * (1 if long else -1), 2)
        log_write({"type": "outcome", "date": date, "symbol": p["symbol"],
                   "open_px": round(open_px, 4), "px_0950": round(px_0950, 4),
                   "hit": hit, "pnl": pnl, "ts": int(time.time())})
        print(f"[premarket-daemon] {date} {p['symbol']}: {hit} pnl={pnl:+.2f}", flush=True)


async def main() -> None:
    print(f"[premarket-daemon] started — logging to {LOG}", flush=True)
    async with aiohttp.ClientSession() as s:
        while True:
            now = datetime.now(ET)
            date = now.strftime("%Y-%m-%d")
            weekday = now.weekday() < 5
            if weekday and now.hour == 9 and 5 <= now.minute < 28:
                await snapshot_picks(s, date)
            if weekday and ((now.hour == 10 and now.minute >= 5) or now.hour >= 11):
                await score_picks(s, date)
            # also catch up yesterday's unscored picks (daemon restarts etc.)
            yd = (now - timedelta(days=1)).strftime("%Y-%m-%d")
            await score_picks(s, yd)
            await asyncio.sleep(180)


if __name__ == "__main__":
    asyncio.run(main())
