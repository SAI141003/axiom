"""
Monte Carlo backtester — resamples each strategy's REAL logged trade outcomes
10,000+ times to measure robustness, not to invent edge.

For each strategy with resolved trades (pnl per trade):
  1. BOOTSTRAP 10,000 resampled trade sets → distribution of total P&L
     → p5/p50/p95, P(profit>0), mean, std
  2. SEQUENCE MC (shuffle order 10,000×) → max-drawdown distribution + risk of
     ruin (path breaches −ruin_fraction × starting bankroll)
  3. Verdict: ROBUST only if P(profit)≥0.60 AND median>0 AND p5 not catastrophic.

Crypto also gets "MC on every parameter set" (bennnytrades method): each
(sign, threshold) config reconstructed from logged signals+outcomes, MC'd, and
the best STABLE config surfaced.

Writes a dated report to logs/reports/montecarlo_<ts>.txt and updledates
.data/mc_verdict.json (consumed by the learner / bot switches).

Usage: .venv/bin/python dryrun/montecarlo_backtest.py [n_iter=10000]
"""
from __future__ import annotations

import json
import sys
import time
import random
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
LOGS = ROOT / "logs"
N_ITER = int(sys.argv[1]) if len(sys.argv) > 1 else 10_000
RUIN_FRACTION = 0.5          # ruin = drawdown past 50% of starting stake bankroll
START_BANKROLL = 1000.0
CLOB_FEE = lambda p: 0.018 * 4 * p * (1 - p)


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


def mc_bootstrap(pnls: list[float], n: int) -> dict:
    """Resample-with-replacement the trade set n times → total P&L distribution."""
    if not pnls:
        return {}
    k = len(pnls)
    totals = []
    for _ in range(n):
        totals.append(sum(random.choice(pnls) for _ in range(k)))
    totals.sort()
    q = lambda f: totals[min(n - 1, int(f * n))]
    wins = sum(1 for t in totals if t > 0)
    # per-trade Sharpe + profit factor on the REAL trade set (their metrics)
    mu = sum(pnls) / k
    sd = (sum((p - mu) ** 2 for p in pnls) / k) ** 0.5 if k > 1 else 0.0
    sharpe = round(mu / sd, 3) if sd > 0 else None            # per-trade Sharpe
    gw = sum(p for p in pnls if p > 0); gl = -sum(p for p in pnls if p < 0)
    pf = round(gw / gl, 2) if gl > 0 else None
    return {
        "trades": k,
        "p5": round(q(0.05), 2), "p50": round(q(0.50), 2), "p95": round(q(0.95), 2),
        "mean": round(sum(totals) / n, 2),
        "p_profit": round(wins / n, 4),
        "sharpe": sharpe, "profit_factor": pf,
    }


def mc_drawdown(pnls: list[float], n: int) -> dict:
    """Shuffle trade ORDER n times → max-drawdown + ruin probability."""
    if not pnls:
        return {}
    max_dds, ruins = [], 0
    for _ in range(n):
        order = pnls[:]
        random.shuffle(order)
        eq = START_BANKROLL
        peak = eq
        mdd = 0.0
        ruined = False
        for p in order:
            eq += p
            peak = max(peak, eq)
            mdd = max(mdd, peak - eq)
            if eq <= START_BANKROLL * (1 - RUIN_FRACTION):
                ruined = True
        max_dds.append(mdd)
        ruins += int(ruined)
    max_dds.sort()
    return {
        "median_max_dd": round(max_dds[n // 2], 2),
        "worst_max_dd": round(max_dds[-1], 2),
        "risk_of_ruin": round(ruins / n, 4),
    }


def verdict(boot: dict, dd: dict) -> str:
    if not boot:
        return "NO DATA"
    robust = (boot["p_profit"] >= 0.60 and boot["p50"] > 0
              and dd.get("risk_of_ruin", 1) < 0.05)
    marginal = boot["p_profit"] >= 0.50 and boot["p50"] > 0
    return "ROBUST ✓" if robust else ("MARGINAL" if marginal else "NOT ROBUST ✗")


# ── strategy P&L extractors (real resolved trades only) ───────────────────────

def crypto_pnls() -> list[float]:
    rows = load("dryrun_5m.jsonl")
    ent = {r["id"]: r for r in rows if r["type"] == "entry"}
    return [r["pnl"] for r in rows
            if r["type"] == "resolve" and r.get("pnl") is not None
            and ent.get(r["id"], {}).get("traded")]


def weather_pnls() -> list[float]:
    rows = load("dryrun_weather.jsonl")
    res = {r["slug"]: r for r in rows if r["type"] == "resolve"}
    out = []
    for t in rows:
        if t["type"] != "wtrade" or t["slug"] not in res:
            continue
        r = res[t["slug"]]
        won_bucket = t["low"] == r["winning_low"] and t["high"] == r["winning_high"]
        win = won_bucket if t["side"] == "YES" else not won_bucket
        out.append(t["stake"] * (1 / t["entry"] - 1) if win else -t["stake"])
    return out


def premarket_pnls() -> list[float]:
    return [r["pnl"] for r in load("dryrun_premarket.jsonl") if r["type"] == "outcome"]


def kronos1h_pnls() -> list[float]:
    rows = load("dryrun_kronos1h.jsonl")
    armed = {r["id"] for r in rows if r["type"] == "kentry" and r.get("traded")}
    return [r["pnl"] for r in rows
            if r["type"] == "kresolve" and r.get("pnl") is not None
            and r["id"] in armed]


def oraclelag_pnls() -> list[float]:
    rows = load("dryrun_oraclelag.jsonl")
    armed = {r["win"] for r in rows if r["type"] == "olentry" and r.get("traded")}
    return [r["pnl"] for r in rows
            if r["type"] == "olresolve" and r.get("pnl") is not None
            and r["win"] in armed]


def vwap_pnls() -> list[float]:
    return [r["pnl"] for r in load("dryrun_vwap.jsonl")
            if r["type"] == "vclose" and isinstance(r.get("pnl"), (int, float))
            and r.get("reason") != "stale-restart"]


def newslag_pnls() -> list[float]:
    rows = load("dryrun_newslag.jsonl")
    armed = {r["slug"] for r in rows if r["type"] == "ntrade" and r.get("traded")}
    return [r["pnl"] for r in rows if r["type"] == "nresolve"
            and isinstance(r.get("pnl"), (int, float)) and r["slug"] in armed]


def options_pnls() -> list[float]:
    rows = load("dryrun_options.jsonl")
    pos = {r["id"]: r for r in rows if r["type"] == "position"}
    latest = {}
    for m in rows:
        if m["type"] == "mark":
            cur = latest.get(m["id"])
            if cur is None or m["ts"] > cur["ts"]:
                latest[m["id"]] = m
    return [m["unrealized"] for m in latest.values()]


# ── crypto: MC on every parameter set ─────────────────────────────────────────

def _config_pnls(joined: list[dict], sign: int, th: float) -> list[float]:
    pnls = []
    for w in joined:
        s = sign * w["score"]
        side = "UP" if s > th else "DOWN" if s < -th else None
        if not side:
            continue
        entry = w["up_price"] if side == "UP" else w["down_price"]
        if not (0.01 < entry < 0.62):
            continue
        won = (side == "UP") == w["up_won"]
        pnls.append((10 * (1 / entry - 1) if won else -10) - 10 * CLOB_FEE(entry))
    return pnls


CONFIGS = [(sign, th) for sign in (1, -1) for th in (0.25, 0.35, 0.45, 0.55, 0.70)]


def crypto_param_mc(n: int) -> list[dict]:
    rows = load("dryrun_5m.jsonl")
    ent = {r["id"]: r for r in rows if r["type"] == "entry"}
    joined = [{**ent[r["id"]], "up_won": r["up_won"]}
              for r in rows if r["type"] == "resolve" and r["id"] in ent]
    results = []
    for sign, th in CONFIGS:
        pnls = _config_pnls(joined, sign, th)
        if len(pnls) >= 40:
            b = mc_bootstrap(pnls, min(n, 5000))
            results.append({"sign": sign, "th": th, **b})
    results.sort(key=lambda r: -r["p50"])
    return results


def crypto_selection_pvalue(n_perm: int = 200) -> dict:
    """Deflated-Sharpe-style trial correction (Bailey & López de Prado):
    the best of 10 tested configs LOOKS good by selection bias alone. This
    permutation null shuffles outcomes (up_won) and asks how often the
    best-of-10 on pure noise beats the observed best-of-10 total P&L."""
    rows = load("dryrun_5m.jsonl")
    ent = {r["id"]: r for r in rows if r["type"] == "entry"}
    joined = [{**ent[r["id"]], "up_won": r["up_won"]}
              for r in rows if r["type"] == "resolve" and r["id"] in ent]
    if len(joined) < 200:
        return {}
    best_obs = max((sum(_config_pnls(joined, s, t)) for s, t in CONFIGS), default=0)
    outcomes = [w["up_won"] for w in joined]
    beat = 0
    for _ in range(n_perm):
        random.shuffle(outcomes)
        perm = [{**w, "up_won": o} for w, o in zip(joined, outcomes)]
        if max((sum(_config_pnls(perm, s, t)) for s, t in CONFIGS), default=0) >= best_obs:
            beat += 1
    return {"trials": len(CONFIGS), "best_total": round(best_obs, 2),
            "p_value": round(beat / n_perm, 3), "n_perm": n_perm}


def calibration() -> dict:
    """BRIER SCORE per strategy (Doc 2: 'track calibration religiously').
    For each binary strategy we have (implied_prob, outcome) pairs: the entry
    price IS an implied probability, and we know if it won. Brier =
    mean((prob − outcome)^2); < 0.25 = better than a coin-flip guess. High
    Brier = the prices we pay don't predict outcomes (a real leak)."""
    out = {}

    def brier(pairs):
        if len(pairs) < 15:
            return None
        bs = sum((p - o) ** 2 for p, o in pairs) / len(pairs)
        return {"brier": round(bs, 4), "n": len(pairs),
                "verdict": "calibrated" if bs < 0.24 else "poorly calibrated"}

    # crypto: entry price of the traded side vs whether that side won
    rows = load("dryrun_5m.jsonl"); ent = {r["id"]: r for r in rows if r["type"] == "entry"}
    pairs = []
    for r in rows:
        e = ent.get(r.get("id"))
        if r["type"] == "resolve" and e and e.get("traded") and "up_won" in r:
            side_up = e["side"] == "UP"
            prob = e["up_price"] if side_up else e["down_price"]
            won = int(side_up == r["up_won"])
            if isinstance(prob, (int, float)) and 0 < prob < 1:
                pairs.append((prob, won))
    if (b := brier(pairs)): out["crypto-5m"] = b

    # oracle-lag: entry ask (implied prob of the side) vs won
    rows = load("dryrun_oraclelag.jsonl"); ent = {r["win"]: r for r in rows if r["type"] == "olentry"}
    pairs = [(ent[r["win"]]["entry"], int(r["won"])) for r in rows
             if r["type"] == "olresolve" and r.get("win") in ent
             and ent[r["win"]].get("traded") and isinstance(ent[r["win"]].get("entry"), (int, float))]
    if (b := brier(pairs)): out["btc-oraclelag"] = b

    # kronos: the MODEL's threshold prob would be ideal; use entry (armed) vs won
    rows = load("dryrun_kronos1h.jsonl"); ent = {r["id"]: r for r in rows if r["type"] == "kentry"}
    pairs = [(ent[r["id"]]["entry"], int(r["won"])) for r in rows
             if r["type"] == "kresolve" and r.get("id") in ent
             and ent[r["id"]].get("traded") and isinstance(ent[r["id"]].get("entry"), (int, float))]
    if (b := brier(pairs)): out["kronos1h"] = b
    return out


def main() -> None:
    random.seed()  # fresh each overnight run
    ts = datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"{'='*66}", f"MONTE CARLO BACKTEST · {ts} · {N_ITER:,} iterations", f"{'='*66}"]

    strategies = {
        "crypto-5m": crypto_pnls, "weather": weather_pnls,
        "premarket": premarket_pnls, "kronos1h": kronos1h_pnls,
        "options": options_pnls, "btc-oraclelag": oraclelag_pnls,
        "vwap-trend": vwap_pnls, "news-lag": newslag_pnls,
    }
    verdicts = {}
    for name, fn in strategies.items():
        pnls = fn()
        boot = mc_bootstrap(pnls, N_ITER)
        dd = mc_drawdown(pnls, N_ITER) if pnls else {}
        v = verdict(boot, dd)
        verdicts[name] = {"verdict": v, **boot, **dd}
        if not pnls:
            lines.append(f"\n{name:<11} NO RESOLVED TRADES YET")
            continue
        lines.append(
            f"\n{name:<11} {v}  ({boot['trades']} trades)"
            f"\n  total P&L: p5 ${boot['p5']} · median ${boot['p50']} · p95 ${boot['p95']} "
            f"· mean ${boot['mean']}"
            f"\n  P(profit>0) {boot['p_profit']:.0%} · Sharpe {boot.get('sharpe','?')} "
            f"· profit factor {boot.get('profit_factor','?')} · median maxDD "
            f"${dd.get('median_max_dd','?')} · risk of ruin {dd.get('risk_of_ruin', 0):.1%}")

    # crypto parameter MC
    lines.append(f"\n{'-'*66}\nCRYPTO · MONTE CARLO ON EVERY PARAMETER SET (best 5 by median):")
    for r in crypto_param_mc(N_ITER)[:5]:
        tag = "FADE" if r["sign"] == -1 else "FOLLOW"
        lines.append(f"  {tag} @{r['th']}: {r['trades']}tr · median ${r['p50']} "
                     f"· p5 ${r['p5']} · P(profit) {r['p_profit']:.0%}")
    # alpha vs naive baseline (Dalio A6): a strategy only has alpha if it
    # beats the dumbest version of itself on the same windows.
    rows_5m = load("dryrun_5m.jsonl")
    ent5 = {r["id"]: r for r in rows_5m if r["type"] == "entry"}
    base_pnl, base_n = 0.0, 0
    for r in rows_5m:
        e = ent5.get(r.get("id"))
        if r["type"] != "resolve" or not e or not isinstance(r.get("up_won"), bool):
            continue
        up, dn = e.get("up_price"), e.get("down_price")
        if not (isinstance(up, (int, float)) and isinstance(dn, (int, float))):
            continue
        side, px = ("UP", up) if up <= dn else ("DOWN", dn)   # buy cheaper side
        if not 0.01 < px < 0.98:
            continue
        won = (side == "UP") == r["up_won"]
        base_pnl += 10 * (1 / px - 1) if won else -10
        base_n += 1
    if base_n:
        lines.append(f"  BASELINE (always buy cheaper side): {base_n}tr · total "
                     f"${base_pnl:.2f} · EV/trade ${base_pnl / base_n:.2f} — any crypto "
                     f"config must beat THIS, not zero")

    sel = crypto_selection_pvalue()
    if sel:
        verdict_txt = ("selection bias NOT ruled out — best config is likely luck"
                       if sel["p_value"] > 0.05 else
                       "best config beats the noise null (p ≤ 0.05)")
        lines.append(f"  SELECTION-BIAS CHECK (permutation null, {sel['trials']} trials, "
                     f"{sel['n_perm']} perms): best total ${sel['best_total']} · "
                     f"p={sel['p_value']} → {verdict_txt}")

    # calibration (Brier) block
    cal = calibration()
    if cal:
        lines.append(f"\n{'-'*66}\nCALIBRATION (Brier score, <0.24 = prices predict outcomes):")
        for s, c in cal.items():
            lines.append(f"  {s:<14} Brier {c['brier']} ({c['n']} trades) → {c['verdict']}")
        verdicts.setdefault("_calibration", cal)

    report = "\n".join(lines)
    print(report)
    (LOGS / "reports").mkdir(parents=True, exist_ok=True)
    (LOGS / "reports" / f"montecarlo_{int(time.time())}.txt").write_text(report)
    (ROOT / ".data").mkdir(exist_ok=True)
    (ROOT / ".data" / "mc_verdict.json").write_text(
        json.dumps({"ts": int(time.time()), "verdicts": verdicts}, indent=2))


if __name__ == "__main__":
    main()
