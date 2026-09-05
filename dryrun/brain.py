"""
BRAIN — the reflection loop. Perception → attribution → memory → bounded action.

What it does, every run (overnight loop calls it hourly):
  1. PERCEIVE  — load every strategy's resolved trades with segment dimensions
                 (asset, side, city, hour-of-day, entry band).
  2. ATTRIBUTE — slice each strategy by each dimension; z-score the win rate
                 against the breakeven rate implied by that segment's median
                 entry price. Losses get a WHERE, not just a number.
  3. REMEMBER  — write lessons to .data/brain_lessons.json, a per-day P&L
                 rollup to .data/journal_days.json (journal UI), and a daily
                 note to logs/journal.jsonl (the intel journal the system
                 already reads).
  4. ACT (bounded) — flip per-segment arming in .data/params_kronos.json when
                 a bleeder is stable across BOTH chronological halves. Weather
                 and crypto actuation stays owned by learner.py — the brain
                 only recommends there (no duplicate actuators).

Design follows the validated reflection-agent pattern: diagnose → lesson →
guarded action, with reality (resolved trades) as the only feedback signal.

Usage: .venv/bin/python dryrun/brain.py
"""
from __future__ import annotations

import json
import math
import time
from datetime import datetime, timezone
from pathlib import Path

import sys as _sys
_sys.path.insert(0, str(Path(__file__).resolve().parent))
from tuned import tuned as _tuned          # so the dashboard record matches the LIVE gates

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
DATA = ROOT / ".data"

MIN_N = 5              # segment must have ≥5 resolved trades to judge
Z_FLAG = 1.5           # |z| beyond this = flag
STAKE = 10.0


def load(name: str) -> list[dict]:
    p = LOGS / name
    if not p.exists():
        return []
    out = []
    for line in p.open():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


def day_of(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")


# ── 1. PERCEIVE — one row per resolved trade, with segment dims ──────────────

def crypto_trades() -> list[dict]:
    rows = load("dryrun_5m.jsonl")
    ent = {r["id"]: r for r in rows if r["type"] == "entry"}
    out = []
    for r in rows:
        e = ent.get(r.get("id"))
        if r["type"] != "resolve" or not e or not e.get("traded"):
            continue
        if not isinstance(r.get("pnl"), (int, float)):
            continue
        entry = e["up_price"] if e["side"] == "UP" else e["down_price"]
        out.append({"strategy": "crypto-5m", "ts": e["ts"], "pnl": r["pnl"],
                    "won": bool(r.get("won")), "entry": entry,
                    "asset": e.get("asset"), "side": e.get("side"),
                    "hour": datetime.fromtimestamp(e["ts"], tz=timezone.utc).hour})
    return out


def weather_trades() -> list[dict]:
    rows = load("dryrun_weather.jsonl")
    res = {r["slug"]: r for r in rows if r["type"] == "resolve"}
    out = []
    for t in rows:
        if t["type"] != "wtrade" or t["slug"] not in res:
            continue
        r = res[t["slug"]]
        won_b = t["low"] == r["winning_low"] and t["high"] == r["winning_high"]
        win = won_b if t["side"] == "YES" else not won_b
        pnl = t["stake"] * (1 / t["entry"] - 1) if win else -t["stake"]
        out.append({"strategy": "weather", "ts": t["ts"], "pnl": round(pnl, 2),
                    "won": win, "entry": t["entry"],
                    "city": t.get("city"), "side": t.get("side"),
                    "hour": t.get("hours_elapsed")})
    return out


def kronos_trades() -> list[dict]:
    rows = load("dryrun_kronos1h.jsonl")
    ent = {r["id"]: r for r in rows if r["type"] == "kentry"}
    out = []
    for r in rows:
        e = ent.get(r.get("id"))
        if r["type"] != "kresolve" or not e or not e.get("traded"):
            continue
        if not isinstance(r.get("pnl"), (int, float)):
            continue
        out.append({"strategy": "kronos1h", "ts": r["ts"], "pnl": r["pnl"],
                    "won": bool(r.get("won")), "entry": e.get("entry"),
                    "asset": e.get("asset"), "side": e.get("side")})
    return out


def oraclelag_trades() -> list[dict]:
    rows = load("dryrun_oraclelag.jsonl")
    ent = {r["win"]: r for r in rows if r["type"] == "olentry"}
    out = []
    for r in rows:
        e = ent.get(r.get("win"))
        if r["type"] != "olresolve" or not e or not e.get("traded"):
            continue
        if not isinstance(r.get("pnl"), (int, float)):
            continue
        out.append({"strategy": "btc-oraclelag", "ts": r["ts"], "pnl": r["pnl"],
                    "won": bool(r.get("won")), "entry": e.get("entry"),
                    "side": e.get("side")})
    return out


def premarket_trades() -> list[dict]:
    return [{"strategy": "premarket", "ts": r.get("ts", 0), "pnl": r["pnl"],
             "won": r["pnl"] > 0, "entry": None,
             "symbol": r.get("symbol"), "hit": r.get("hit")}
            for r in load("dryrun_premarket.jsonl")
            if r["type"] == "outcome" and isinstance(r.get("pnl"), (int, float))]


def options_trades() -> list[dict]:
    rows = load("dryrun_options.jsonl")
    pos = {r["id"]: r for r in rows if r["type"] == "position"}
    # closed positions are realized: their P&L is the close, not a stale mark.
    closed = {r["id"]: r for r in rows if r["type"] == "close"}
    latest = {}
    for m in rows:
        if m["type"] == "mark" and (m["id"] not in latest or m["ts"] > latest[m["id"]]["ts"]):
            latest[m["id"]] = m
    out = []
    for pid, p in pos.items():
        c = closed.get(pid)
        if c:                                   # realized (stop/target/expiry)
            pnl, ts = c["realized"], c["ts"]
        elif pid in latest:                     # still open — mark to market
            pnl, ts = latest[pid]["unrealized"], latest[pid]["ts"]
        else:
            continue                            # opened, never priced
        out.append({"strategy": "options", "ts": ts, "pnl": pnl,
                    "won": pnl > 0, "entry": None, "symbol": p.get("symbol"),
                    "kind": p.get("kind"), "side": p.get("opt_type"),
                    "closed": c is not None})
    return out


def vwap_trades() -> list[dict]:
    return [{"strategy": "vwap-trend", "ts": r["ts"], "pnl": r["pnl"],
             "won": r["pnl"] > 0, "entry": None,
             "symbol": r.get("symbol"), "side": r.get("side"),
             "hit": r.get("reason")}
            for r in load("dryrun_vwap.jsonl")
            if r["type"] == "vclose" and isinstance(r.get("pnl"), (int, float))
            and r.get("reason") != "stale-restart"]


def newslag_trades() -> list[dict]:
    rows = load("dryrun_newslag.jsonl")
    ent = {r["slug"]: r for r in rows if r["type"] == "ntrade" and r.get("traded")}
    return [{"strategy": "news-lag", "ts": r["ts"], "pnl": r["pnl"],
             "won": bool(r.get("won")), "entry": ent.get(r["slug"], {}).get("entry"),
             "side": ent.get(r["slug"], {}).get("side")}
            for r in rows if r["type"] == "nresolve"
            and isinstance(r.get("pnl"), (int, float)) and r["slug"] in ent]


PERCEIVERS = [crypto_trades, weather_trades, kronos_trades, oraclelag_trades,
              premarket_trades, options_trades, vwap_trades, newslag_trades]
SEGMENT_DIMS = ["asset", "side", "city", "hour", "symbol", "kind", "hit"]


# ── 2. ATTRIBUTE — per-segment win-rate z-score vs breakeven ─────────────────

def breakeven_rate(entries: list) -> float:
    """Win rate needed to break even at the segment's median entry price."""
    pxs = [e for e in entries if isinstance(e, (int, float)) and 0 < e < 1]
    if not pxs:
        return 0.5
    pxs.sort()
    return pxs[len(pxs) // 2]        # buy at p → need p to break even


def attribute(trades: list[dict]) -> list[dict]:
    lessons = []
    by_strat: dict[str, list[dict]] = {}
    for t in trades:
        by_strat.setdefault(t["strategy"], []).append(t)

    for strat, ts in by_strat.items():
        ts.sort(key=lambda t: t["ts"])
        for dim in SEGMENT_DIMS:
            segs: dict = {}
            for t in ts:
                v = t.get(dim)
                if v is None:
                    continue
                segs.setdefault(v, []).append(t)
            for val, seg in segs.items():
                n = len(seg)
                if n < MIN_N:
                    continue
                wins = sum(1 for t in seg if t["won"])
                pnl = round(sum(t["pnl"] for t in seg), 2)
                be = breakeven_rate([t.get("entry") for t in seg])
                z = (wins - n * be) / max(1e-9, math.sqrt(n * be * (1 - be)))
                if abs(z) < Z_FLAG:
                    continue
                # stability: same sign of P&L in both chronological halves
                h = n // 2
                p1 = sum(t["pnl"] for t in seg[:h])
                p2 = sum(t["pnl"] for t in seg[h:])
                stable = (p1 < 0 and p2 < 0) if z < 0 else (p1 > 0 and p2 > 0)
                lessons.append({
                    "strategy": strat, "segment": f"{dim}={val}",
                    "n": n, "wins": wins, "pnl": pnl,
                    "breakeven": round(be, 2), "z": round(z, 2),
                    "stable": stable,
                    "kind": "BLEEDER" if z < 0 else "EDGE",
                    "note": (f"{strat} {dim}={val}: {wins}/{n} won (needs "
                             f"{be:.0%} to break even) → z={z:+.1f}, "
                             f"P&L ${pnl:+.2f}"
                             + (" [stable both halves]" if stable else " [unstable]")),
                })
    lessons.sort(key=lambda l: l["z"])
    return lessons


# ── 3. REMEMBER — daily rollup + lessons + journal note ──────────────────────

def daily_rollup(trades: list[dict]) -> dict:
    days: dict = {}
    for t in trades:
        d = day_of(t["ts"])
        s = t["strategy"]
        rec = days.setdefault(d, {}).setdefault(
            s, {"trades": 0, "wins": 0, "pnl": 0.0})
        rec["trades"] += 1
        rec["wins"] += int(t["won"])
        rec["pnl"] = round(rec["pnl"] + t["pnl"], 2)
    # win probability per strategy-day: Beta(1,1) posterior mean
    for d, strats in days.items():
        for s, rec in strats.items():
            rec["win_prob"] = round((rec["wins"] + 1) / (rec["trades"] + 2), 3)
    return days


# ── 3b. ALLOCATE — discounted Thompson sampling over strategies ──────────────
# Non-stationary bandit (Regime-Switching Bandits / Thompson-portfolio
# literature): each strategy is an arm with a Beta posterior over win rate,
# where outcomes DECAY with a 14-day half-life so the posterior forgets old
# regimes. Allocation weight ∝ P(sampled win rate beats breakeven), estimated
# by Monte Carlo draws from the posterior. ADVISORY for now — daemons keep
# fixed $10 paper stakes; this is the sizing signal for when one goes live.

HALF_LIFE_DAYS = 14.0

def thompson_allocation(trades: list[dict], n_draws: int = 4000) -> dict:
    import random
    now = time.time()
    arms: dict[str, dict] = {}
    for t in trades:
        w = 0.5 ** ((now - t["ts"]) / 86400 / HALF_LIFE_DAYS)
        a = arms.setdefault(t["strategy"],
                            {"a": 1.0, "b": 1.0, "win_amt": 0.0, "loss_amt": 0.0,
                             "w_wins": 0.0, "w_losses": 0.0})
        if t["won"]:
            a["a"] += w
            a["win_amt"] += w * t["pnl"]
            a["w_wins"] += w
        else:
            a["b"] += w
            a["loss_amt"] += w * abs(t["pnl"])
            a["w_losses"] += w
    out = {}
    raw = {}
    for s, ab in arms.items():
        # payoff-aware breakeven: win rate needed for zero EV given THIS
        # strategy's decayed avg win/loss sizes. Weather wins 3-6× its stake
        # at ~34% win rate and is profitable — a flat 52% bar called it dead.
        avg_w = ab["win_amt"] / ab["w_wins"] if ab["w_wins"] > 0 else 0.0
        avg_l = ab["loss_amt"] / ab["w_losses"] if ab["w_losses"] > 0 else 10.0
        be = avg_l / (avg_w + avg_l) if (avg_w + avg_l) > 0 else 0.52
        be = min(0.95, be + 0.02)          # small margin over exact breakeven
        wins = 0
        for _ in range(n_draws):
            if random.betavariate(ab["a"], ab["b"]) > be:
                wins += 1
        p_beat = wins / n_draws
        raw[s] = p_beat
        out[s] = {"posterior_mean": round(ab["a"] / (ab["a"] + ab["b"]), 4),
                  "eff_n": round(ab["a"] + ab["b"] - 2, 1),
                  "breakeven": round(be, 3),
                  "avg_win": round(avg_w, 2), "avg_loss": round(avg_l, 2),
                  "p_beats_breakeven": round(p_beat, 4)}
    tot = sum(raw.values()) or 1.0
    for s in out:
        out[s]["weight"] = round(raw[s] / tot, 4)
    return out


# ── 3c. CONSOLIDATE — episodic → semantic memory (the "super memory") ────────
# Human-memory mapping, honestly implemented: daily notes are EPISODIC memory;
# this layer consolidates repeated episodes into SEMANTIC principles with
# evidence counts (a lesson that re-proves itself across runs strengthens like
# a synapse; one that flips sign weakens). Principles with strength ≥ 0.7 and
# 3+ confirmations become LONG-TERM and survive any single bad day. Params
# files remain the PROCEDURAL memory (what the daemons actually do).

def consolidate_memory(lessons: list[dict]) -> dict:
    path = DATA / "brain_memory.json"
    mem: dict = {"principles": {}}
    if path.exists():
        try:
            mem = json.loads(path.read_text())
        except Exception:
            pass
    now = int(time.time())
    seen_keys = set()
    for l in lessons:
        if not l["stable"]:
            continue
        key = f"{l['strategy']}|{l['segment']}|{l['kind']}"
        seen_keys.add(key)
        p = mem["principles"].get(key, {
            "note": l["note"], "kind": l["kind"], "strategy": l["strategy"],
            "segment": l["segment"], "for": 0, "against": 0,
            "first_seen": now})
        p["for"] += 1
        p["note"] = l["note"]            # keep the freshest numbers
        p["last_seen"] = now
        mem["principles"][key] = p
    # opposite-kind evidence weakens the stored principle
    for l in lessons:
        opp = f"{l['strategy']}|{l['segment']}|{'EDGE' if l['kind'] == 'BLEEDER' else 'BLEEDER'}"
        if opp in mem["principles"] and l["stable"]:
            mem["principles"][opp]["against"] += 1
    for key, p in mem["principles"].items():
        tot = p["for"] + p["against"]
        p["strength"] = round(p["for"] / tot, 3) if tot else 0.0
        p["long_term"] = bool(p["for"] >= 3 and p["strength"] >= 0.7)
        p["fading"] = bool(now - p.get("last_seen", now) > 7 * 86400)
    mem["ts"] = now
    path.write_text(json.dumps(mem, indent=2))
    return mem


# ── 4. ACT (bounded) — kronos per-asset arming only ──────────────────────────

def actuate(lessons: list[dict]) -> list[str]:
    actions = []
    armed = {"BTC"}          # conservative default — matches the daemon fallback
    p = DATA / "params_kronos.json"
    if p.exists():
        try:
            armed = set(json.loads(p.read_text()).get("armed", ["BTC"]))
        except Exception:
            pass
    for l in lessons:
        if l["strategy"] != "kronos1h" or not l["segment"].startswith("asset="):
            continue
        asset = l["segment"].split("=", 1)[1]
        if l["kind"] == "BLEEDER" and l["stable"] and asset in armed:
            armed.discard(asset)
            actions.append(f"kronos1h: DISARMED {asset} ({l['note']})")
        elif l["kind"] == "EDGE" and l["stable"] and asset not in armed:
            armed.add(asset)
            actions.append(f"kronos1h: RE-ARMED {asset} ({l['note']})")
    DATA.mkdir(exist_ok=True)
    p.write_text(json.dumps({"armed": sorted(armed), "ts": int(time.time())}, indent=2))
    return actions


def engines_status() -> dict:
    """CURRENT-CONFIG records for the live engines — what each is doing UNDER
    ITS PRESENT RULES (the lifetime record mixes pre-fix eras and misleads).
    Fee-true. Consumed by /api/journal → frontend."""
    out = {}
    # oracle-lag: gated trades only (p_win present), fee-adjusted
    rows = load("dryrun_oraclelag.jsonl")
    ent = {r["win"]: r for r in rows if r["type"] == "olentry" and r.get("traded")}
    g = []
    for r in rows:
        e = ent.get(r.get("win"))
        # deployed gate (2026-07-24 autopsy): UP side, 0.45≤ask≤0.62 — the only
        # both-halves-positive slice (70%, +$117); DOWN & out-of-band were the sink.
        if r["type"] == "olresolve" and e and e.get("side") == "UP" \
                and _tuned("oraclelag", "MIN_ENTRY", 0.45) <= (e.get("entry") or 0) <= _tuned("oraclelag", "MAX_ENTRY", 0.62) \
                and (e.get("news_10m") or 0) == 0 \
                and isinstance(r.get("pnl"), (int, float)):
            # use the daemon's LOGGED fee-true pnl (same source the auto-tuner
            # uses) so the dashboard and the AUTO-FIX tab show identical numbers.
            g.append({"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", e.get("ts", 0))})
    def day_split(trades_l, ts_key="ts"):
        """today's record + per-day history for the banner."""
        days: dict = {}
        for t in trades_l:
            d = day_of(t.get(ts_key, 0))
            rec = days.setdefault(d, {"trades": 0, "wins": 0, "pnl": 0.0})
            rec["trades"] += 1
            rec["wins"] += int(t["won"])
            rec["pnl"] = round(rec["pnl"] + t["pnl"], 2)
        today = day_of(int(time.time()))
        return days.get(today, {"trades": 0, "wins": 0, "pnl": 0.0}), \
               [{"day": d, **v} for d, v in sorted(days.items())[-7:]]

    if g:
        w = sum(1 for t in g if t["won"])
        today, daily = day_split(g)
        out["oracle-lag (gated)"] = {
            "trades": len(g), "wins": w, "win_rate": round(w / len(g), 3),
            "pnl": round(sum(t["pnl"] for t in g), 2),
            "today": today, "daily": daily,
            "config": f"UP·quiet, {_tuned('oraclelag','MIN_ENTRY',0.45)}≤ask≤{_tuned('oraclelag','MAX_ENTRY',0.62)}, meta+Kelly"}
    # weather: late-day favorites config (entry≥0.50, h≥14, edge≤0.20)
    rows = load("dryrun_weather.jsonl")
    res = {r["slug"]: r for r in rows if r["type"] == "resolve"}
    wt = []
    for t in rows:
        if (t["type"] == "wtrade" and t["slug"] in res
                and t.get("entry", 0) >= _tuned("weather", "ENTRY_MIN", 0.70)
                and abs(t.get("edge", 0)) <= _tuned("weather", "EDGE_CAP", 0.15)):
            r = res[t["slug"]]
            wb = t["low"] == r["winning_low"] and t["high"] == r["winning_high"]
            win = wb if t["side"] == "YES" else not wb
            e, stk = t["entry"], t["stake"]
            fee = stk * 0.018 * 4 * e * (1 - e)          # same fee model the tuner uses
            wt.append({"won": win, "ts": t.get("ts", 0),
                       "pnl": round((stk * (1 / e - 1) if win else -stk) - fee, 2)})
    if wt:
        w = sum(1 for t in wt if t["won"])
        today_w, daily_w = day_split(wt)
        out["weather (late-day)"] = {
            "trades": len(wt), "wins": w, "win_rate": round(w / len(wt), 3),
            "pnl": round(sum(t["pnl"] for t in wt), 2),
            "today": today_w, "daily": daily_w,
            "config": f"favorites entry≥{_tuned('weather','ENTRY_MIN',0.70)}, edge≤{_tuned('weather','EDGE_CAP',0.15)}"}
    # news-lag (brody-pipeline architecture): niche <$500K, direction+materiality
    rows = load("dryrun_newslag.jsonl")
    nt = {r["slug"]: r for r in rows if r["type"] == "ntrade"}
    nl = []
    for r in rows:
        if r["type"] != "nresolve" or r["slug"] not in nt:
            continue
        t = nt[r["slug"]]
        e, stk = t.get("entry"), t.get("stake") or 10.0
        if not e:
            continue
        fee = stk * 0.018 * 4 * e * (1 - e)          # fee-true, matching other engines
        base = stk * (1 / e - 1) if r["won"] else -stk
        nl.append({"won": r["won"], "pnl": round(base - fee, 2), "ts": r.get("ts", 0)})
    if nl:
        w = sum(1 for t in nl if t["won"])
        today_n, daily_n = day_split(nl)
        out["news-lag (niche)"] = {
            "trades": len(nl), "wins": w, "win_rate": round(w / len(nl), 3),
            "pnl": round(sum(t["pnl"] for t in nl), 2),
            "today": today_n, "daily": daily_n,
            "config": "niche <$500K, direction+materiality×room, quarter-Kelly"}
    # options: a $100 account following the Options-Desk suggestions. Only the
    # current config counts — MAIN legs (penny picks disabled) at proper size
    # (≤10% cap). Each closed leg's return-on-premium is applied to a flat $10
    # bet so the win rate + a real $100-account curve are both visible.
    rows = load("dryrun_options.jsonl")
    pos = {r["id"]: r for r in rows if r["type"] == "position"}
    oclosed = {r["id"]: r for r in rows if r["type"] == "close"}
    ol = []
    for pid, p in pos.items():
        c = oclosed.get(pid)
        if not c or p.get("kind") != "main" or p.get("cost", 0) > 1000 or not p.get("cost"):
            continue
        ret = c["realized"] / p["cost"]                 # return on premium paid
        ol.append({"won": c["realized"] > 0, "pnl": round(10 * ret, 2),  # flat $10 bet
                   "ts": c.get("ts", 0)})
    ol.sort(key=lambda t: t["ts"])
    if ol:
        w = sum(1 for t in ol if t["won"])
        acct = 100.0                                    # start a $100 account
        for t in ol:
            acct += t["pnl"]
        today_o, daily_o = day_split(ol)
        out["options ($100 acct)"] = {
            "trades": len(ol), "wins": w, "win_rate": round(w / len(ol), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_o, "daily": daily_o,
            "config": "main legs, penny OFF, $10/bet — UNPROVEN: 2nd-half turned red"}
    # gamma-pulse: $100 paper account trading the dealer-gamma regime edge
    rows = load("gamma_pulse_paper.jsonl")
    gres = [r for r in rows if r["type"] == "gresolve"]
    if gres:
        gl = [{"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", 0)} for r in gres]
        gl.sort(key=lambda t: t["ts"])
        w = sum(1 for t in gl if t["won"])
        acct = 100.0 + sum(t["pnl"] for t in gl)
        today_g, daily_g = day_split(gl)
        out["gamma-pulse ($100 acct)"] = {
            "trades": len(gl), "wins": w, "win_rate": round(w / len(gl), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_g, "daily": daily_g,
            "config": "dealer-gamma regime (amplified→momentum, dampened→revert), $10/bet — forward-testing"}
    # stocks bot: $100 paper book, multi-factor long/short (realized closes)
    rows = load("stocks_bot.jsonl")
    scl = [r for r in rows if r["type"] == "sclose"]
    if scl:
        sl = [{"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", 0)} for r in scl]
        sl.sort(key=lambda t: t["ts"])
        w = sum(1 for t in sl if t["won"])
        acct = 100.0 + sum(t["pnl"] for t in sl)
        today_s, daily_s = day_split(sl)
        out["stocks-bot ($100 acct)"] = {
            "trades": len(sl), "wins": w, "win_rate": round(w / len(sl), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_s, "daily": daily_s,
            "config": "multi-factor (12m trend + 5d reversal + Faber + low-vol), long/short, 3-day hold — forward-testing"}
    # meme-coin bot: $100 paper, momentum (buy the pump) — high-risk casino test
    rows = load("meme_bot.jsonl")
    mcl = [r for r in rows if r["type"] == "mclose"]
    if mcl:
        ml = [{"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", 0)} for r in mcl]
        ml.sort(key=lambda t: t["ts"])
        w = sum(1 for t in ml if t["won"]); acct = 100.0 + sum(t["pnl"] for t in ml)
        today_m, daily_m = day_split(ml)
        out["meme-coin ($100 acct)"] = {
            "trades": len(ml), "wins": w, "win_rate": round(w / len(ml), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_m, "daily": daily_m,
            "config": "meme momentum (buy pump, exit reversal), $20/bet — HIGH-RISK casino test, paper only"}
    # ccxt-strategy bot: $100 paper, OctoBot-style evaluator blend on daily BTC/ETH/SOL
    rows = load("ccxt_bot.jsonl")
    scl = [r for r in rows if r["type"] == "sclose"]
    if scl:
        sl = [{"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", 0)} for r in scl]
        sl.sort(key=lambda t: t["ts"])
        w = sum(1 for t in sl if t["won"]); acct = 100.0 + sum(t["pnl"] for t in sl)
        today_c, daily_c = day_split(sl)
        out["ccxt-strategy ($100 acct)"] = {
            "trades": len(sl), "wins": w, "win_rate": round(w / len(sl), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_c, "daily": daily_c,
            "config": "OctoBot-style evaluator blend, daily BTC/ETH/SOL via CCXT, $30/pos — forward test"}
    # flow bot: $100 paper, live order-flow tape trader (intraday, forward-test only)
    rows = load("flow_bot.jsonl")
    fcl = [r for r in rows if r["type"] == "fclose"]
    if fcl:
        fl = [{"won": r["won"], "pnl": r["pnl"], "ts": r.get("ts", 0)} for r in fcl]
        fl.sort(key=lambda t: t["ts"])
        w = sum(1 for t in fl if t["won"]); acct = 100.0 + sum(t["pnl"] for t in fl)
        today_f, daily_f = day_split(fl)
        out["flow-bot ($100 acct)"] = {
            "trades": len(fl), "wins": w, "win_rate": round(w / len(fl), 3),
            "pnl": round(acct - 100, 2), "account": round(acct, 2),
            "today": today_f, "daily": daily_f,
            "config": "live order-flow (CVD+big trades+DOM), intraday BTC/ETH/SOL, $30/pos — forward test, NOT backtestable"}
    return out


def main() -> None:
    trades = [t for fn in PERCEIVERS for t in fn()]
    lessons = attribute(trades)
    days = daily_rollup(trades)
    actions = actuate(lessons)
    allocation = thompson_allocation(trades)
    memory = consolidate_memory(lessons)
    (DATA / "engine_status.json").write_text(json.dumps(
        {"ts": int(time.time()), "engines": engines_status()}, indent=2))
    DATA.mkdir(exist_ok=True)
    (DATA / "brain_allocation.json").write_text(json.dumps(
        {"ts": int(time.time()), "half_life_days": HALF_LIFE_DAYS,
         "advisory": True, "allocation": allocation}, indent=2))

    DATA.mkdir(exist_ok=True)
    (DATA / "brain_lessons.json").write_text(json.dumps(
        {"ts": int(time.time()), "lessons": lessons, "actions": actions}, indent=2))
    (DATA / "journal_days.json").write_text(json.dumps(
        {"ts": int(time.time()), "days": days}, indent=2))
    # compact per-trade record for the journal dashboard (histogram, streaks,
    # expectancy, calendar) — chronological
    trades.sort(key=lambda t: t["ts"])
    (DATA / "journal_trades.json").write_text(json.dumps(
        {"ts": int(time.time()),
         "trades": [{"s": t["strategy"], "ts": t["ts"],
                     "pnl": round(t["pnl"], 2), "won": t["won"]}
                    for t in trades]}))

    # daily note into the intel journal (one per calendar day)
    today = day_of(int(time.time()))
    jpath = LOGS / "journal.jsonl"
    already = False
    if jpath.exists():
        for line in jpath.open():
            try:
                r = json.loads(line)
                if r.get("kind") == "brain-daily" and r.get("day") == today:
                    already = True
            except Exception:
                pass
    if not already and today in days:
        top = [l["note"] for l in lessons if l["stable"]][:3]
        note = {"ts": int(time.time()), "kind": "brain-daily", "day": today,
                "summary": {s: rec for s, rec in days[today].items()},
                "lessons": top, "actions": actions}
        with jpath.open("a") as f:
            f.write(json.dumps(note) + "\n")

    lt = [p for p in memory["principles"].values() if p.get("long_term")]
    print(f"[brain] {len(trades)} trades → {len(lessons)} lessons "
          f"({sum(1 for l in lessons if l['stable'])} stable) · {len(actions)} actions "
          f"· {len(lt)} long-term principles")
    for l in lessons[:6]:
        print(f"  {l['kind']:<8}{l['note']}")
    for a in actions:
        print(f"  ACTION  {a}")


if __name__ == "__main__":
    main()
