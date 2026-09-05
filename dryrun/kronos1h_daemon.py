"""
Kronos × 1-hour markets — THE HORIZON MATCH paper test.

The gap: Kronos (AAAI'26 foundation model) natively forecasts 60 minutes ahead.
Polymarket runs HOURLY Up/Down markets (bitcoin-up-or-down-july-10-3pm-et).
Our 5-min momentum failed because 5 minutes is noise; one hour is Kronos's
exact design horizon — and we're likely the only desk wiring these together.

Cycle: at ~:02 past each hour (ET):
  - resolve last hour's trade via Polymarket's own settlement
  - run a fresh Kronos forecast for BTC and ETH (real weights, ~14s CPU each)
  - if |predicted move| clears the confidence gate → paper-trade the current
    hour market at the real CLOB ASK

Log: logs/dryrun_kronos1h.jsonl  {"type":"kentry"|"kresolve", ...}
Run:  launchd com.polymarket.dryrun.kronos1h
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

LOG = ROOT / "logs" / "dryrun_kronos1h.jsonl"
ET = ZoneInfo("America/New_York")
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
ASSETS = {"BTC": "bitcoin", "ETH": "ethereum"}
# Per-asset arming is owned by the BRAIN (dryrun/brain.py): it disarms a
# stable bleeder segment and re-arms it if the signal-only record recovers.
# Initial state: ETH disarmed (Kronos bearish bias — ETH DOWN 1/7, −$53;
# BTC 3/5 +$17). Disarmed assets keep logging forecasts as signal-only.
def armed_assets() -> set[str]:
    try:
        return set(json.loads((ROOT / ".data" / "params_kronos.json")
                              .read_text()).get("armed", ["BTC"]))
    except Exception:
        return {"BTC"}
STAKE = 10.0
MIN_MOVE_BP = 5.0        # forecast must clear 5bp — below that it's noise
MAX_SIDE_PX = 0.72


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def hour_slug(prefix: str, dt: datetime) -> str:
    """Real series slug INCLUDES the year: bitcoin-up-or-down-july-11-2026-11am-et
    (a year-less lookalike family exists and returns junk pre-closed events —
    that silent mismatch cost the daemon its first 14 hours)."""
    h = dt.strftime("%-I%p").lower()
    return f"{prefix}-up-or-down-{dt.strftime('%B').lower()}-{dt.day}-{dt.year}-{h}-et"


async def jget(s: aiohttp.ClientSession, url: str, **kw):
    for _ in range(2):
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=12), **kw) as r:
                if r.status == 200:
                    return await r.json()
        except Exception:
            await asyncio.sleep(2)
    return None


async def market_for(s: aiohttp.ClientSession, asset: str, dt: datetime):
    ev = await jget(s, f"{GAMMA}/events", params={"slug": hour_slug(ASSETS[asset], dt)})
    if not ev:
        return None
    m = ev[0]["markets"][0]
    try:
        tokens = json.loads(m["clobTokenIds"])
    except Exception:
        tokens = []
    up_ask = None
    if len(tokens) == 2:
        try:
            async with s.post(f"{CLOB}/prices",
                              json=[{"token_id": tokens[0], "side": "SELL"},
                                    {"token_id": tokens[1], "side": "SELL"}],
                              timeout=aiohttp.ClientTimeout(total=8)) as r:
                if r.status == 200:
                    px = await r.json()
                    up_ask = float(px[tokens[0]]["SELL"])
                    down_ask = float(px[tokens[1]]["SELL"])
        except Exception:
            pass
    if up_ask is None:
        prices = json.loads(m["outcomePrices"])
        up_ask, down_ask = float(prices[0]), float(prices[1])
    return {"slug": ev[0]["slug"],
            "closed": bool(m.get("closed")) or not m.get("acceptingOrders", True),
            "outcome": json.loads(m["outcomePrices"]), "up_ask": up_ask,
            "down_ask": down_ask, "tokens": tokens}


async def resolve_pending(s: aiohttp.ClientSession) -> None:
    if not LOG.exists():
        return
    entries, resolved = {}, set()
    for line in LOG.open():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r["type"] == "kentry":
            entries[r["id"]] = r
        else:
            resolved.add(r["id"])
    for rid, e in entries.items():
        # only armed trades resolve to P&L — signal-only rows have entry=None
        if not e.get("traded") or not e.get("entry"):
            continue
        if rid in resolved or time.time() < e["hour_end"] + 120:
            continue
        dt = datetime.fromtimestamp(e["hour_start"], ET)
        m = await market_for(s, e["asset"], dt)
        if not m or not m["closed"]:
            continue
        up_won = float(m["outcome"][0]) > 0.5
        won = (e["side"] == "UP") == up_won
        pnl = round(STAKE * (1 / e["entry"] - 1) if won else -STAKE, 2)
        log_write({"type": "kresolve", "id": rid, "up_won": up_won,
                   "won": won, "pnl": pnl, "ts": int(time.time())})
        print(f"[kronos1h] {e['asset']} {e['side']} → {'WON' if won else 'LOST'} {pnl:+.2f}", flush=True)


from bot_switch import bot_enabled

async def trade_hour(s: aiohttp.ClientSession) -> None:
    if not bot_enabled("kronos1h"):
        return
    from signals.kronos_signal import forecast as kronos_forecast
    from core.models import Market

    now = datetime.now(ET)
    hour_start = int(now.replace(minute=0, second=0, microsecond=0).timestamp())
    placed = set()
    if LOG.exists():
        for line in LOG.open():
            try:
                r = json.loads(line)
                if r.get("type") == "kentry":
                    placed.add(r["id"])
            except Exception:
                pass

    for asset in ASSETS:
        rid = f"{asset}-{hour_start}"
        if rid in placed:
            continue
        mkt = await market_for(s, asset, now)
        if not mkt or mkt["closed"]:
            continue
        m = Market(condition_id=rid, question=f"{asset} up this hour?",
                   category="crypto", yes_price=0.5, no_price=0.5, linked_asset=asset)
        out = await kronos_forecast(m)
        if out is None:
            print(f"[kronos1h] {asset}: no forecast", flush=True)
            continue
        move_bp = (out.predicted_price - out.current_price) / out.current_price * 10000
        side = "UP" if move_bp > MIN_MOVE_BP else "DOWN" if move_bp < -MIN_MOVE_BP else None
        rec = {"type": "kentry", "id": rid, "asset": asset,
               "hour_start": hour_start, "hour_end": hour_start + 3600,
               "slug": mkt["slug"], "pred": out.predicted_price,
               "cur": out.current_price, "move_bp": round(move_bp, 1),
               "confidence": out.confidence,
               "agreement": getattr(out, "agreement", None),
               "pred_vol_bp": getattr(out, "pred_vol_bp", None),
               "up_ask": mkt["up_ask"], "down_ask": mkt["down_ask"],
               "side": side, "entry": None, "traded": False, "ts": int(time.time())}
        # armed trades require FULL ensemble agreement (all 3 stochastic runs
        # same direction) — the honest confidence the single run never had
        agree_ok = rec["agreement"] is None or rec["agreement"] >= 0.99
        if side and asset in armed_assets() and agree_ok:
            entry = mkt["up_ask"] if side == "UP" else mkt["down_ask"]
            if 0.02 < entry < MAX_SIDE_PX:
                rec.update({"entry": entry, "traded": True})
                print(f"[kronos1h] TRADE {asset} {side} @ {entry} "
                      f"(Kronos {move_bp:+.1f}bp conf {out.confidence:.2f})", flush=True)
                try:
                    from live_micro import live_config, place_micro_buy
                    if live_config()[0] and len(mkt.get("tokens", [])) == 2:
                        tok = mkt["tokens"][0] if side == "UP" else mkt["tokens"][1]
                        place_micro_buy("kronos1h", tok, f"{asset} {side} 1h", entry)
                except Exception as exc:
                    print(f"[kronos1h] live-micro error: {exc}", flush=True)
        log_write(rec)


async def main() -> None:
    print(f"[kronos1h] started — logging to {LOG}", flush=True)
    async with aiohttp.ClientSession() as s:
        while True:
            now = datetime.now(ET)
            if now.minute >= 2:                     # let the hourly market seed
                try:
                    await resolve_pending(s)
                    await trade_hour(s)
                except Exception as exc:
                    print(f"[kronos1h] cycle error: {exc}", flush=True)
                # sleep to 2 min past the next hour
                nxt = (now.replace(minute=2, second=0, microsecond=0).timestamp() + 3600)
                await asyncio.sleep(max(60, nxt - time.time()))
            else:
                await asyncio.sleep((2 - now.minute) * 60)


if __name__ == "__main__":
    asyncio.run(main())
