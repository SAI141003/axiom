"""
VWAP TREND daemon — faithful paper-test of Zarattini & Aziz (SSRN 4631351),
"VWAP: The Holy Grail for Day Trading Systems": long QQQ when price is above
the session VWAP, short when below, intraday only. Their backtest: QQQ 671%
(Sharpe 2.1, maxDD 9.4%) 2018-2023; TQQQ 8,242%.

Implementation (the paper's stated rule, no invented extras):
  - session VWAP from 1-min bars (Σ typical×vol / Σ vol), 9:30–16:00 ET
  - state machine per symbol: cross above VWAP → LONG, cross below → SHORT
    (close & flip on opposite cross), everything FLAT at 15:59
  - $10,000 notional per position, paper only, prices from Yahoo 1-min
  - anti-churn: a flip requires the close to clear VWAP by CONFIRM_BP
    (whipsaw right at VWAP otherwise flips every bar; logged so the cost of
    this choice is measurable)

Log: logs/dryrun_vwap.jsonl {"type":"vopen"|"vclose"|"vday", ...}
The brain/MC pick it up like every other strategy. DRY RUN ONLY.
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_vwap.jsonl"
ET = ZoneInfo("America/New_York")

SYMBOLS = ["QQQ", "TQQQ"]
NOTIONAL = 10_000.0
CONFIRM_BP = 2.0          # close must clear VWAP by 2bp to trigger a flip
# CHOP GUARD: a range day saws price across VWAP all session (7/14: 34 flips,
# −$644). After MAX_FLIPS flips in a symbol, flatten and stop trading it for
# the day. Measured on 3 real days: uncapped −$362 → capped +$193 total.
MAX_FLIPS = 4
POLL_S = 60

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bot_switch import bot_enabled


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


async def session_bars(s: aiohttp.ClientSession, sym: str) -> list[dict]:
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
           f"?range=1d&interval=1m&includePrePost=false")
    try:
        async with s.get(url, headers={"User-Agent": "Mozilla/5.0"},
                         timeout=aiohttp.ClientTimeout(total=10)) as r:
            if r.status != 200:
                return []
            d = await r.json()
        res = d["chart"]["result"][0]
        ts = res["timestamp"]
        q = res["indicators"]["quote"][0]
        bars = []
        for i in range(len(ts)):
            if None in (q["high"][i], q["low"][i], q["close"][i], q["volume"][i]):
                continue
            bars.append({"ts": ts[i], "h": q["high"][i], "l": q["low"][i],
                         "c": q["close"][i], "v": q["volume"][i]})
        return bars
    except Exception:
        return []


def session_vwap(bars: list[dict]) -> float | None:
    pv = vv = 0.0
    for b in bars:
        typ = (b["h"] + b["l"] + b["c"]) / 3
        pv += typ * b["v"]
        vv += b["v"]
    return pv / vv if vv > 0 else None


def volume_profile(bars: list[dict], nbins: int = 30) -> dict | None:
    """TPO/volume-profile layer: POC (price of max volume) + 70% value area.
    'Find where price accepted value' — entries near POC/VA are structure;
    entries far from it are chases."""
    if len(bars) < 10:
        return None
    lo = min(b["l"] for b in bars)
    hi = max(b["h"] for b in bars)
    if hi <= lo:
        return None
    width = (hi - lo) / nbins
    vols = [0.0] * nbins
    for b in bars:
        i = min(nbins - 1, int(((b["h"] + b["l"]) / 2 - lo) / width))
        vols[i] += b["v"]
    total = sum(vols)
    if total <= 0:
        return None
    poc_i = max(range(nbins), key=lambda i: vols[i])
    # expand around POC until 70% of volume is inside (value area)
    inside = vols[poc_i]
    lo_i = hi_i = poc_i
    while inside < 0.70 * total and (lo_i > 0 or hi_i < nbins - 1):
        left = vols[lo_i - 1] if lo_i > 0 else -1
        right = vols[hi_i + 1] if hi_i < nbins - 1 else -1
        if right >= left:
            hi_i += 1; inside += vols[hi_i]
        else:
            lo_i -= 1; inside += vols[lo_i]
    mid = lambda i: round(lo + (i + 0.5) * width, 4)
    return {"poc": mid(poc_i), "vah": mid(hi_i), "val": mid(lo_i)}


def entry_kind(bars: list[dict], vwap: float) -> str:
    """'Wait for pullback into structure': pullback = price touched VWAP in
    the last 3 bars before entry; chase = it ran away without retesting."""
    recent = bars[-3:]
    touched = any(b["l"] <= vwap <= b["h"] for b in recent)
    return "pullback" if touched else "chase"


def gamma_context(sym: str, px: float) -> dict | None:
    """Nearest dealer walls from signals/gamma_levels.py output."""
    try:
        g = json.loads((ROOT / ".data" / "gamma_levels.json").read_text())["levels"]
        lv = g.get(sym) or g.get("QQQ")
        if not lv:
            return None
        return {"call_wall": lv["call_wall"], "put_wall": lv["put_wall"],
                "zero_gamma": lv.get("zero_gamma"),
                "dist_call_bp": round((lv["call_wall"] - px) / px * 10000),
                "dist_put_bp": round((px - lv["put_wall"]) / px * 10000)}
    except Exception:
        return None


def load_open_positions() -> dict[str, dict]:
    """Rebuild open positions from the log (restart-safe)."""
    pos: dict[str, dict] = {}
    if not LOG.exists():
        return pos
    for line in LOG.open():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r["type"] == "vopen":
            pos[r["symbol"]] = r
        elif r["type"] == "vclose":
            pos.pop(r["symbol"], None)
    # stale open positions from a previous day are force-closed at their
    # open price (unknown fill) — flagged so the record stays honest
    today = datetime.now(ET).strftime("%Y-%m-%d")
    for sym in list(pos):
        if pos[sym].get("date") != today:
            log_write({"type": "vclose", "symbol": sym, "date": pos[sym].get("date"),
                       "exit": pos[sym]["entry"], "pnl": 0.0, "reason": "stale-restart",
                       "ts": int(time.time())})
            del pos[sym]
    return pos


def close_pos(pos: dict, sym: str, px: float, reason: str, date: str) -> None:
    p = pos.pop(sym)
    shares = p["shares"]
    pnl = (px - p["entry"]) * shares if p["side"] == "LONG" else (p["entry"] - px) * shares
    log_write({"type": "vclose", "symbol": sym, "date": date, "exit": round(px, 4),
               "entry": p["entry"], "side": p["side"], "pnl": round(pnl, 2),
               "reason": reason, "ts": int(time.time())})
    print(f"[vwap] {sym} CLOSE {p['side']} @ {px:.2f} → {pnl:+.2f} ({reason})", flush=True)


def open_pos(pos: dict, sym: str, side: str, px: float, vwap: float, date: str,
             bars: list[dict] | None = None) -> None:
    shares = round(NOTIONAL / px, 4)
    rec = {"type": "vopen", "symbol": sym, "date": date, "side": side,
           "entry": round(px, 4), "vwap": round(vwap, 4), "shares": shares,
           "profile": volume_profile(bars) if bars else None,
           "entry_kind": entry_kind(bars, vwap) if bars else None,
           "gamma": gamma_context(sym, px),
           "ts": int(time.time())}
    pos[sym] = rec
    log_write(rec)
    print(f"[vwap] {sym} OPEN {side} @ {px:.2f} (vwap {vwap:.2f})", flush=True)


async def main() -> None:
    print(f"[vwap] started — Zarattini/Aziz VWAP trend, {SYMBOLS}, paper ${NOTIONAL:.0f}/leg",
          flush=True)
    pos = load_open_positions()
    # rebuild today's flip counts from the log (restart-safe chop guard)
    flips_today: dict[tuple[str, str], int] = {}
    if LOG.exists():
        for line in LOG.open():
            try:
                r = json.loads(line)
                if r.get("type") == "vclose" and r.get("reason") == "flip":
                    k = (r.get("date", ""), r.get("symbol", ""))
                    flips_today[k] = flips_today.get(k, 0) + 1
            except Exception:
                pass
    async with aiohttp.ClientSession() as s:
        while True:
            now = datetime.now(ET)
            date = now.strftime("%Y-%m-%d")
            in_session = now.weekday() < 5 and (
                (now.hour == 9 and now.minute >= 31) or 10 <= now.hour < 16)
            near_close = now.hour == 15 and now.minute >= 59

            if not in_session or not bot_enabled("vwap"):
                await asyncio.sleep(60)
                continue

            for sym in SYMBOLS:
                try:
                    bars = await session_bars(s, sym)
                    if len(bars) < 5:
                        continue
                    vwap = session_vwap(bars)
                    px = bars[-1]["c"]
                    if not vwap or not px:
                        continue

                    if near_close:
                        if sym in pos:
                            close_pos(pos, sym, px, "eod", date)
                        continue

                    # chop guard: count today's flips for this symbol
                    nflips = flips_today.get((date, sym), 0)
                    if nflips >= MAX_FLIPS:
                        if sym in pos:            # flatten and sit out the day
                            close_pos(pos, sym, px, "chop-stop", date)
                            print(f"[vwap] {sym} chop-stop: {nflips} flips — done for {date}", flush=True)
                        continue

                    dist_bp = (px - vwap) / vwap * 10000
                    want = "LONG" if dist_bp > CONFIRM_BP else (
                        "SHORT" if dist_bp < -CONFIRM_BP else None)
                    cur = pos.get(sym, {}).get("side")
                    if want and want != cur:
                        if sym in pos:
                            close_pos(pos, sym, px, "flip", date)
                            flips_today[(date, sym)] = nflips + 1
                        open_pos(pos, sym, want, px, vwap, date, bars)
                except Exception as exc:
                    print(f"[vwap] {sym} cycle error: {exc}", flush=True)

            if near_close:
                # day summary
                closes = []
                if LOG.exists():
                    closes = [json.loads(l) for l in LOG.open()]
                day = [r for r in closes if r.get("type") == "vclose" and r.get("date") == date]
                log_write({"type": "vday", "date": date,
                           "trades": len(day),
                           "pnl": round(sum(r["pnl"] for r in day), 2),
                           "ts": int(time.time())})
                await asyncio.sleep(3600)   # session over
            await asyncio.sleep(POLL_S)


if __name__ == "__main__":
    asyncio.run(main())
