"""
BTC ORACLE-LAG daemon — the real edge, paper-tested at executable prices.

Thesis (backtested +9.5σ on 1000 windows): the FIRST-MINUTE move of a 5-min
Up/Down window predicts the window's close-vs-open direction 74-87% of the time
(vs 51% coin-flip for pre-window momentum). If Polymarket's price lags that
realized move, we have an edge.

Each window, at ~70s in (first 1-min bar has closed):
  - read window-open price and current spot (Binance)
  - if |first-minute move| ≥ MIN_BP → directional signal
  - fetch the LIVE CLOB ask for that side
  - PAPER-TRADE only if ask < MAX_ENTRY (room for the ~74% edge to pay)
  - resolve via Gamma settlement; log everything incl. the ask (so we learn
    whether the price actually lags)

Log: logs/dryrun_oraclelag.jsonl  {"type":"olentry"|"olresolve", ...}
"""
from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

import aiohttp

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from tuned import tuned as _tuned          # live auto-tuner knob reads

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_oraclelag.jsonl"
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
BINANCE = "https://api.binance.com"

STAKE = 10.0
ENTRY_AT_S = 72          # after the first 1-min bar closes (60s) + settle margin
MIN_BP = 3.0             # backtest-validated (74.5% @3bp); 4bp starved weekend data
# ── 137-trade forensic autopsy (2026-07-24) — the mispricing band + side edge ──
# The full traded record was 58% / −$66.60, dragged by three proven loopholes:
#   • DOWN side:        25/53 = 47%, −$148  (no edge — likely a structural retail
#                       UP-bias in Polymarket pricing; revisit only with a real
#                       DOWN-specific meta-label, not before).
#   • expensive entries: ask 0.65-0.70 won 65-68% but lost −$50 (payoff too small
#                       vs fee + the 0.66 loss/win asymmetry).
#   • too-cheap entries: ask≈0.40 (market strongly disagrees) went 1/6, −$34.
# The ONLY config positive in BOTH halves: UP + 0.45 ≤ ask ≤ 0.62 → 70% (32/46),
# +$117, H1 +$38 / H2 +$79. That is the deployed gate below.
MIN_ENTRY = 0.45         # below this the market disagrees too hard (contrarian losers)
MAX_ENTRY = 0.62         # above this the win is too small to clear fees
SIDES = {"UP"}           # DOWN disabled: 47%/−$148 over 53 trades, both halves red
MAX_HOLD_WINDOWS = 3
PROBE_OFFSETS = [12, 24, 36, 48, 60, 72]   # ask-vs-move samples per window


def log_write(rec: dict) -> None:
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")


_ML = {"ts": 0, "doc": None}

def metalabel_pwin(rec: dict) -> float | None:
    """P(win) from the trained meta-label — None unless status == 'active'."""
    import math as _m
    now = time.time()
    if now - _ML["ts"] > 300:          # reload at most every 5 min
        _ML["ts"] = now
        try:
            _ML["doc"] = json.loads((ROOT / ".data" / "metalabel_oraclelag.json").read_text())
            _ML["skl"] = None          # reload the pickle too (fresh retrain)
        except Exception:
            _ML["doc"] = None
    doc = _ML["doc"]
    if not doc or doc.get("status") != "active" or not doc.get("coef"):
        return None
    ask = rec.get("ask")
    mv = rec.get("move_bp")
    if not isinstance(ask, (int, float)) or not isinstance(mv, (int, float)):
        return None
    imb = (rec.get("book") or {}).get("imbalance")
    hour = time.gmtime(rec.get("ts", int(now))).tm_hour
    exch = rec.get("exch") or {}
    num = lambda v: float(v) if isinstance(v, (int, float)) else 0.0
    x = [1.0, abs(mv), float(mv), float(ask),   # signed move added (RD-Agent find)
         num(imb),
         _m.sin(2 * _m.pi * hour / 24), _m.cos(2 * _m.pi * hour / 24),
         num(exch.get("consensus_bp")), num(exch.get("dispersion_bp")),
         num(exch.get("agree")), num(rec.get("cl_move_bp")),
         num(rec.get("news_10m"))]
    # prefer the VALIDATED sklearn bagged model (the one that earned the AUC);
    # fall back to the pure-python coef only if the pickle is unavailable
    if _ML.get("skl") is None and doc.get("model_file"):
        try:
            import pickle
            _ML["skl"] = pickle.loads((ROOT / ".data" / doc["model_file"]).read_bytes())
        except Exception:
            _ML["skl"] = False
    if _ML.get("skl"):
        try:
            return round(float(_ML["skl"].predict_proba([x[1:]])[0][1]), 4)
        except Exception:
            pass
    z = sum(w * xi for w, xi in zip(doc["coef"], x))
    return round(1 / (1 + _m.exp(-max(-30, min(30, z)))), 4)


async def jget(s, url, **kw):
    for _ in range(2):
        try:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=8), **kw) as r:
                if r.status == 200:
                    return await r.json()
        except Exception:
            await asyncio.sleep(1)
    return None


# Chainlink BTC/USD on-chain feed (Polygon) — Polymarket's RESOLUTION source
# family. Binance leads it; the lag is the edge. Logged at entry for analysis.
CHAINLINK_FEED = "0xc907E116054Ad103354f2D350FD2514433D57F6f"
CHAINLINK_RPC = "https://polygon-bor-rpc.publicnode.com"


async def chainlink_btc(s) -> float | None:
    try:
        async with s.post(CHAINLINK_RPC, json={"jsonrpc": "2.0", "id": 1,
            "method": "eth_call", "params": [{"to": CHAINLINK_FEED,
            "data": "0xfeaf968c"}, "latest"]},
            timeout=aiohttp.ClientTimeout(total=6)) as r:
            d = await r.json()
            raw = d.get("result", "0x")
            if len(raw) > 128:
                return int(raw[2 + 64:2 + 128], 16) / 1e8
    except Exception:
        pass
    return None


async def first_minute_signal(s, win: int) -> dict | None:
    """First-minute realized move = the backtested signal.

    MUST be measured on the first COMPLETED 1-min bar (open→close of the bar
    starting at win), independent of how many seconds into the window we enter.
    Reading kl[-1] instead let a late/forming second bar corrupt the signal.
    `spot` (fresh ticker) is only for the Chainlink-lag diagnostic.
    """
    kl = await jget(s, f"{BINANCE}/api/v3/klines",
                    params={"symbol": "BTCUSDT", "interval": "1m",
                            "startTime": win * 1000, "limit": 2})
    if not kl:
        return None
    b0 = kl[0]                       # bar [win, win+60] — complete by entry time
    w_open = float(b0[1])
    close_1m = float(b0[4])
    move_bp = (close_1m - w_open) / w_open * 10000
    side = "UP" if move_bp >= MIN_BP else "DOWN" if move_bp <= -MIN_BP else None
    tk = await jget(s, f"{BINANCE}/api/v3/ticker/price",
                    params={"symbol": "BTCUSDT"})
    spot = float(tk["price"]) if tk and "price" in tk else close_1m
    return {"w_open": w_open, "cur": spot, "move_bp": round(move_bp, 2), "side": side}


async def shadow_execution(s, token: str, paper_ask: float, stake: float,
                           delay: float = 1.5) -> dict | None:
    """SHADOW-LIVE measurement — no order is placed. The paper trade assumes it
    fills instantly at `paper_ask`. Reality: by the time a REST order actually
    reaches the CLOB (~1-2s later) faster bots have repriced, and a marketable
    buy must WALK the ask ladder. This waits a realistic latency, re-quotes, and
    volume-weights the true fill for `stake` — quantifying the adverse-selection
    and slippage that decide whether this latency edge survives real execution."""
    await asyncio.sleep(delay)
    try:
        async with s.get(f"{CLOB}/book", params={"token_id": token},
                         timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                return None
            b = await r.json()
    except Exception:
        return None
    asks = sorted(({"p": float(a["price"]), "sz": float(a["size"])}
                   for a in (b.get("asks") or [])), key=lambda a: a["p"])
    if not asks:
        return None
    reprice = asks[0]["p"]                       # best ask AFTER latency
    need, spent, shares = stake, 0.0, 0.0        # walk the ladder for `stake` $
    for lvl in asks:
        take = min(need, lvl["p"] * lvl["sz"])
        shares += take / lvl["p"]
        spent += take
        need -= take
        if need <= 1e-9:
            break
    if shares <= 0:
        return None
    vwap = spent / shares                        # true average fill price
    return {
        "shadow_ask": round(reprice, 4),
        "shadow_fill": round(vwap, 4),
        "adverse": round(reprice - paper_ask, 4),   # ask moved this much vs paper
        "slip": round(vwap - paper_ask, 4),         # full realized execution gap
        "unfilled": round(need, 2),                 # >0 = book too thin for stake
        "lat_s": delay,
    }


async def book_imbalance(s, token: str) -> dict | None:
    """Top-of-book depth imbalance — the Polymarket-microstructure paper's
    most predictive feature (net order imbalance predicts returns). Logged at
    entry so the future meta-label can learn P(win | imbalance, ...)."""
    try:
        async with s.get(f"{CLOB}/book", params={"token_id": token},
                         timeout=aiohttp.ClientTimeout(total=6)) as r:
            if r.status != 200:
                return None
            b = await r.json()
            bid_sz = sum(float(x["size"]) for x in (b.get("bids") or [])[:3])
            ask_sz = sum(float(x["size"]) for x in (b.get("asks") or [])[:3])
            tot = bid_sz + ask_sz
            return {"bid_depth3": round(bid_sz, 1), "ask_depth3": round(ask_sz, 1),
                    "imbalance": round((bid_sz - ask_sz) / tot, 3) if tot else None}
    except Exception:
        return None


async def exchange_moves(s, win: int) -> dict | None:
    """MULTI-EXCHANGE CONSENSUS: first-minute move on Coinbase, Kraken, OKX
    (public candle APIs, no keys). Chainlink aggregates many venues, so
    cross-exchange AGREEMENT should predict the resolution print better than
    Binance alone; DISPERSION = real uncertainty."""
    out = {}
    try:
        # Coinbase: 1m candles [time, low, high, open, close, vol]
        d = await jget(s, "https://api.exchange.coinbase.com/products/BTC-USD/candles",
                       params={"granularity": 60, "start": win, "end": win + 60})
        if d:
            c = next((k for k in d if int(k[0]) == win), d[-1])
            out["coinbase"] = round((c[4] - c[3]) / c[3] * 10000, 2)
    except Exception:
        pass
    try:
        # OKX: 1m candles [ts_ms, o, h, l, c, ...]
        d = await jget(s, "https://www.okx.com/api/v5/market/history-candles",
                       params={"instId": "BTC-USDT", "bar": "1m",
                               "after": str((win + 60) * 1000), "limit": "1"})
        k = (d or {}).get("data") or []
        if k:
            o, c = float(k[0][1]), float(k[0][4])
            out["okx"] = round((c - o) / o * 10000, 2)
    except Exception:
        pass
    try:
        # Kraken: OHLC [time, o, h, l, c, ...]
        d = await jget(s, "https://api.kraken.com/0/public/OHLC",
                       params={"pair": "XBTUSD", "interval": 1, "since": win - 1})
        res = list(((d or {}).get("result") or {}).values())
        rows = res[0] if res and isinstance(res[0], list) else []
        k = next((r for r in rows if int(r[0]) == win), None)
        if k:
            o, c = float(k[1]), float(k[4])
            out["kraken"] = round((c - o) / o * 10000, 2)
    except Exception:
        pass
    if not out:
        return None
    vals = list(out.values())
    mean = sum(vals) / len(vals)
    disp = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
    signs = [1 if v > 0 else -1 if v < 0 else 0 for v in vals]
    return {**out, "consensus_bp": round(mean, 2),
            "dispersion_bp": round(disp, 2),
            "agree": abs(sum(signs))}          # n exchanges agreeing on direction


_NEWS_CACHE = {"ts": 0.0, "stamps": []}

async def crypto_news_count(s) -> int | None:
    """NEWS SHOCK: headlines in the last 10 min (CoinDesk RSS, 2-min cache).
    A fresh headline at window-open = event-driven regime, not drift."""
    import re as _re
    from email.utils import parsedate_to_datetime
    now = time.time()
    if now - _NEWS_CACHE["ts"] > 120:
        try:
            async with s.get("https://www.coindesk.com/arc/outboundfeeds/rss/",
                             timeout=aiohttp.ClientTimeout(total=8),
                             headers={"User-Agent": "Mozilla/5.0"}) as r:
                txt = await r.text()
            stamps = []
            for m in _re.findall(r"<pubDate>([^<]+)</pubDate>", txt):
                try:
                    stamps.append(parsedate_to_datetime(m.strip()).timestamp())
                except Exception:
                    pass
            _NEWS_CACHE.update(ts=now, stamps=stamps)
        except Exception:
            _NEWS_CACHE["ts"] = now          # don't hammer on failure
    return sum(1 for t in _NEWS_CACHE["stamps"] if now - t < 600)


async def clob_ask(s, tokens: list[str]) -> dict[str, float]:
    try:
        async with s.post(f"{CLOB}/prices",
                          json=[{"token_id": t, "side": "SELL"} for t in tokens],
                          timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                return {}
            return {k: float(v["SELL"]) for k, v in (await r.json()).items()}
    except Exception:
        return {}


async def gamma_market(s, win: int):
    ev = await jget(s, f"{GAMMA}/events", params={"slug": f"btc-updown-5m-{win}"})
    if not ev:
        return None
    m = ev[0]["markets"][0]
    try:
        tokens = json.loads(m["clobTokenIds"])
    except Exception:
        tokens = []
    try:
        outcome = json.loads(m["outcomePrices"])
    except Exception:
        outcome = []                      # just-opened market — no prices yet
    return {"closed": bool(m.get("closed")), "tokens": tokens,
            "outcome": outcome}


async def resolve_pending(s, pending: dict) -> None:
    now = time.time()
    for wid in list(pending):
        e = pending[wid]
        if not e.get("entry"):        # defensive: never resolve a non-traded row
            del pending[wid]
            continue
        if now < e["win"] + 320:
            continue
        m = await gamma_market(s, e["win"])
        if not m or not m["closed"] or len(m["outcome"]) < 2:
            if now > e["win"] + 7200:
                # NEVER silently drop a traded entry — record the void so the
                # trade count stays honest (survivorship guard)
                log_write({"type": "olvoid", "win": e["win"],
                           "reason": "unresolved-2h", "ts": int(time.time())})
                del pending[wid]
            continue
        up_won = float(m["outcome"][0]) > 0.5
        won = (e["side"] == "UP") == up_won
        stk = e.get("stake") or STAKE
        # CLOB taker fee (crypto peak 1.8% × 4p(1−p)) — charged on every fill;
        # omitting it overstated every historical P&L number
        fee = stk * 0.018 * 4 * e["entry"] * (1 - e["entry"])
        pnl = round((stk * (1 / e["entry"] - 1) if won else -stk) - fee, 2)
        res = {"type": "olresolve", "win": e["win"], "up_won": up_won,
               "won": won, "pnl": pnl, "ts": int(time.time())}
        # SHADOW P&L: same outcome, but priced at the REAL fill we'd have gotten.
        # The gap between pnl and shadow_pnl is the true cost of live execution.
        sh = e.get("shadow")
        if sh and sh.get("shadow_fill"):
            sf = sh["shadow_fill"]
            s_fee = stk * 0.018 * 4 * sf * (1 - sf)
            res["shadow_pnl"] = round((stk * (1 / sf - 1) if won else -stk) - s_fee, 2)
        log_write(res)
        print(f"[oraclelag] BTC {e['side']} → {'WON' if won else 'LOST'} {pnl:+.2f}"
              + (f" (shadow {res['shadow_pnl']:+.2f})" if 'shadow_pnl' in res else ""), flush=True)
        del pending[wid]


async def main() -> None:
    print(f"[oraclelag] started — logging to {LOG}", flush=True)
    pending: dict[int, dict] = {}
    # reload pending from log so restarts don't lose in-flight windows
    if LOG.exists():
        seen_res = {r["win"] for r in (json.loads(l) for l in LOG.open()) if r["type"] == "olresolve"}
        for line in LOG.open():
            r = json.loads(line)
            # only traded entries are resolvable — non-traded rows have entry=None
            if (r["type"] == "olentry" and r.get("traded")
                    and r.get("entry") and r["win"] not in seen_res):
                pending[r["win"]] = r

    # every window already logged (traded or not) — process each exactly once
    done: set[int] = set()
    if LOG.exists():
        done = {r["win"] for r in (json.loads(l) for l in LOG.open())
                if r["type"] == "olentry"}

    async with aiohttp.ClientSession() as s:
        while True:
            now = time.time()
            win = int(now // 300) * 300
            if win in done or now > win + PROBE_OFFSETS[0] + 6:
                win += 300                 # this window started/handled → next one
            await asyncio.sleep(max(0, win + PROBE_OFFSETS[0] - time.time()))

            await resolve_pending(s, pending)

            if win in done:
                await asyncio.sleep(5)
                continue
            done.add(win)
            if len(done) > 2000:           # bound memory: keep recent windows only
                done = {w for w in done if w >= win - 300 * 2000}
            try:
                m = await gamma_market(s, win)
                if not m or m["closed"] or len(m["tokens"]) != 2:
                    continue

                # ── PROBE: where does the CLOB reprice? At 72s the ask is
                # already 0.73-0.91 (edge fully priced). Sample move + both
                # asks through the first 72s to find the mispricing window.
                samples = []
                w_open = None
                for off in PROBE_OFFSETS:
                    await asyncio.sleep(max(0, win + off - time.time()))
                    tk = await jget(s, f"{BINANCE}/api/v3/ticker/price",
                                    params={"symbol": "BTCUSDT"})
                    if w_open is None:
                        kl = await jget(s, f"{BINANCE}/api/v3/klines",
                                        params={"symbol": "BTCUSDT", "interval": "1m",
                                                "startTime": win * 1000, "limit": 1})
                        w_open = float(kl[0][1]) if kl else None
                    spot = float(tk["price"]) if tk and "price" in tk else None
                    asks = await clob_ask(s, m["tokens"])
                    cl = await chainlink_btc(s)
                    if spot and w_open:
                        samples.append({
                            "t": off,
                            "move_bp": round((spot - w_open) / w_open * 10000, 2),
                            "up_ask": asks.get(m["tokens"][0]),
                            "down_ask": asks.get(m["tokens"][1]),
                            "chainlink": cl,
                        })
                log_write({"type": "olprobe", "win": win, "w_open": w_open,
                           "samples": samples, "ts": int(time.time())})

                sig = await first_minute_signal(s, win)
                if not sig:
                    continue
                cl = await chainlink_btc(s)
                # chainlink lag vs binance now (bp): + = binance ahead → still catching up
                cl_lag_bp = round((sig["cur"] - cl) / cl * 10000, 2) if cl else None
                # CHAINLINK'S OWN MOVE (the resolution source's trajectory),
                # from the probe samples we already collected this window
                cl_pts = [sm["chainlink"] for sm in samples
                          if isinstance(sm.get("chainlink"), (int, float))]
                cl_move_bp = (round((cl_pts[-1] - cl_pts[0]) / cl_pts[0] * 10000, 2)
                              if len(cl_pts) >= 2 else None)
                exch = await exchange_moves(s, win)
                news10 = await crypto_news_count(s)
                rec = {"type": "olentry", "win": win, "move_bp": sig["move_bp"],
                       "w_open": sig["w_open"], "side": sig["side"],
                       "chainlink": cl, "cl_lag_bp": cl_lag_bp,
                       "cl_move_bp": cl_move_bp, "exch": exch, "news_10m": news10,
                       "traded": False, "entry": None, "ts": int(time.time())}
                if sig["side"]:
                    asks = await clob_ask(s, m["tokens"])
                    tok = m["tokens"][0] if sig["side"] == "UP" else m["tokens"][1]
                    ask = asks.get(tok)
                    rec["ask"] = ask
                    rec["book"] = await book_imbalance(s, tok)
                    # meta-label gate (López de Prado): once the trained model
                    # proves OOS lift, only trade when P(win) > ask (breakeven).
                    # Until then p_win stays None and nothing is gated.
                    p_win = metalabel_pwin(rec)
                    rec["p_win"] = p_win
                    # FEE-AWARE breakeven: EV≥0 requires p > ask·(1+fee_rate)
                    # (the old p>ask gate ignored the taker fee)
                    fee_rate = 0.018 * 4 * (ask or 0) * (1 - (ask or 0))
                    gate_ok = p_win is None or (ask and p_win > ask * (1 + fee_rate))
                    side_ok = sig["side"] in SIDES
                    max_entry = _tuned("oraclelag", "MAX_ENTRY", MAX_ENTRY)  # auto-tuner
                    min_entry = _tuned("oraclelag", "MIN_ENTRY", MIN_ENTRY)
                    # news-skip: a headline in the window breaks the calm-repricing
                    # edge (40%/−$6 vs quiet 70%/+$115) — sit those windows out.
                    quiet = (news10 or 0) == 0
                    if ask and min_entry <= ask <= max_entry and side_ok and gate_ok and quiet:
                        # EDGE-SCALED SIZING (quarter-Kelly): the gate is 61%
                        # accurate — let conviction size the bet. f* = edge/odds,
                        # quartered, bounded $5-$30. Flat $10 wastes the model.
                        stake = STAKE
                        if p_win is not None:
                            b = (1 - ask) / ask                 # net odds
                            kelly = (p_win * b - (1 - p_win)) / b if b > 0 else 0
                            stake = round(max(5.0, min(30.0, 100 * max(0, kelly) * 0.25 + 5)), 2)
                        rec.update({"traded": True, "entry": ask, "stake": stake})
                        # SHADOW-LIVE: measure the real fill (no order placed) to
                        # test whether the paper edge survives real execution.
                        shadow = await shadow_execution(s, tok, ask, stake)
                        if shadow:
                            rec["shadow"] = shadow
                        print(f"[oraclelag] TRADE BTC {sig['side']} @ {ask} ${stake} "
                              f"(p_win {p_win}, 1st-min {sig['move_bp']:+.1f}bp"
                              + (f", shadow slip {shadow['slip']:+.3f}" if shadow else "")
                              + ")", flush=True)
                        # micro-live if enabled (same gates as other bots)
                        try:
                            import sys as _sys
                            _sys.path.insert(0, str(Path(__file__).resolve().parent))
                            from live_micro import live_config, place_micro_buy
                            from bot_switch import bot_enabled
                            if bot_enabled("oraclelag") and live_config()[0]:
                                place_micro_buy("oraclelag", tok, f"BTC {sig['side']} 5m", ask)
                        except Exception as exc:
                            print(f"[oraclelag] live-micro err: {exc}", flush=True)
                log_write(rec)
                if rec["traded"]:
                    pending[win] = rec
            except Exception as exc:
                print(f"[oraclelag] cycle error: {exc}", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
