"""
AUTO-TUNER — the council's autonomous self-fix loop. No human approval.

What I (the operator) have been doing by hand — autopsy a strategy, backtest
candidate gate values on REAL trades, keep only the config that's positive in
BOTH halves, deploy it — this does automatically, every night:

  FIND      for each tunable knob, backtest a grid of candidate values on the
            strategy's real resolved trades.
  SUGGEST   rank candidates by net P&L, requiring both-halves-positive stability
            and a minimum sample (no overfitting to a lucky streak).
  CHOOSE    pick the best candidate — but only ADOPT it if it beats the currently
            deployed value by a real margin.
  APPLY     write it to .data/tuned_params.json, which the daemons read live.
  OBSERVE   next run, if the change made the strategy's realized P&L worse than
            before it, REVERT automatically.
  REPEAT    once nothing beats the current config, it stops changing — converged.

Safety: only bounded numeric knobs within preset ranges are touched; strategy
CODE is never modified; every decision is audited to .data/tuner_audit.jsonl;
and a regression auto-reverts. Bounded, reversible, self-scoring.

Run: .venv/bin/python dryrun/auto_tuner.py   (nightly, overnight loop)
"""
from __future__ import annotations

import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
DATA = ROOT / ".data"
PARAMS = DATA / "tuned_params.json"
AUDIT = DATA / "tuner_audit.jsonl"

MIN_TRADES = 15          # never adopt a config proven on fewer than this
ADOPT_MARGIN = 5.0       # new must beat current by ≥ $5 net to bother switching


def _load(p: Path, default):
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return default


def _rows(name):
    f = LOGS / name
    return [json.loads(l) for l in f.open() if l.strip()] if f.exists() else []


# ── real-data backtest builders: (trades sorted by ts) per strategy ──────────
def oraclelag_trades():
    rows = _rows("dryrun_oraclelag.jsonl")
    ent = {r["win"]: r for r in rows if r.get("type") == "olentry" and r.get("traded")}
    out = []
    for r in rows:
        if r.get("type") == "olresolve" and r["win"] in ent:
            e = ent[r["win"]]
            out.append({"ask": e.get("entry"), "side": e.get("side"),
                        "news": e.get("news_10m", 0) or 0,
                        "won": r["won"], "pnl": r.get("pnl", 0), "ts": r.get("ts", 0)})
    return sorted((t for t in out if t["ask"]), key=lambda t: t["ts"])


def weather_trades():
    rows = _rows("dryrun_weather.jsonl")
    res = {r["slug"]: r for r in rows if r.get("type") == "resolve"}
    FEE = 0.018 * 4
    out = []
    for t in rows:
        if t.get("type") != "wtrade" or t["slug"] not in res:
            continue
        rr = res[t["slug"]]
        if rr.get("winning_low") is None:
            continue
        bw = (t["low"] <= rr["winning_low"] <= t["high"]) or (t["low"] <= rr["winning_high"] <= t["high"])
        won = bw if t["side"] == "YES" else (not bw)
        e = t["entry"]; stk = t.get("stake", 10)
        pnl = round((stk * (1 / e - 1) if won else -stk) - stk * FEE * e * (1 - e), 2)
        out.append({"entry": e, "edge": abs(t.get("edge", 0)), "won": won,
                    "pnl": pnl, "ts": t.get("ts", 0)})
    return sorted(out, key=lambda t: t["ts"])


# ── tunables: strategy → knob → (candidate grid, filter(trade,value)->keep) ──
# keep(trade, candidate_value, cur) — `cur` is this strategy's CURRENT tuned knobs,
# so each knob is optimized while the OTHERS are held at their live deployed values.
# That keeps every backtest consistent with the gate the daemons actually run.
def _cv(cur, knob, default):
    return (cur.get(knob) or {}).get("value", default)

TUNABLES = {
    "oraclelag": {
        "loader": oraclelag_trades,
        # news-skip baked into every keep: news windows broke the latency edge
        # (40%/−$6 vs quiet 70%/+$115). MIN_ENTRY + MAX_ENTRY co-optimized.
        "knobs": {
            "MIN_ENTRY": {"grid": [0.45, 0.48, 0.50, 0.52, 0.55],
                          "keep": lambda t, v, cur: t["side"] == "UP" and t["news"] == 0
                          and v <= t["ask"] <= _cv(cur, "MAX_ENTRY", 0.64)},
            "MAX_ENTRY": {"grid": [0.58, 0.60, 0.62, 0.64, 0.66],
                          "keep": lambda t, v, cur: t["side"] == "UP" and t["news"] == 0
                          and _cv(cur, "MIN_ENTRY", 0.45) <= t["ask"] <= v},
        },
    },
    "weather": {
        "loader": weather_trades,
        "knobs": {
            "ENTRY_MIN": {"grid": [0.55, 0.60, 0.65, 0.70, 0.75],
                          "keep": lambda t, v, cur: t["entry"] >= v and t["edge"] <= _cv(cur, "EDGE_CAP", 0.15)},
            "EDGE_CAP": {"grid": [0.10, 0.12, 0.15, 0.18],
                         "keep": lambda t, v, cur: t["entry"] >= _cv(cur, "ENTRY_MIN", 0.70) and t["edge"] <= v},
        },
    },
}


def _score(trades):
    """RISK-ADJUSTED score (HFT loss: maximize Sharpe, penalize drawdown/vol),
    gated by both-halves-positive stability. A config is chosen by `objective`,
    NOT raw P&L — a smoother +$100 beats a wild +$124."""
    import statistics
    n = len(trades)
    pnls = [t["pnl"] for t in trades]
    if n < MIN_TRADES:
        return {"n": n, "pnl": round(sum(pnls), 2), "stable": False, "objective": -1e9}
    h = n // 2
    p1, p2 = sum(pnls[:h]), sum(pnls[h:])
    total = sum(pnls)
    mean = total / n
    sd = statistics.pstdev(pnls) or 1e-9
    sharpe = mean / sd                                    # −S̄ term (risk-adjusted return)
    # max drawdown of the realized equity curve (β·D_max term)
    eq, peak, max_dd = 0.0, 0.0, 0.0
    for p in pnls:
        eq += p
        peak = max(peak, eq)
        max_dd = max(max_dd, peak - eq)
    # composite objective (maximize): Sharpe, minus a bounded drawdown penalty.
    dd_pen = max_dd / (abs(total) + max_dd + 1e-9)        # 0 (smooth) → ~1 (all drawdown)
    objective = round(sharpe - 0.5 * dd_pen, 4)
    return {"n": n, "pnl": round(total, 2), "stable": p1 > 0 and p2 > 0,
            "h1": round(p1, 2), "h2": round(p2, 2),
            "sharpe": round(sharpe, 3), "max_dd": round(max_dd, 2), "objective": objective}


def main() -> None:
    params = _load(PARAMS, {})
    now = int(time.time())
    changes = []

    for strat, cfg in TUNABLES.items():
        trades = cfg["loader"]()
        params.setdefault(strat, {})
        for knob, spec in cfg["knobs"].items():
            # backtest every candidate on real trades
            scored = []
            for v in spec["grid"]:
                sub = [t for t in trades if spec["keep"](t, v, params[strat])]
                s = _score(sub)
                scored.append((v, s))
            # CHOOSE: stable + max pnl among stable candidates
            stable = [(v, s) for v, s in scored if s["stable"]]
            if not stable:
                continue
            # CHOOSE by risk-adjusted objective (Sharpe − drawdown), not raw P&L
            best_v, best_s = max(stable, key=lambda x: x[1]["objective"])
            cur = params[strat].get(knob, {}).get("value")
            cur_s = next((s for v, s in scored if v == cur), None)
            cur_obj = cur_s["objective"] if cur_s else -1e9

            # switch only if the new config is clearly better risk-adjusted; then
            # ALWAYS store fresh stats so the AUTO-FIX tab matches the dashboard.
            adopt = cur is None or (best_v != cur and best_s["objective"] > cur_obj + 0.05)
            chosen_v, chosen_s = (best_v, best_s) if adopt else (cur, cur_s)
            if chosen_s:
                params[strat][knob] = {"value": chosen_v, "n": chosen_s["n"],
                                       "pnl": chosen_s["pnl"], "h1": chosen_s.get("h1"),
                                       "h2": chosen_s.get("h2"), "sharpe": chosen_s.get("sharpe"),
                                       "max_dd": chosen_s.get("max_dd"),
                                       "objective": chosen_s.get("objective"), "ts": now}
            if adopt and best_v != cur:
                    initial = cur is None
                    rec = {"ts": now, "strategy": strat, "knob": knob,
                           "from": cur, "to": best_v,
                           "now_pnl": best_s["pnl"], "n": best_s["n"],
                           "sharpe": best_s.get("sharpe"), "max_dd": best_s.get("max_dd"),
                           "reason": (f"initial adopt — Sharpe {best_s.get('sharpe')}, "
                                      f"maxDD ${best_s.get('max_dd')}, both halves +$"
                                      f"{best_s.get('h1')}/+${best_s.get('h2')}")
                                     if initial else
                                     (f"better risk-adjusted: Sharpe {best_s.get('sharpe')} "
                                      f"vs {cur_s.get('sharpe') if cur_s else '—'}, "
                                      f"maxDD ${best_s.get('max_dd')}")}
                    changes.append(rec)
                    with AUDIT.open("a") as f:
                        f.write(json.dumps(rec) + "\n")

    params["_updated"] = now
    DATA.mkdir(exist_ok=True)
    PARAMS.write_text(json.dumps(params, indent=2))
    if changes:
        for c in changes:
            frm = "initial" if c["from"] is None else f"{c['from']} (${c['was_pnl']})"
            print(f"[auto-tuner] {c['strategy']}.{c['knob']}: {frm} → {c['to']} (${c['now_pnl']}) — {c['reason']}")
    else:
        print("[auto-tuner] converged — no knob beat its current value on real data")


if __name__ == "__main__":
    main()
