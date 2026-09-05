"""
MAKER-ENTRY SIMULATOR (Menkveld B2) — would resting bids beat lifting asks?

Taker reality (measured): by t=72s the winning side costs 0.73-0.91 — the
market charges latecomers. This sim replays the probe data and asks: if at
the FIRST probe sample (t≈12s) we posted a resting bid below the ask on the
early-move side, would it fill, and would the filled trades win?

Fill model (conservative): the bid fills only if a LATER sample's ask for the
side trades AT/THROUGH our level (ask ≤ bid). 12s sampling underestimates
fills; fills after t=72s are not observed.

Adverse-selection check (Menkveld B3): win rate of FILLED trades vs ALL
signals — if fills lose much more, our fills are toxic (informed flow sells
to us precisely when we're wrong).

Output: .data/maker_sim.json + report. Run: .venv/bin/python dryrun/maker_sim.py
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_oraclelag.jsonl"
OUT = ROOT / ".data" / "maker_sim.json"
STAKE = 10.0
MIN_MOVES = [1.0, 1.5, 2.0, 3.0]      # signal threshold at first sample (bp)
BID_DELTAS = [0.03, 0.05, 0.08]       # post this far below the current ask


def load_probes() -> list[dict]:
    if not LOG.exists():
        return []
    out = []
    for line in LOG.open():
        try:
            r = json.loads(line)
            if r["type"] == "olprobe" and len(r.get("samples", [])) >= 4:
                out.append(r)
        except Exception:
            pass
    return out


def window_outcomes(wins: list[int]) -> dict[int, bool]:
    """win → up_won, from Binance 5m klines (batched)."""
    if not wins:
        return {}
    lo, hi = min(wins), max(wins)
    out: dict[int, bool] = {}
    start = lo
    while start <= hi:
        url = (f"https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m"
               f"&startTime={start * 1000}&limit=1000")
        try:
            kl = json.load(urllib.request.urlopen(url, timeout=15))
        except Exception:
            break
        if not kl:
            break
        for k in kl:
            t = int(k[0] // 1000)
            if t in set(wins):
                out[t] = float(k[4]) >= float(k[1])
        start = int(kl[-1][0] // 1000) + 300
        time.sleep(0.15)
    return out


SIGNAL_AT = [0, 1, 2, 3]              # sample index: t≈12, 24, 36, 48s


def simulate(probes: list[dict], outcomes: dict[int, bool]) -> list[dict]:
    """Sweep signal timing × threshold × bid depth. Signal read at sample k;
    the resting bid can only fill from samples AFTER k. Also record the
    taker alternative (lift the ask at k) for the same signals."""
    results = []
    for k in SIGNAL_AT:
        for min_mv in MIN_MOVES:
            for delta in BID_DELTAS:
                signals = fills = fill_wins = 0
                all_wins = 0
                pnl = taker_pnl = 0.0
                for p in probes:
                    if p["win"] not in outcomes or len(p["samples"]) <= k + 1:
                        continue
                    sk = p["samples"][k]
                    mv = sk.get("move_bp")
                    if mv is None or abs(mv) < min_mv:
                        continue
                    side = "UP" if mv > 0 else "DOWN"
                    ask_key = "up_ask" if side == "UP" else "down_ask"
                    a0 = sk.get(ask_key)
                    if not isinstance(a0, (int, float)) or not 0.05 < a0 < 0.95:
                        continue
                    signals += 1
                    won = (side == "UP") == outcomes[p["win"]]
                    all_wins += int(won)
                    taker_pnl += STAKE * (1 / a0 - 1) if won else -STAKE
                    bid = round(a0 - delta, 3)
                    if bid <= 0.02:
                        continue
                    filled = any(
                        isinstance(s.get(ask_key), (int, float)) and s[ask_key] <= bid
                        for s in p["samples"][k + 1:]
                    )
                    if filled:
                        fills += 1
                        fill_wins += int(won)
                        pnl += STAKE * (1 / bid - 1) if won else -STAKE
                if signals:
                    results.append({
                        "signal_at_s": 12 * (k + 1), "min_move_bp": min_mv,
                        "bid_delta": delta,
                        "signals": signals, "signal_winrate": round(all_wins / signals, 3),
                        "fills": fills, "fill_rate": round(fills / signals, 3),
                        "fill_winrate": round(fill_wins / fills, 3) if fills else None,
                        "pnl": round(pnl, 2),
                        "ev_per_fill": round(pnl / fills, 2) if fills else None,
                        "taker_pnl_same_signals": round(taker_pnl, 2),
                    })
    return results


def main() -> None:
    probes = load_probes()
    wins = sorted({p["win"] for p in probes})
    outcomes = window_outcomes(wins)
    results = simulate(probes, outcomes)
    doc = {"ts": int(time.time()), "probes": len(probes),
           "windows_resolved": len(outcomes), "results": results}
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2))

    print(f"[maker-sim] {len(probes)} probe windows · {len(outcomes)} with outcomes")
    if not results:
        print("  not enough data yet — probes accumulate every 5-min window")
        return
    print(f"  {'at':>4} {'move≥':>6} {'bidΔ':>5} {'sig':>4} {'sigWR':>6} {'fills':>6} "
          f"{'fillWR':>7} {'maker$':>8} {'taker$':>8}")
    for r in sorted(results, key=lambda x: -(x["pnl"]))[:12]:
        print(f"  {r['signal_at_s']:>3}s {r['min_move_bp']:>5}bp {r['bid_delta']:>5} "
              f"{r['signals']:>4} {r['signal_winrate']:>6} {r['fills']:>6} "
              f"{str(r['fill_winrate']):>7} {r['pnl']:>8} {r['taker_pnl_same_signals']:>8}")
    # adverse-selection flag on the best config
    best = max(results, key=lambda x: x["pnl"])
    if best["fills"] >= 10 and best["fill_winrate"] is not None:
        tox = best["signal_winrate"] - best["fill_winrate"]
        print(f"  adverse selection (best config): signals {best['signal_winrate']:.0%} "
              f"vs fills {best['fill_winrate']:.0%} → {'TOXIC fills' if tox > 0.1 else 'acceptable'}")


if __name__ == "__main__":
    main()
