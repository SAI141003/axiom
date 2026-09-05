"""
Self-learning loop — refits strategy parameters from the dry-run logs.

Design principles (kept deliberately conservative — this is a quant learner,
not a curve-fitter):
  1. MINIMUM SAMPLE: no decision changes on fewer than the stated n.
  2. PARAMETER STABILITY (Unger): a config must be profitable in BOTH
     chronological halves of the sample, not just overall — kills lucky fits.
  3. BOUNDED MOVES: multipliers clamp to sane ranges; defaults win ties.
  4. EVIDENCE TRAIL: every learned value ships with the numbers behind it.

Outputs (read by daemons + frontend at runtime, fallback = defaults):
  .data/params_crypto.json     — per-asset: enabled / threshold / sign
  .data/params_weather.json    — disabled cities / min flag edge
  .data/params_premarket.json  — target & stop multipliers / gap mode

Runs nightly from dryrun/daily_report.sh; run manually anytime:
  .venv/bin/python dryrun/learner.py
"""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
OUT = ROOT / ".data"

STAKE = 10.0
MAX_SIDE_PX = 0.62


def clob_fee(p: float) -> float:
    return 0.018 * 4.0 * p * (1.0 - p)


def load_jsonl(name: str) -> list[dict]:
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


def write_params(name: str, params: dict, evidence: dict) -> None:
    OUT.mkdir(exist_ok=True)
    (OUT / name).write_text(json.dumps({
        "params": params,
        "evidence": evidence,
        "learned_at": int(time.time()),
    }, indent=2))


# ── Crypto: per-asset enabled / threshold / momentum sign ─────────────────────

def _sim(windows: list[dict], sign: int, th: float) -> tuple[int, float]:
    """Simulate config on logged windows → (n_trades, pnl). Uses real prices."""
    n, pnl = 0, 0.0
    for w in windows:
        s = sign * w["score"]
        side = "UP" if s > th else "DOWN" if s < -th else None
        if side is None:
            continue
        entry = w["up_price"] if side == "UP" else w["down_price"]
        if not (0.01 < entry < MAX_SIDE_PX):
            continue
        won = (side == "UP") == w["up_won"]
        n += 1
        pnl += (STAKE * (1 / entry - 1) if won else -STAKE) - STAKE * clob_fee(entry)
    return n, pnl


def learn_crypto() -> None:
    rows = load_jsonl("dryrun_5m.jsonl")
    entries = {r["id"]: r for r in rows if r["type"] == "entry"}
    joined = []
    for r in rows:
        if r["type"] == "resolve" and r["id"] in entries:
            joined.append({**entries[r["id"]], "up_won": r["up_won"]})
    joined.sort(key=lambda r: r["ts"])

    params: dict = {}
    evidence: dict = {}
    for asset in ("btc", "eth", "sol", "xrp"):
        wins = [r for r in joined if r["asset"] == asset][-800:]   # rolling window
        if len(wins) < 160:   # min sample: ~13h of windows
            params[asset] = {"enabled": True, "threshold": 0.25, "sign": 1}
            evidence[asset] = {"note": f"insufficient sample ({len(wins)}) — defaults kept"}
            continue
        half = len(wins) // 2
        h1, h2 = wins[:half], wins[half:]
        best = None
        for sign in (1, -1):
            for th in (0.25, 0.35, 0.45, 0.55):
                n1, p1 = _sim(h1, sign, th)
                n2, p2 = _sim(h2, sign, th)
                n, p = n1 + n2, p1 + p2
                stable = p1 > 0 and p2 > 0 and n >= 80
                if stable and (best is None or p > best["pnl"]):
                    best = {"sign": sign, "threshold": th, "pnl": round(p, 2),
                            "n": n, "half_pnls": [round(p1, 2), round(p2, 2)]}
        if best:
            params[asset] = {"enabled": True, "threshold": best["threshold"], "sign": best["sign"]}
            evidence[asset] = best
        else:
            params[asset] = {"enabled": False, "threshold": 0.25, "sign": 1}
            evidence[asset] = {"note": f"no config stable-profitable in both halves (n={len(wins)}) — disabled"}

    write_params("params_crypto.json", params, evidence)
    print("crypto:", json.dumps(params))


# ── Weather: per-city reliability + flag edge ─────────────────────────────────

def learn_weather() -> None:
    rows = load_jsonl("dryrun_weather.jsonl")
    resolves = {r["slug"]: r for r in rows if r["type"] == "resolve"}
    # last midday snapshot per resolved event, chronological by event
    snaps: dict[str, dict] = {}
    for sn in rows:
        if sn["type"] != "snapshot" or sn["slug"] not in resolves:
            continue
        if not (8 <= sn.get("hours_elapsed", 0) <= 15):
            continue
        cur = snaps.get(sn["slug"])
        if cur is None or sn["ts"] > cur["ts"]:
            snaps[sn["slug"]] = sn

    def plays_for(sn: dict, min_edge: float) -> list[float]:
        res = resolves[sn["slug"]]
        out = []
        for b in sn["buckets"]:
            actual = b["low"] == res["winning_low"] and b["high"] == res["winning_high"]
            e = b["model"] - b["market"]
            if abs(e) > min_edge and 0.02 < b["market"] < 0.98:
                if e > 0:
                    out.append(STAKE * (1 / b["market"] - 1) if actual else -STAKE)
                else:
                    out.append(STAKE * (1 / (1 - b["market"]) - 1) if not actual else -STAKE)
        return out

    ordered = sorted(snaps.values(), key=lambda s: s["ts"])

    # global min-edge: stable across halves
    best_edge, best_pnl = 0.08, None
    half = len(ordered) // 2
    for me in (0.06, 0.08, 0.10, 0.12):
        p1 = sum(p for sn in ordered[:half] for p in plays_for(sn, me))
        p2 = sum(p for sn in ordered[half:] for p in plays_for(sn, me))
        if p1 > 0 and p2 > 0 and (best_pnl is None or p1 + p2 > best_pnl):
            best_edge, best_pnl = me, p1 + p2

    # realized per-city P&L from ACTUAL placed trades — counterfactual midday
    # plays alone disabled net-positive cities (houston +$20) while leaving
    # 0-win bleeders (guangzhou −$30) enabled. Reality gets a veto both ways.
    real_city: dict[str, list[float]] = {}
    for t in rows:
        if t["type"] != "wtrade" or t["slug"] not in resolves:
            continue
        r = resolves[t["slug"]]
        won_b = t["low"] == r["winning_low"] and t["high"] == r["winning_high"]
        win = won_b if t["side"] == "YES" else not won_b
        pnl = t["stake"] * (1 / t["entry"] - 1) if win else -t["stake"]
        real_city.setdefault(t.get("city", "?"), []).append(pnl)

    # per-city: disable if stable-negative with n≥8 plays
    disabled: list[str] = []
    city_ev: dict = {}
    cities = {sn["city"] for sn in ordered} | set(real_city)
    for city in cities:
        c_sn = [sn for sn in ordered if sn["city"] == city]
        ch = len(c_sn) // 2
        pl1 = [p for sn in c_sn[:ch] for p in plays_for(sn, best_edge)]
        pl2 = [p for sn in c_sn[ch:] for p in plays_for(sn, best_edge)]
        n = len(pl1) + len(pl2)
        pnl = sum(pl1) + sum(pl2)
        rp = real_city.get(city, [])
        r_pnl, r_wins = sum(rp), sum(1 for p in rp if p > 0)
        city_ev[city] = {"n": n, "pnl": round(pnl, 2),
                         "real_n": len(rp), "real_pnl": round(r_pnl, 2)}
        counterfactual_bad = n >= 8 and sum(pl1) < 0 and sum(pl2) < 0
        realized_bad = len(rp) >= 3 and r_wins == 0          # 0-for-3+ in reality
        realized_good = len(rp) >= 3 and r_pnl > 0           # reality vetoes disable
        if (counterfactual_bad and not realized_good) or realized_bad:
            disabled.append(city)

    write_params("params_weather.json",
                 {"disabled_cities": sorted(disabled), "min_flag_edge": best_edge},
                 {"events_scored": len(ordered), "per_city": city_ev,
                  "min_edge_pnl": round(best_pnl, 2) if best_pnl else None})
    print(f"weather: min_edge={best_edge} disabled={sorted(disabled)}")


# ── Premarket: bounded plan-shape tuning ──────────────────────────────────────

def learn_premarket() -> None:
    rows = load_jsonl("dryrun_premarket.jsonl")
    outs = [r for r in rows if r["type"] == "outcome"]
    # R-asymmetry is ENFORCED, not learned: the old rule (widen stops when
    # they hit, pull targets closer when they miss) converged to
    # target 0.8× / stop 1.0× — ride losers, cut winners, the classic losing
    # shape. Winning intraday playbooks risk 1R to make ≥2R. Tuning may only
    # move WITHIN that shape once n≥40.
    params = {"target_mult": 1.6, "stop_mult": 0.8}
    ev: dict = {"n": len(outs), "asymmetry": "2R enforced"}
    if len(outs) >= 10:
        stop_rate = sum(1 for o in outs if o["hit"] == "stop") / len(outs)
        tgt_rate = sum(1 for o in outs if o["hit"] == "target") / len(outs)
        ev.update({"stop_rate": round(stop_rate, 2), "target_rate": round(tgt_rate, 2),
                   "pnl": round(sum(o["pnl"] for o in outs), 2)})
    else:
        ev["note"] = "need ≥10 outcomes before tuning"
    write_params("params_premarket.json", params, ev)
    print("premarket:", json.dumps(params), json.dumps(ev))


if __name__ == "__main__":
    learn_crypto()
    learn_weather()
    learn_premarket()
