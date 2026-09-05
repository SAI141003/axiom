"""
Dry-run analyzer — reads logs/dryrun_5m.jsonl + logs/dryrun_weather.jsonl and
reports performance plus data-driven improvement recommendations.

Usage: .venv/bin/python dryrun/analyze.py
"""
from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

LOGS = Path(__file__).resolve().parent.parent / "logs"
STAKE = 10.0


def clob_fee(p: float) -> float:
    return 0.018 * 4.0 * p * (1.0 - p)


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.open():
        try:
            out.append(json.loads(line))
        except Exception:
            pass
    return out


# ── Crypto ────────────────────────────────────────────────────────────────────

def analyze_crypto() -> None:
    rows = load(LOGS / "dryrun_5m.jsonl")
    entries = {r["id"]: r for r in rows if r["type"] == "entry"}
    resolves = {r["id"]: r for r in rows if r["type"] == "resolve"}
    joined = [{**entries[i], **resolves[i]} for i in entries if i in resolves]

    print("=" * 70)
    print(f"CRYPTO 5-MIN DRY RUN — {len(entries)} windows logged, {len(joined)} resolved")
    print("=" * 70)
    if not joined:
        print("No resolved windows yet.")
        return

    traded = [r for r in joined if r["traded"] and r.get("won") is not None]
    if traded:
        wins = sum(r["won"] for r in traded)
        pnl = sum(r["pnl"] for r in traded)
        avg_entry = sum((r["up_price"] if r["side"] == "UP" else r["down_price"]) for r in traded) / len(traded)
        print(f"\nLIVE STRATEGY (threshold 0.25): {len(traded)} trades, "
              f"WR {100*wins/len(traded):.1f}% (breakeven ≈{100*avg_entry:.1f}%), "
              f"P&L ${pnl:+.2f} ({100*pnl/(len(traded)*STAKE):+.1f}% ROI)")
        per = defaultdict(list)
        for r in traded:
            per[r["asset"]].append(r)
        for a, rs in sorted(per.items()):
            w = sum(r["won"] for r in rs)
            p = sum(r["pnl"] for r in rs)
            print(f"  {a:<5} {len(rs):>4} trades  WR {100*w/len(rs):5.1f}%  P&L {p:+8.2f}$")

    # Threshold sweep on ALL windows (what-if analysis)
    print("\nTHRESHOLD SWEEP (all logged windows, hypothetical):")
    print(f"  {'thresh':>7} {'trades':>7} {'WR%':>7} {'P&L':>10} {'ROI%':>7}")
    for th in (0.25, 0.35, 0.45, 0.55, 0.70, 0.85):
        sel = []
        for r in joined:
            sc = r["score"]
            if abs(sc) <= th:
                continue
            side = "UP" if sc > 0 else "DOWN"
            entry = r["up_price"] if side == "UP" else r["down_price"]
            if not (0.01 < entry < 0.62):
                continue
            won = (side == "UP") == r["up_won"]
            gross = STAKE * (1 / entry - 1) if won else -STAKE
            sel.append((won, gross - STAKE * clob_fee(entry)))
        if sel:
            w = sum(x[0] for x in sel)
            p = sum(x[1] for x in sel)
            print(f"  {th:>7.2f} {len(sel):>7} {100*w/len(sel):>6.1f}% {p:>+9.2f}$ {100*p/(len(sel)*STAKE):>+6.1f}%")

    # Momentum-only vs persistence contribution
    print("\nSIGNAL COMPONENT CHECK (does momentum sign alone predict outcome?):")
    for a in sorted({r["asset"] for r in joined}):
        rs = [r for r in joined if r["asset"] == a and abs(r["momentum_bp"]) > 1]
        if not rs:
            continue
        agree = sum((r["momentum_bp"] > 0) == r["up_won"] for r in rs)
        print(f"  {a:<5} momentum→outcome agreement: {100*agree/len(rs):.1f}%  (n={len(rs)})")


# ── Weather ───────────────────────────────────────────────────────────────────

def analyze_weather() -> None:
    rows = load(LOGS / "dryrun_weather.jsonl")
    snaps = [r for r in rows if r["type"] == "snapshot"]
    resolves = {r["slug"]: r for r in rows if r["type"] == "resolve"}

    print("\n" + "=" * 70)
    print(f"WEATHER DRY RUN — {len(snaps)} snapshots, {len(resolves)} events resolved")
    print("=" * 70)
    if not resolves:
        print("No resolved events yet (temperature markets resolve next local day).")
        return

    # Score at lead-time stages. Scoring only the final snapshot is unfair:
    # by then the market has converged to the known outcome (Brier→0).
    # The tradeable question is whether the model beats the market EARLIER.
    stages = [
        ("early  (<8h into local day)", lambda sn: sn["hours_elapsed"] < 8),
        ("midday (8-15h)",              lambda sn: 8 <= sn["hours_elapsed"] <= 15),
        ("late   (>15h, pre-complete)", lambda sn: sn["hours_elapsed"] > 15 and not sn["day_complete"]),
    ]
    for label, keep in stages:
        picked: dict[str, dict] = {}
        for sn in snaps:
            if sn["slug"] in resolves and keep(sn):
                cur = picked.get(sn["slug"])
                if cur is None or sn["ts"] > cur["ts"]:
                    picked[sn["slug"]] = sn

        model_brier = market_brier = 0.0
        n_buckets = 0
        edge_hits, edge_total, edge_pnl = 0, 0, 0.0
        for slug, sn in picked.items():
            res = resolves[slug]
            for b in sn["buckets"]:
                actual = 1.0 if (b["low"] == res["winning_low"] and b["high"] == res["winning_high"]) else 0.0
                model_brier += (b["model"] - actual) ** 2
                market_brier += (b["market"] - actual) ** 2
                n_buckets += 1
                edge = b["model"] - b["market"]
                if abs(edge) > 0.08 and 0.02 < b["market"] < 0.98:
                    edge_total += 1
                    hit = (edge > 0) == (actual == 1.0)
                    edge_hits += int(hit)
                    # $10 paper stake on the flagged side at market price
                    if edge > 0:   # buy YES at market
                        edge_pnl += STAKE * (1 / b["market"] - 1) if actual == 1.0 else -STAKE
                    else:          # buy NO at (1 - market)
                        edge_pnl += STAKE * (1 / (1 - b["market"]) - 1) if actual == 0.0 else -STAKE

        if n_buckets == 0:
            print(f"\n  {label}: no snapshots yet")
            continue
        verdict = "MODEL BEATS MARKET ✓" if model_brier < market_brier else "market better ✗"
        print(f"\n  {label}: {len(picked)} events / {n_buckets} buckets")
        print(f"    Brier model {model_brier/n_buckets:.4f} vs market {market_brier/n_buckets:.4f} → {verdict}")
        if edge_total:
            print(f"    Flagged edges (>8%, mkt 2-98¢): {edge_total}, hit {edge_hits} "
                  f"({100*edge_hits/edge_total:.0f}%), paper P&L ${edge_pnl:+.2f}")




def analyze_weather_trades() -> None:
    """LIVE paper trades on flagged weather edges — the gap measurement."""
    rows = load(LOGS / "dryrun_weather.jsonl")
    trades = [r for r in rows if r["type"] == "wtrade"]
    resolves = {r["slug"]: r for r in rows if r["type"] == "resolve"}
    print("\n" + "=" * 70)
    print(f"WEATHER LIVE PAPER TRADES — {len(trades)} placed")
    print("=" * 70)
    if not trades:
        print("No trades yet — daemon places one per flagged edge per scan.")
        return
    scored = []
    for t in trades:
        res = resolves.get(t["slug"])
        if not res:
            continue
        won_bucket = t["low"] == res["winning_low"] and t["high"] == res["winning_high"]
        win = won_bucket if t["side"] == "YES" else not won_bucket
        pnl = t["stake"] * (1 / t["entry"] - 1) if win else -t["stake"]
        scored.append({**t, "win": win, "pnl": pnl})
    open_n = len(trades) - len(scored)
    if scored:
        wins = sum(s["win"] for s in scored)
        pnl = sum(s["pnl"] for s in scored)
        avg_gap = sum(abs(s["edge"]) for s in scored) / len(scored)
        print(f"Resolved: {len(scored)} (open: {open_n}) · hit {wins} "
              f"({100*wins/len(scored):.0f}%) · P&L ${pnl:+.2f} "
              f"({100*pnl/(len(scored)*10):+.1f}% ROI) · avg model-market gap {avg_gap*100:.1f}%")
        by_src = {}
        for sc in scored:
            by_src.setdefault(sc.get("obs_source", "?"), []).append(sc)
        for src, ss in sorted(by_src.items()):
            w = sum(x["win"] for x in ss); p = sum(x["pnl"] for x in ss)
            print(f"  obs={src:<6} {len(ss):>3} trades  hit {100*w/len(ss):3.0f}%  P&L {p:+8.2f}$")
    else:
        print(f"All {open_n} trades still open (resolve next local day).")


# ── Options ───────────────────────────────────────────────────────────────────

def analyze_options() -> None:
    rows = load(LOGS / "dryrun_options.jsonl")
    positions = {r["id"]: r for r in rows if r["type"] == "position"}
    marks = [r for r in rows if r["type"] == "mark"]

    print("\n" + "=" * 70)
    print(f"OPTIONS PAPER TEST — {len(positions)} positions, {len(marks)} marks")
    print("=" * 70)
    if not positions:
        print("No positions yet (daemon opens weekdays ~10:35 ET).")
        return
    latest: dict[str, dict] = {}
    for m in marks:
        cur = latest.get(m["id"])
        if cur is None or m["ts"] > cur["ts"]:
            latest[m["id"]] = m
    total_cost = sum(p["cost"] for p in positions.values())
    total_val = 0.0
    for pid, p in sorted(positions.items()):
        m = latest.get(pid)
        val = m["value"] if m else None
        total_val += val if val is not None else p["cost"]   # unmarked = at cost
        upnl = f"{m['unrealized']:+.2f}" if m else "unmarked"
        print(f"  {p['date']} {p['symbol']:<5} {p['opt_type']:<4} ${p['strike']:<7} "
              f"exp {p['expiry']} [{p['kind']:<5}] cost ${p['cost']:<8.0f} → {upnl}")
    print(f"\n  DEPLOYED ${total_cost:,.0f} · MARKED VALUE ${total_val:,.0f} "
          f"· UNREALIZED {total_val - total_cost:+,.0f}$")



def analyze_oraclelag() -> None:
    rows = load(LOGS / "dryrun_oraclelag.jsonl")
    ent = {r["win"]: r for r in rows if r["type"] == "olentry"}
    res = [r for r in rows if r["type"] == "olresolve"]
    print("\n" + "=" * 70)
    print(f"BTC ORACLE-LAG (first-minute signal) — {len([e for e in ent.values() if e['traded']])} trades, {len(res)} resolved")
    print("=" * 70)
    if not res:
        print("No resolved trades yet (needs a window + 5min).")
        return
    wins = sum(r["won"] for r in res); pnl = sum(r["pnl"] for r in res)
    print(f"  WR {100*wins/len(res):.0f}% · P&L ${pnl:+.2f} · avg per trade ${pnl/len(res):+.2f}")
    # does bigger chainlink lag → higher win rate?
    joined = [{**ent[r["win"]], **r} for r in res if r["win"] in ent]
    strong = [j for j in joined if abs(j.get("cl_lag_bp") or 0) > 3]
    if strong:
        w = sum(j["won"] for j in strong)
        print(f"  when chainlink lags >3bp ({len(strong)} trades): WR {100*w/len(strong):.0f}%")

if __name__ == "__main__":
    analyze_crypto()
    analyze_weather()
    analyze_weather_trades()
    analyze_options()
    analyze_oraclelag()
