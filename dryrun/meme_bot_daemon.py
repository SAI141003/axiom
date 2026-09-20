"""
MEME-COIN BOT — $100 PAPER account, honest forward test. NO real money, NO wallet.

You wanted meme coins — so let's find out the truth on paper before a cent is at
risk. Strategy = the classic meme play: momentum (buy the pump, ride it, bail on
the reversal). Liquid established coins only (DOGE/SHIB/PEPE/WIF/BONK…) — we do
NOT touch brand-new micro-caps, which are where the rug pulls live.

  ENTRY  strong positive 1h AND 24h momentum → buy $20 (chase strength)
  EXIT   1h momentum turns down (reversal) OR 12h max hold → realize P&L
  $100 book, up to 5 positions, marked each cycle.

HONEST expectation: momentum-chasing meme coins is near-casino — you buy near
local tops and pumps reverse. This account is the proof. If it bleeds, that's the
lesson that saves your real money; if it works, we'll have the receipts.

Data: CoinGecko (free, no key). Log: logs/meme_bot.jsonl
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "meme_bot.jsonl"
ET = ZoneInfo("America/New_York")
UA = {"User-Agent": "Mozilla/5.0"}
STAKE = 20.0
MAX_POS = 5
MAX_HOLD_H = 12

# liquid, established meme coins only (real volume, not fresh rug-pull tokens)
COINS = ["dogecoin", "shiba-inu", "pepe", "dogwifcoin", "bonk", "floki",
         "popcat", "cat-in-a-dogs-world", "based-brett", "mog-coin",
         "book-of-meme", "goatseus-maximus"]


def _rows():
    return [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []


def _write(rec):
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


# pump.fun — Solana's meme launchpad, read through DexScreener's free API (no key).
# Bonding-curve pairs carry dexId "pumpfun"; graduated ones "pumpswap". These are
# fresh tokens, so a liquidity floor is the rug guard: below it a "momentum"
# candle is one whale, and the exit fill would not exist.
PUMP_MIN_LIQ_USD = 25_000
PUMP_MIN_VOL24_USD = 250_000
DEX = "https://api.dexscreener.com"


def _get(url):
    return json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15))


def pump_market(extra_addrs=()):
    """pump.fun snapshot keyed "pump:<mint>" in the same shape as market()."""
    try:
        boosted = _get(f"{DEX}/token-boosts/top/v1")
        addrs = [x["tokenAddress"] for x in boosted if x.get("chainId") == "solana"][:30]
    except Exception:
        addrs = []
    addrs = list(dict.fromkeys([*addrs, *extra_addrs]))
    out = {}
    for i in range(0, len(addrs), 30):
        try:
            pairs = _get(f"{DEX}/tokens/v1/solana/{','.join(addrs[i:i + 30])}")
        except Exception:
            continue
        for pr in pairs:
            if not str(pr.get("dexId", "")).startswith("pump"):
                continue
            mint = pr["baseToken"]["address"]
            liq = (pr.get("liquidity") or {}).get("usd") or 0
            px = pr.get("priceUsd")
            key = f"pump:{mint}"
            if px is None or key in out:
                continue
            ch = pr.get("priceChange") or {}
            out[key] = {"sym": pr["baseToken"]["symbol"].upper(), "price": float(px),
                        "m1h": ch.get("h1") or 0.0, "m24h": ch.get("h24") or 0.0,
                        "vol": (pr.get("volume") or {}).get("h24") or 0, "liq": liq,
                        "source": "pump.fun", "url": pr.get("url")}
    return out


SMART = ROOT / ".data" / "pump_smart_money.json"


def smart_money():
    """Mints the pump.fun tracker flags right now, with why. Empty if it is not running."""
    try:
        d = json.loads(SMART.read_text())
    except Exception:
        return {}
    if time.time() - d.get("ts", 0) > 900:        # stale tracker = no opinion
        return {}
    out = {}
    for s in d.get("signals", []):                  # buyer-level (needs key): strongest
        out[s["mint"]] = f"smart-money x{s['smart_buyers']}"
    for m in d.get("migrations_1h", []):            # graduated in the last hour: real liquidity event
        out.setdefault(m["mint"], "graduated")
    for l in d.get("smart_creator_launches_1h", []):
        out.setdefault(l["mint"], "smart-creator launch")
    return out


def market(extra_pump_addrs=()):
    """Live meme-coin snapshot: {id: {sym, price, m1h, m24h, vol}} — CoinGecko majors + pump.fun."""
    out = pump_market(extra_pump_addrs)
    ids = ",".join(COINS)
    url = (f"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids={ids}"
           f"&price_change_percentage=1h,24h")
    try:
        d = _get(url)
    except Exception:
        return out
    for c in d:
        out[c["id"]] = {
            "sym": c["symbol"].upper(), "price": c["current_price"],
            "m1h": c.get("price_change_percentage_1h_in_currency") or 0.0,
            "m24h": c.get("price_change_percentage_24h") or 0.0,
            "vol": c.get("total_volume") or 0, "source": "coingecko",
        }
    return out


def _tradeable(cid, m):
    """Entry filter. Majors need real volume; pump.fun tokens also need a liquidity floor."""
    if not (m["m1h"] > 1.0 and m["m24h"] > 0):
        return False
    if cid.startswith("pump:"):
        return m["vol"] >= PUMP_MIN_VOL24_USD and m.get("liq", 0) >= PUMP_MIN_LIQ_USD
    return m["vol"] > 3e6


def cycle():
    rows = _rows()
    closed = {r["id"] for r in rows if r["type"] == "mclose"}
    open_pos = [r for r in rows if r["type"] == "mentry" and r["id"] not in closed]
    held = {p["coin"] for p in open_pos}
    # held pump.fun mints must be repriced even after they drop off the trending list
    smart = smart_money()
    mkt = market(extra_pump_addrs=[c.split(":", 1)[1] for c in held if c.startswith("pump:")] + list(smart))
    for cid, m in mkt.items():
        mint = cid.split(":", 1)[1] if cid.startswith("pump:") else None
        if mint in smart:
            m["signal"] = smart[mint]
    if not mkt:
        return
    now = time.time()

    # 1) exit: reversal (1h down) or max hold
    for p in open_pos:
        m = mkt.get(p["coin"])
        if not m:
            continue
        held_h = (now - p["ts"]) / 3600
        if m["m1h"] < -1.5 or held_h >= MAX_HOLD_H:
            ret = m["price"] / p["entry"] - 1
            pnl = round(STAKE * ret, 2)
            _write({"type": "mclose", "id": p["id"], "coin": p["coin"], "sym": p["sym"],
                    "exit": m["price"], "pnl": pnl, "won": pnl > 0,
                    "reason": "reversal" if m["m1h"] < -1.5 else "max-hold", "ts": int(now)})
            held.discard(p["coin"])
            print(f"[meme-bot] EXIT {p['sym']} → {pnl:+.2f} ({'reversal' if m['m1h']<-1.5 else 'hold'})", flush=True)

    # 2) enter: strongest positive-momentum coins not held
    slots = MAX_POS - len([p for p in open_pos if p["coin"] in held])
    if slots <= 0:
        return
    # smart-money and graduation flags rank first; momentum still has to be there
    # and the liquidity floor still applies -- the flag is a reason to look, not
    # a licence to skip the rug guard.
    cands = [((m["m1h"] + 0.4 * m["m24h"]) * (2.0 if m.get("signal") else 1.0), cid, m) for cid, m in mkt.items()
             if cid not in held and _tradeable(cid, m)]
    cands.sort(reverse=True)
    today = datetime.now(ET).strftime("%Y-%m-%d")
    for score, cid, m in cands[:slots]:
        _write({"type": "mentry", "id": f"{int(now)}-{cid}", "date": today, "coin": cid,
                "sym": m["sym"], "entry": m["price"], "m1h": round(m["m1h"], 2),
                "m24h": round(m["m24h"], 2), "score": round(score, 2), "ts": int(now),
                "source": m.get("source", "coingecko"), "liq": m.get("liq"), "url": m.get("url"), "signal": m.get("signal")})
        print(f"[meme-bot] BUY {m['sym']} @ {m['price']} via {m.get('source')} (1h {m['m1h']:+.1f}% 24h {m['m24h']:+.1f}%)", flush=True)


def main():
    print("[meme-bot] started — $100 PAPER meme-coin momentum test (no real money)", flush=True)
    while True:
        try:
            cycle()
        except Exception as e:
            print(f"[meme-bot] error: {e}", flush=True)
        time.sleep(1800)          # every 30 min — meme coins move fast


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "once":
        cycle()
    else:
        main()
