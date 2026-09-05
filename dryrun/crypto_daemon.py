"""
Crypto 5-min Up/Down DRY-RUN daemon — runs forever, no orders, live data only.

Every 5-minute window, for BTC/ETH/SOL/XRP:
  - snapshot the live Polymarket Up/Down prices (Gamma) at ~45s into the window
  - compute the momentum signal from live Binance 1m klines
  - record EVERYTHING (even skipped windows) to logs/dryrun_5m.jsonl
  - two windows later, resolve against the actual Gamma outcome and append a
    resolution record (joined by id in the analyzer)

Record types (JSONL):
  {"type":"entry", id, asset, ts, side|null, score, momentum_bp, persist,
   up_price, down_price, spot, traded}
  {"type":"resolve", id, up_won, won|null, pnl|null}

Run:  nohup .venv/bin/python dryrun/crypto_daemon.py >> logs/crypto_daemon.log 2>&1 &
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import aiohttp

GAMMA = "https://gamma-api.polymarket.com"
BINANCE = "https://api.binance.com"
LOG = Path(__file__).resolve().parent.parent / "logs" / "dryrun_5m.jsonl"

ASSETS = {"btc": "BTCUSDT", "eth": "ETHUSDT", "sol": "SOLUSDT", "xrp": "XRPUSDT"}
STAKE = 10.0
SCORE_THRESHOLD = 0.25
MAX_SIDE_PX = 0.62
ENTRY_AT_S = 45          # snapshot+entry this many seconds into the window
PARAMS = Path(__file__).resolve().parent.parent / ".data" / "params_crypto.json"
from bot_switch import bot_enabled


def learned_params(asset: str) -> dict:
    """Self-learned config from dryrun/learner.py (nightly). Defaults if absent.
    Signals are always LOGGED raw — params only decide what gets traded, so the
    data stream stays unbiased for future learning."""
    try:
        p = json.loads(PARAMS.read_text())["params"].get(asset)
        if p:
            return p
    except Exception:
        pass
    return {"enabled": True, "threshold": SCORE_THRESHOLD, "sign": 1}


def clob_fee(p: float) -> float:
    return 0.018 * 4.0 * p * (1.0 - p)


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


async def jget(s: aiohttp.ClientSession, url: str, **kw):
    for attempt in range(2):
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=12), **kw) as r:
                if r.status == 200:
                    return await r.json()
        except Exception:
            await asyncio.sleep(1)
    return None


CLOB = "https://clob.polymarket.com"


async def clob_asks(s: aiohttp.ClientSession, token_ids: list[str]) -> dict[str, float]:
    """Live ASK per token (side=SELL) — what a buyer actually pays; matches the
    Polymarket app display. Mid flattered our entries by half the spread."""
    try:
        async with s.post(f"{CLOB}/prices",
                          json=[{"token_id": t, "side": "SELL"} for t in token_ids],
                          timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                return {}
            out = {}
            for k, v in (await r.json()).items():
                try:
                    out[k] = float(v.get("SELL"))
                except Exception:
                    pass
            return out
    except Exception:
        return {}


async def gamma_window(s: aiohttp.ClientSession, asset: str, ts: int):
    ev = await jget(s, f"{GAMMA}/events", params={"slug": f"{asset}-updown-5m-{ts}"})
    if not ev:
        return None
    try:
        m = ev[0]["markets"][0]
        prices = json.loads(m["outcomePrices"])
        up, down, src = float(prices[0]), float(prices[1]), "gamma"
        tokens = json.loads(m.get("clobTokenIds") or "[]")
        if len(tokens) == 2:
            asks = await clob_asks(s, tokens)
            u, d = asks.get(tokens[0]), asks.get(tokens[1])
            if u and 0 < u < 1:
                up, src = u, "clob-ask"
                down = d if (d and 0 < d < 1) else round(1 - u, 4)
        return {"up": up, "down": down, "closed": bool(m.get("closed")), "src": src}
    except Exception:
        return None


async def signal(s: aiohttp.ClientSession, sym: str, ts: int, dirs: list[int]):
    """Momentum score from last 10 closed 1m klines before window start."""
    kl = await jget(s, f"{BINANCE}/api/v3/klines",
                    params={"symbol": sym, "interval": "1m",
                            "endTime": ts * 1000 - 1, "limit": 10})
    if not kl or len(kl) < 5:
        return None
    closes = [float(k[4]) for k in kl]
    spot = closes[-1]
    ema3 = closes[-3]
    for c in closes[-2:]:
        ema3 = ema3 + 0.5 * (c - ema3)
    momentum = (closes[-1] - ema3) / ema3
    persist = sum(dirs[-3:]) / max(1, len(dirs[-3:])) if dirs else 0.0
    score = (1 if momentum >= 0 else -1) * min(1.0, abs(momentum) * 8000) * 0.7 + persist * 0.3
    side = "UP" if score > SCORE_THRESHOLD else "DOWN" if score < -SCORE_THRESHOLD else None
    # realized-vol regime (research: the hour=11/23 UTC bleeders are likely a
    # low-vol regime) — stdev of 1m returns over the lookback, in bp
    rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]
    mu = sum(rets) / len(rets)
    rv_bp = (sum((r - mu) ** 2 for r in rets) / len(rets)) ** 0.5 * 10000
    return {"side": side, "score": round(score, 4),
            "momentum_bp": round(momentum * 10000, 2),
            "persist": round(persist, 3), "spot": spot,
            "rv_bp": round(rv_bp, 2)}


async def main() -> None:
    print(f"[crypto-daemon] started — logging to {LOG}", flush=True)
    dirs: dict[str, list[int]] = {a: [] for a in ASSETS}
    pending: dict[str, dict] = {}   # id → entry record (awaiting resolution)

    async with aiohttp.ClientSession() as s:
        while True:
            now = time.time()
            win = int(now // 300) * 300
            target = win + ENTRY_AT_S
            if now > target:            # missed this window's entry point
                target += 300
                win += 300
            await asyncio.sleep(max(0, target - time.time()))

            # ── entries for the current window ──
            for a, sym in ASSETS.items():
                try:
                    sig, mkt = await asyncio.gather(
                        signal(s, sym, win, dirs[a]), gamma_window(s, a, win),
                    )
                    if sig is None or mkt is None or mkt["closed"]:
                        continue
                    # learned config decides the TRADE; the raw signal is ALWAYS
                    # logged (unbiased stream for the learner). The master switch
                    # only gates whether we mark it as a trade.
                    lp = learned_params(a)
                    eff = lp["sign"] * sig["score"]
                    side = ("UP" if eff > lp["threshold"]
                            else "DOWN" if eff < -lp["threshold"] else None)
                    entry = mkt["up"] if side == "UP" else mkt["down"] if side == "DOWN" else None
                    traded = (bot_enabled('crypto') and lp["enabled"] and bool(side)
                              and entry is not None and 0.01 < entry < MAX_SIDE_PX)
                    rec = {
                        "type": "entry", "id": f"{a}-{win}", "asset": a, "ts": win,
                        "side": side, "score": sig["score"],
                        "momentum_bp": sig["momentum_bp"], "persist": sig["persist"],
                        "up_price": mkt["up"], "down_price": mkt["down"],
                        "spot": sig["spot"], "rv_bp": sig.get("rv_bp"),
                        "traded": traded,
                        "px_src": mkt.get("src", "gamma"),
                        "cfg": {"sign": lp["sign"], "th": lp["threshold"], "on": lp["enabled"]},
                    }
                    log_write(rec)
                    pending[rec["id"]] = rec
                except Exception as exc:
                    print(f"[crypto-daemon] entry error {a}-{win}: {exc}", flush=True)

            # ── resolutions for windows ≥2 back ──
            for rid in list(pending):
                rec = pending[rid]
                if rec["ts"] > win - 600:
                    continue
                try:
                    ev = await jget(s, f"{GAMMA}/events",
                                    params={"slug": f"{rec['asset']}-updown-5m-{rec['ts']}"})
                    m = ev[0]["markets"][0] if ev else None
                    if not m or not m.get("closed"):
                        if rec["ts"] < win - 3600:   # give up after an hour
                            del pending[rid]
                        continue
                    up_won = float(json.loads(m["outcomePrices"])[0]) > 0.5
                    dirs[rec["asset"]].append(1 if up_won else -1)
                    dirs[rec["asset"]] = dirs[rec["asset"]][-6:]
                    won = pnl = None
                    if rec["traded"]:
                        entry = rec["up_price"] if rec["side"] == "UP" else rec["down_price"]
                        won = (rec["side"] == "UP") == up_won
                        gross = STAKE * (1.0 / entry - 1.0) if won else -STAKE
                        pnl = round(gross - STAKE * clob_fee(entry), 2)
                    log_write({"type": "resolve", "id": rid, "up_won": up_won,
                               "won": won, "pnl": pnl})
                    del pending[rid]
                except Exception as exc:
                    print(f"[crypto-daemon] resolve error {rid}: {exc}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
