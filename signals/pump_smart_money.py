"""
PUMP.FUN SMART MONEY — follow the wallets that are right, not the ones that shout.

Listens to PumpPortal's free data stream (no key): every token created, every
trade on the tokens we watch, and every graduation ("migration" to Raydium/
PumpSwap -- the one unambiguous success event on pump.fun). From that it keeps
a scoreboard of wallets: how many tokens each bought early, how many of those
graduated. Wallets with a real hit rate over enough samples are "smart". A
token that two or more smart wallets buy within a short window is a signal the
meme bot can act on -- with its liquidity floor still in force.

This is on-chain behaviour, not social media. X's API is not free; the tweets
lag the trades anyway. What it cannot do is make meme coins safe: it raises
the odds of being in the right tokens and measures whether it did.

Two tiers. Creations and graduations are free, so without a key the tracker
scores CREATORS (wallets whose launches graduate) and feeds graduations to the
meme bot. Per-token trades need a PumpPortal key funded with 0.02 SOL (about
$4): set PUMPPORTAL_API_KEY in .env and buyer-level smart money switches on.

Writes .data/pump_smart_money.json every 30s:
  {"ts", "watched", "wallets": {pk: {buys, grads, hit_rate}}, "smart": [pk...],
   "signals": [{"mint", "symbol", "smart_buyers", "first_seen", "last_buy"}],
   "migrations_1h": [...], "stats": {...}}

  python signals/pump_smart_money.py
"""
from __future__ import annotations

import asyncio
import json
import time
from collections import defaultdict, deque
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parent.parent
import os, sys
sys.path.insert(0, str(ROOT))
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except Exception:
    pass
API_KEY = os.environ.get("PUMPPORTAL_API_KEY", "").strip()
OUT = ROOT / ".data" / "pump_smart_money.json"
STATE = ROOT / ".data" / "pump_wallets.json"
WS = "wss://pumpportal.fun/api/data"

WATCH_SECONDS = 20 * 60        # follow a new token's trades for 20 minutes
MAX_WATCH = 60                 # at most this many tokens under live subscription
MIN_BUYS_FOR_SCORE = 8         # a wallet needs samples before it can be "smart"
SMART_HIT_RATE = 0.20          # graduations / early buys; pump.fun base rate is ~1%
SIGNAL_WINDOW = 30 * 60        # two smart wallets within 30 minutes = a signal
MAX_WALLETS = 20_000


class Tracker:
    def __init__(self) -> None:
        self.wallets: dict[str, dict] = {}          # pk -> {buys, grads, last}   (buyers; needs key)
        self.creators: dict[str, dict] = {}         # pk -> {launches, grads, last} (free tier)
        self.token_buyers: dict[str, dict] = {}     # mint -> {pk: ts}
        self.token_meta: dict[str, dict] = {}       # mint -> {symbol, name, created}
        self.watch_until: dict[str, float] = {}     # mint -> deadline
        self.migrations: deque = deque(maxlen=500)  # (ts, mint)
        self.stats = defaultdict(int)
        self.load()

    def load(self) -> None:
        try:
            d = json.loads(STATE.read_text())
            self.wallets = d.get("wallets", {})
            self.creators = d.get("creators", {})
            self.token_buyers = {m: v for m, v in d.get("token_buyers", {}).items()}
            self.token_meta = d.get("token_meta", {})
        except Exception:
            pass

    def save(self) -> None:
        # keep the wallet table bounded: drop the quietest
        if len(self.wallets) > MAX_WALLETS:
            for pk, _ in sorted(self.wallets.items(), key=lambda kv: kv[1].get("last", 0))[: len(self.wallets) - MAX_WALLETS]:
                self.wallets.pop(pk, None)
        cutoff = time.time() - 7 * 86400
        self.token_buyers = {m: v for m, v in self.token_buyers.items() if self.token_meta.get(m, {}).get("created", 0) > cutoff}
        self.token_meta = {m: v for m, v in self.token_meta.items() if v.get("created", 0) > cutoff}
        STATE.parent.mkdir(exist_ok=True)
        STATE.write_text(json.dumps({"wallets": self.wallets, "creators": self.creators, "token_buyers": self.token_buyers, "token_meta": self.token_meta}))

    def smart(self) -> set[str]:
        return {pk for pk, w in self.wallets.items()
                if w.get("buys", 0) >= MIN_BUYS_FOR_SCORE and w.get("grads", 0) / w["buys"] >= SMART_HIT_RATE}

    def on_create(self, m: dict) -> None:
        mint = m.get("mint"); pk = m.get("traderPublicKey")
        if not mint:
            return
        now = time.time()
        self.token_meta[mint] = {"symbol": m.get("symbol", "?"), "name": m.get("name", ""), "created": now, "creator": pk,
                                 "initial_sol": m.get("solAmount"), "pool": m.get("pool")}
        if pk:
            c = self.creators.setdefault(pk, {"launches": 0, "grads": 0, "last": 0})
            c["launches"] += 1; c["last"] = now
        self.token_buyers.setdefault(mint, {})
        self.watch_until[mint] = now + WATCH_SECONDS
        self.stats["tokens_seen"] += 1

    def on_trade(self, m: dict) -> None:
        mint, pk, side = m.get("mint"), m.get("traderPublicKey"), m.get("txType")
        if not mint or not pk or side != "buy":
            return
        now = time.time()
        buyers = self.token_buyers.setdefault(mint, {})
        if pk not in buyers:
            buyers[pk] = now
            w = self.wallets.setdefault(pk, {"buys": 0, "grads": 0, "last": 0})
            w["buys"] += 1; w["last"] = now
            self.stats["early_buys"] += 1

    def on_migration(self, m: dict) -> None:
        mint = m.get("mint")
        if not mint:
            return
        now = time.time()
        self.migrations.append((now, mint))
        self.stats["migrations"] += 1
        for pk in self.token_buyers.get(mint, {}):
            w = self.wallets.get(pk)
            if w:
                w["grads"] += 1
        creator = self.token_meta.get(mint, {}).get("creator")
        if creator and creator in self.creators:
            self.creators[creator]["grads"] += 1
        self.token_meta.setdefault(mint, {"symbol": "?", "created": now})["graduated"] = now

    def signals(self) -> list[dict]:
        smart, now, out = self.smart(), time.time(), []
        for mint, buyers in self.token_buyers.items():
            hits = [(pk, ts) for pk, ts in buyers.items() if pk in smart and now - ts <= SIGNAL_WINDOW]
            if len(hits) >= 2:
                meta = self.token_meta.get(mint, {})
                out.append({"mint": mint, "symbol": meta.get("symbol", "?"), "name": meta.get("name", ""),
                            "smart_buyers": len(hits), "first_seen": meta.get("created"), "last_buy": max(ts for _, ts in hits),
                            "graduated": bool(meta.get("graduated"))})
        out.sort(key=lambda s: (-s["smart_buyers"], -(s["last_buy"] or 0)))
        return out[:20]

    def smart_creators(self) -> set[str]:
        return {pk for pk, c in self.creators.items() if c.get("launches", 0) >= 5 and c.get("grads", 0) / c["launches"] >= 0.15}

    def snapshot(self) -> dict:
        now = time.time(); smart = self.smart(); sc = self.smart_creators()
        launches = [{"mint": m, "symbol": v.get("symbol", "?"), "creator": v.get("creator"), "ts": int(v.get("created", 0)),
                     "smart_creator": v.get("creator") in sc}
                    for m, v in self.token_meta.items() if now - v.get("created", 0) <= 3600 and v.get("creator") in sc][-20:]
        top = sorted(((pk, w) for pk, w in self.wallets.items() if w.get("buys", 0) >= MIN_BUYS_FOR_SCORE),
                     key=lambda kv: -(kv[1]["grads"] / kv[1]["buys"]))[:25]
        return {"ts": int(now), "watched": len([m for m, t in self.watch_until.items() if t > now]),
                "wallets_scored": sum(1 for w in self.wallets.values() if w.get("buys", 0) >= MIN_BUYS_FOR_SCORE),
                "smart_count": len(smart),
                "top_wallets": [{"wallet": pk, "buys": w["buys"], "grads": w["grads"], "hit_rate": round(w["grads"] / w["buys"], 3)} for pk, w in top],
                "tier": "buyers (API key)" if API_KEY else "creators + graduations (free)",
                "creators_scored": sum(1 for c in self.creators.values() if c.get("launches", 0) >= 5),
                "smart_creators": len(sc),
                "smart_creator_launches_1h": launches,
                "signals": self.signals(),
                "migrations_1h": [{"mint": m, "symbol": self.token_meta.get(m, {}).get("symbol", "?"), "ts": int(ts)} for ts, m in self.migrations if now - ts <= 3600][-20:],
                "stats": dict(self.stats)}


async def run() -> None:
    tr = Tracker()
    last_save = last_out = 0.0
    while True:
        try:
            async with websockets.connect(WS + (f"?api-key={API_KEY}" if API_KEY else ""), ping_interval=20, max_size=2**20) as ws:
                await ws.send(json.dumps({"method": "subscribeNewToken"}))
                await ws.send(json.dumps({"method": "subscribeMigration"}))
                print("[smart-money] connected to pumpportal", flush=True)
                subscribed: set[str] = set()
                while True:
                    raw = await asyncio.wait_for(ws.recv(), timeout=90)
                    try:
                        m = json.loads(raw)
                    except Exception:
                        continue
                    t = m.get("txType")
                    if t == "create":
                        tr.on_create(m)
                        mint = m["mint"]
                        if len(subscribed) >= MAX_WATCH:
                            now = time.time()
                            stale = [x for x in subscribed if tr.watch_until.get(x, 0) < now]
                            if stale:
                                await ws.send(json.dumps({"method": "unsubscribeTokenTrade", "keys": stale}))
                                subscribed -= set(stale)
                        if API_KEY and len(subscribed) < MAX_WATCH:
                            await ws.send(json.dumps({"method": "subscribeTokenTrade", "keys": [mint]}))
                            subscribed.add(mint)
                    elif t in ("buy", "sell"):
                        tr.on_trade(m)
                    elif "migration" in json.dumps(m).lower() or m.get("txType") == "migrate":
                        tr.on_migration(m)
                    now = time.time()
                    if now - last_out > 30:
                        OUT.parent.mkdir(exist_ok=True)
                        OUT.write_text(json.dumps(tr.snapshot(), indent=1)); last_out = now
                    if now - last_save > 300:
                        tr.save(); last_save = now
        except Exception as e:
            print(f"[smart-money] reconnect after: {str(e)[:120]}", flush=True)
            tr.save()
            await asyncio.sleep(10)


if __name__ == "__main__":
    asyncio.run(run())
