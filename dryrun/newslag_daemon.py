"""
NEWS-LAG daemon — the brody-pipeline architecture (brodyautomates/
polymarket-pipeline) rebuilt on our infra, paper-first.

The validated design (theirs) + our research:
  - news classified as DIRECTION + MATERIALITY (the question LLMs are good
    at), never "estimate the probability" (the one they're bad at)
  - trade only NICHE markets (< $500K volume) — the crowd there is small and
    slow; the 30-90s news lag documented in the literature lives here, NOT in
    the bot-infested BTC 5-min markets we proved are arbitraged in <12s
  - edge_v2: materiality × room-to-move (bullish: 1 − yes_ask; bearish: bid)
  - quarter-Kelly sizing, bounded

Our infra it rides on:
  - classification: logs/news_intel.jsonl (news desk, every 15 min, tickers
    already validated against live quotes)
  - matching: keyword overlap headline ↔ market question
  - prices: EXECUTABLE side (bestAsk / 1−bestBid), never mid
  - resolution: Gamma closed outcomes (may take days — positions tracked)

Log: logs/dryrun_newslag.jsonl {"type":"ntrade"|"nresolve", ...}
PAPER ONLY. Brain/MC pick it up like every strategy.
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from pathlib import Path

import aiohttp

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_newslag.jsonl"
NEWS = ROOT / "logs" / "news_intel.jsonl"
GAMMA = "https://gamma-api.polymarket.com"

MIN_MAGNITUDE = 2          # news desk 1-5 scale
MAX_VOLUME = 500_000         # niche filter — brody's CENTRAL thesis is <$500K,
                             # where the crowd is small + slow enough for the news
                             # lag to exist. $1M let in competitive markets. (2026-07-24)
EDGE_THRESHOLD = 0.10
MATCH_MIN_SCORE = 0.35
MATCH_MIN_HITS = 2
BANKROLL = 1_000.0
POLL_S = 300

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from bot_switch import bot_enabled

STOP = {"will", "the", "a", "an", "in", "on", "by", "of", "to", "be", "at",
        "is", "for", "and", "or", "before", "after", "than", "more", "2026",
        "2027", "this", "that", "with", "from", "has", "have", "its"}


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


def keywords(s: str) -> list[str]:
    return [w for w in re.sub(r"[^a-z0-9\s]", " ", s.lower()).split()
            if len(w) > 2 and w not in STOP]


def match_score(headline: str, question: str) -> float:
    kws = keywords(question)
    if not kws:
        return 0.0
    text = set(keywords(headline))
    hits = sum(1 for k in kws if k in text)
    return hits / len(kws) if hits >= MATCH_MIN_HITS else 0.0


async def jget(s, url, **kw):
    try:
        async with s.get(url, timeout=aiohttp.ClientTimeout(total=15), **kw) as r:
            if r.status == 200:
                return await r.json()
    except Exception:
        pass
    return None


async def niche_markets(s) -> list[dict]:
    # Gamma caps a page at 100 regardless of `limit`, so page 0 alone saw only
    # ~54 of ~255 niche markets (21%). We PAGINATE (volume DESC — the low-volume
    # niche pool is the tail) to cover the full niche universe. News→market
    # matching is the real bottleneck, so a 5× bigger pool = 5× more chances a
    # breaking headline lands on a tradeable niche market. (2026-07-25)
    out = []
    for offset in (0, 100, 200):
        raw = await jget(s, f"{GAMMA}/markets", params={
            "active": "true", "closed": "false", "limit": 100, "offset": offset,
            "order": "volume24hr", "ascending": "false",
            "enableOrderBook": "true"})
        if not raw:
            break
        for m in raw:
            try:
                vol = float(m.get("volumeNum") or 0)
                bid, ask = m.get("bestBid"), m.get("bestAsk")
                if vol >= MAX_VOLUME or bid is None or ask is None:
                    continue
                out.append({"q": m["question"], "slug": m["slug"],
                            "bid": float(bid), "ask": float(ask), "vol": vol})
            except Exception:
                continue
    return out


def load_news_cards() -> list[dict]:
    if not NEWS.exists():
        return []
    cards = []
    for line in NEWS.open():
        try:
            r = json.loads(line)
            for c in r.get("cards", []):
                c["_ts"] = r.get("ts", 0)
                cards.append(c)
        except Exception:
            pass
    return cards


def processed_uuids() -> set[str]:
    if not LOG.exists():
        return set()
    out = set()
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r["type"] == "ntrade":
                out.add(r.get("news_uuid", ""))
        except Exception:
            pass
    return out


def open_slugs() -> set[str]:
    """Markets we already hold — never double-trade the same slug via a
    different headline (position-duplication loophole)."""
    if not LOG.exists():
        return set()
    traded, resolved = set(), set()
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r["type"] == "ntrade" and r.get("traded"):
                traded.add(r["slug"])
            elif r["type"] == "nresolve":
                resolved.add(r["slug"])
        except Exception:
            pass
    return traded - resolved


def edge_v2(direction: str, magnitude: int, bid: float, ask: float):
    """brody's edge: materiality × room-to-move on the EXECUTABLE side.
    Skip near-resolved markets (>0.90 or <0.10) — no room by construction;
    the lag we hunt lives in genuinely uncertain markets that news moves."""
    mid = (bid + ask) / 2
    if not 0.10 < mid < 0.90:
        return 0.0, None, None
    mat = magnitude / 5.0
    if direction == "bull":
        return mat * (1.0 - ask), "YES", ask
    if direction == "bear":
        no_ask = round(1.0 - bid, 3)      # buying NO = selling YES at the bid
        return mat * bid, "NO", no_ask
    return 0.0, None, None


async def resolve_open(s) -> None:
    rows = [json.loads(l) for l in LOG.open()] if LOG.exists() else []
    resolved = {r["slug"] for r in rows if r["type"] == "nresolve"}
    for t in rows:
        if t["type"] != "ntrade" or t["slug"] in resolved:
            continue
        m = await jget(s, f"{GAMMA}/markets", params={"slug": t["slug"]})
        if not m:
            continue
        mk = m[0]
        if not mk.get("closed"):
            continue
        try:
            yes_won = float(json.loads(mk["outcomePrices"])[0]) > 0.5
        except Exception:
            continue
        won = (t["side"] == "YES") == yes_won
        pnl = round(t["stake"] * (1 / t["entry"] - 1) if won else -t["stake"], 2)
        log_write({"type": "nresolve", "slug": t["slug"], "won": won,
                   "pnl": pnl, "ts": int(time.time())})
        print(f"[newslag] {t['slug'][:40]} {t['side']} → "
              f"{'WON' if won else 'LOST'} {pnl:+.2f}", flush=True)


async def main() -> None:
    print(f"[newslag] started — brody-pipeline architecture, niche <${MAX_VOLUME:,}, "
          f"paper quarter-Kelly on ${BANKROLL:.0f}", flush=True)
    async with aiohttp.ClientSession() as s:
        while True:
            try:
                if not bot_enabled("newslag"):
                    await asyncio.sleep(POLL_S)
                    continue
                await resolve_open(s)

                done = processed_uuids()
                held = open_slugs()
                cards = [c for c in load_news_cards()
                         if c.get("magnitude", 0) >= MIN_MAGNITUDE
                         and c["uuid"] not in done
                         and time.time() - c["_ts"] < 12 * 3600]
                if cards:
                    markets = await niche_markets(s)
                    for c in cards:
                        best, best_score = None, 0.0
                        for m in markets:
                            if m["slug"] in held:
                                continue
                            sc = match_score(f"{c['title']} {c.get('sym','')}", m["q"])
                            if sc >= MATCH_MIN_SCORE and sc > best_score:
                                best, best_score = m, sc
                        if not best:
                            continue
                        edge, side, entry = edge_v2(
                            c.get("direction", "mixed"), c.get("magnitude", 0),
                            best["bid"], best["ask"])
                        rec = {"type": "ntrade", "news_uuid": c["uuid"],
                               "headline": c["title"][:120],
                               "slug": best["slug"], "market_q": best["q"][:120],
                               "match_score": round(best_score, 2),
                               "direction": c.get("direction"),
                               "magnitude": c.get("magnitude"),
                               "edge": round(edge, 3), "side": side,
                               "entry": entry, "vol": best["vol"],
                               "traded": False, "stake": 0.0,
                               "ts": int(time.time())}
                        if side and entry and 0.02 < entry < 0.95 and edge >= EDGE_THRESHOLD:
                            stake = round(min(25.0, max(5.0, BANKROLL * edge * 0.25 / 4)), 2)
                            rec.update({"traded": True, "stake": stake})
                            print(f"[newslag] TRADE {side} @ {entry} edge {edge:.2f} "
                                  f"· {c['title'][:60]} ↔ {best['q'][:60]}", flush=True)
                        log_write(rec)
            except Exception as exc:
                print(f"[newslag] cycle error: {exc}", flush=True)
            await asyncio.sleep(POLL_S)


if __name__ == "__main__":
    asyncio.run(main())
