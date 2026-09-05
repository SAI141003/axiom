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


def market():
    """Live meme-coin snapshot: {id: {sym, price, m1h, m24h, vol}}."""
    ids = ",".join(COINS)
    url = (f"https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids={ids}"
           f"&price_change_percentage=1h,24h")
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=15))
    except Exception:
        return {}
    out = {}
    for c in d:
        out[c["id"]] = {
            "sym": c["symbol"].upper(), "price": c["current_price"],
            "m1h": c.get("price_change_percentage_1h_in_currency") or 0.0,
            "m24h": c.get("price_change_percentage_24h") or 0.0,
            "vol": c.get("total_volume") or 0,
        }
    return out


def cycle():
    mkt = market()
    if not mkt:
        return
    rows = _rows()
    now = time.time()
    closed = {r["id"] for r in rows if r["type"] == "mclose"}
    open_pos = [r for r in rows if r["type"] == "mentry" and r["id"] not in closed]
    held = {p["coin"] for p in open_pos}

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
    cands = [(m["m1h"] + 0.4 * m["m24h"], cid, m) for cid, m in mkt.items()
             if cid not in held and m["m1h"] > 1.0 and m["m24h"] > 0 and m["vol"] > 3e6]
    cands.sort(reverse=True)
    today = datetime.now(ET).strftime("%Y-%m-%d")
    for score, cid, m in cands[:slots]:
        _write({"type": "mentry", "id": f"{int(now)}-{cid}", "date": today, "coin": cid,
                "sym": m["sym"], "entry": m["price"], "m1h": round(m["m1h"], 2),
                "m24h": round(m["m24h"], 2), "score": round(score, 2), "ts": int(now)})
        print(f"[meme-bot] BUY {m['sym']} @ {m['price']} (1h {m['m1h']:+.1f}% 24h {m['m24h']:+.1f}%)", flush=True)


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
