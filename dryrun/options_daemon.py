"""
Options strategy PAPER TEST — forward-tests the Options Desk recommendations
with real chains, daily, through end of next week (and beyond until stopped).

Cycle (ET, weekdays):
  ~10:35  run the scanner (/api/options) on the standard universe.
          Log each non-SKIP recommendation as a paper position at the ask
          (entry = rec mid is optimistic; we pay the ask like a real buyer).
          Also logs the top penny play per symbol.
  ~15:50  mark all open positions to market: fetch the real chain, find the
          contract, log its current bid (what we could sell for) + unrealized.

Records (logs/dryrun_options.jsonl):
  {"type":"position", id, date, symbol, opt_type, strike, expiry, entry,
   contracts, cost, kind: "main"|"penny", ts}
  {"type":"mark", id, date, bid, mid, value, unrealized, ts}

Run: launchd com.polymarket.dryrun.options
"""
from __future__ import annotations

import asyncio
import json
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import aiohttp

LOG = Path(__file__).resolve().parent.parent / "logs" / "dryrun_options.jsonl"
SCANNER = "http://localhost:3000/api/options?symbols=NVDA,TSLA,AAPL,MSFT,AMD,GOOGL,META,MU&bankroll=10000"
BANKROLL = 10_000.0
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}

# Exit discipline (was missing — positions rode to expiry and bled forever).
STOP_LOSS = -0.55       # close at the bid once down 55% of premium
PROFIT_TARGET = 0.80    # take profit once up 80% of premium


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def read_log() -> list[dict]:
    if not LOG.exists():
        return []
    out = []
    for line in LOG.open():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


# ── Yahoo crumb (Python side) ─────────────────────────────────────────────────
_auth: dict = {}


async def yget(s: aiohttp.ClientSession, url: str):
    if not _auth or time.time() - _auth.get("ts", 0) > 1200:
        async with s.get("https://fc.yahoo.com", headers=UA, allow_redirects=False):
            pass  # cookie lands in the session jar
        async with s.get("https://query1.finance.yahoo.com/v1/test/getcrumb", headers=UA) as r:
            _auth["crumb"] = (await r.text()).strip()
            _auth["ts"] = time.time()
    sep = "&" if "?" in url else "?"
    async with s.get(f"{url}{sep}crumb={_auth['crumb']}", headers=UA,
                     timeout=aiohttp.ClientTimeout(total=20)) as r:
        if r.status != 200:
            return None
        return await r.json()


async def open_positions(s: aiohttp.ClientSession, date: str) -> None:
    existing = {r["id"] for r in read_log() if r["type"] == "position"}
    try:
        async with s.get(SCANNER, timeout=aiohttp.ClientTimeout(total=180)) as r:
            if r.status != 200:
                print(f"[options-daemon] scanner {r.status}", flush=True)
                return
            d = await r.json()
    except Exception as exc:
        print(f"[options-daemon] scanner error: {exc}", flush=True)
        return

    n = 0
    for res in d.get("results", []):
        sym = res["symbol"]
        rec, sz = res.get("recommendation"), res.get("sizing")
        if rec and sz and res["direction"] in ("CALL", "PUT"):
            contracts = sz.get("contracts", 0)
            pid = f"{date}-{sym}-{rec['strike']}{rec['type'][0]}-{res['expiry']}"
            entry = rec.get("ask") or rec["mid"]          # buyers pay the ask
            # respect Kelly: contracts=0 means the edge doesn't justify the
            # premium — forcing 1 contract of a $40 option put 40% of bankroll
            # in one position and caused the −$793 main-leg bleed.
            if contracts < 1:
                contracts = 0
            # hard cap: no position may exceed 10% of bankroll
            while contracts > 0 and entry * 100 * contracts > BANKROLL * 0.10:
                contracts -= 1
            if contracts >= 1 and pid not in existing:
                log_write({"type": "position", "id": pid, "date": date, "symbol": sym,
                           "opt_type": rec["type"], "strike": rec["strike"],
                           "expiry": res["expiry"], "entry": entry,
                           "contracts": contracts, "cost": round(entry * 100 * contracts, 2),
                           "kind": "main", "score": res["metrics"]["score"], "ts": int(time.time())})
                n += 1
        # Penny picks are DISABLED: forward test proved them negative-EV
        # lottery tickets (12% win rate, -$2780 net over 69 legs). Deep-OTM
        # weeklies expire worthless ~88% of the time; no stop can save a
        # -100% terminal payoff. Main legs (50% win, stop-gated) are the
        # only options edge we keep.
    print(f"[options-daemon] {date}: opened {n} paper positions", flush=True)


async def mark_positions(s: aiohttp.ClientSession, date: str, slot: str = "close") -> None:
    """Mark all open positions at the bid. Runs 3×/day (11:30, 13:30, close) so
    intraday peaks are visible — one daily mark hid every intraday exit."""
    rows = read_log()
    positions = [r for r in rows if r["type"] == "position"]
    marked = {r["id"] for r in rows if r["type"] == "mark"
              and r["date"] == date and r.get("slot", "close") == slot}
    # positions already closed (stop/target/expiry) must never be marked again
    closed = {r["id"] for r in rows if r["type"] == "close"}
    last_val = {}      # id -> last known market value, for expiry settlement
    for r in rows:
        if r["type"] == "mark":
            last_val[r["id"]] = r["value"]
    by_key: dict[tuple, list[dict]] = {}
    for p in positions:
        if p["id"] in marked or p["id"] in closed:
            continue
        try:
            exp_ts = int(datetime.fromisoformat(p["expiry"]).replace(tzinfo=ZoneInfo("UTC")).timestamp())
        except Exception:
            continue
        if p["expiry"] < date:
            # expired — settle to realized at the last value we could have sold
            # for (bid). Without this, expired legs froze as permanent
            # "unrealized" and dragged the book forever.
            val = last_val.get(p["id"], 0.0)
            log_write({"type": "close", "id": p["id"], "date": date,
                       "reason": "expiry", "value": val,
                       "realized": round(val - p["cost"], 2), "ts": int(time.time())})
            continue
        by_key.setdefault((p["symbol"], exp_ts), []).append(p)

    n = 0
    for (sym, exp_ts), plist in by_key.items():
        chain = await yget(s, f"https://query1.finance.yahoo.com/v7/finance/options/{sym}?date={exp_ts}")
        opts = (chain or {}).get("optionChain", {}).get("result", [{}])[0].get("options", [{}])
        if not opts or not opts[0]:
            continue
        for p in plist:
            side = opts[0].get("calls" if p["opt_type"] == "CALL" else "puts", [])
            c = next((x for x in side if abs(x.get("strike", -1) - p["strike"]) < 1e-6), None)
            if not c:
                continue
            bid = float(c.get("bid") or 0)
            ask = float(c.get("ask") or 0)
            mid = round((bid + ask) / 2, 3) if bid and ask else bid
            value = round(bid * 100 * p["contracts"], 2)     # exit at the bid
            unrl = round(value - p["cost"], 2)
            log_write({"type": "mark", "id": p["id"], "date": date, "slot": slot,
                       "bid": bid, "mid": mid, "value": value,
                       "unrealized": unrl, "ts": int(time.time())})
            n += 1
            # exit discipline: realize the P&L and stop marking once a stop or
            # target is hit, instead of riding the leg into the ground.
            ret = unrl / p["cost"] if p["cost"] else 0.0
            if ret <= STOP_LOSS or ret >= PROFIT_TARGET:
                log_write({"type": "close", "id": p["id"], "date": date,
                           "reason": "stop" if ret <= STOP_LOSS else "target",
                           "value": value, "realized": unrl, "ts": int(time.time())})
        await asyncio.sleep(1)
    if n:
        print(f"[options-daemon] {date}: marked {n} positions", flush=True)


async def main() -> None:
    print(f"[options-daemon] started — logging to {LOG}", flush=True)
    async with aiohttp.ClientSession() as s:
        while True:
            now = datetime.now(ET)
            date = now.strftime("%Y-%m-%d")
            if now.weekday() < 5:
                if now.hour == 10 and 30 <= now.minute < 58:
                    await open_positions(s, date)
                if now.hour == 11 and now.minute >= 30:
                    await mark_positions(s, date, "am")
                if now.hour == 13 and now.minute >= 30:
                    await mark_positions(s, date, "midday")
                if (now.hour == 15 and now.minute >= 45) or now.hour == 16:
                    await mark_positions(s, date, "close")
            await asyncio.sleep(240)


if __name__ == "__main__":
    asyncio.run(main())
