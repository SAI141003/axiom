"""
END-OF-DAY LOSS REVIEW — the raw material for the council's daily autopsy.

Pulls every strategy's REAL resolved trades (reusing the brain's loaders),
isolates TODAY's losers, and for each strategy summarises: how many losses,
gross loss, the worst trades with their context, and a mechanical pattern hint
(e.g. "losers entered richer than winners"). The council API then has the LLM
turn this into root-cause + gap + recommendation — grounded in real numbers,
not vibes.

Usage: .venv/bin/python signals/loss_review.py [YYYY-MM-DD]
Writes .data/loss_review.json
"""
from __future__ import annotations

import json
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dryrun"))
import brain  # noqa: E402  — reuse its per-strategy trade loaders

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".data" / "loss_review.json"
ET = ZoneInfo("America/New_York")


def day_of(ts: float) -> str:
    return datetime.fromtimestamp(ts, ET).strftime("%Y-%m-%d")


def summarize(strategy: str, trades: list[dict]) -> dict | None:
    losers = [t for t in trades if not t.get("won") and (t.get("pnl") or 0) < 0]
    winners = [t for t in trades if t.get("won")]
    if not trades:
        return None
    gross_loss = round(sum(t["pnl"] for t in losers), 2)
    worst = sorted(losers, key=lambda t: t["pnl"])[:4]
    # mechanical pattern hint: did losers enter richer than winners?
    def avg_entry(ts):
        e = [t["entry"] for t in ts if isinstance(t.get("entry"), (int, float))]
        return round(sum(e) / len(e), 3) if e else None
    le, we = avg_entry(losers), avg_entry(winners)
    hint = None
    if le is not None and we is not None:
        if le > we + 0.03:
            hint = f"losers entered richer (avg {le} vs winners {we}) — paying up for low-payoff bets"
        elif le < we - 0.03:
            hint = f"losers entered cheaper (avg {le} vs winners {we}) — longshots that didn't hit"
        else:
            hint = f"entry price similar for winners/losers (~{we}) — the signal, not sizing, is the leak"
    return {
        "strategy": strategy,
        "trades": len(trades), "wins": len(winners), "losses": len(losers),
        "win_rate": round(len(winners) / len(trades), 3),
        "gross_loss": gross_loss,
        "net_pnl": round(sum(t.get("pnl") or 0 for t in trades), 2),
        "pattern_hint": hint,
        "worst": [{"pnl": t["pnl"], "entry": t.get("entry"),
                   "side": t.get("side"), "asset": t.get("asset") or t.get("symbol")
                   or t.get("city"), "ts": t["ts"]} for t in worst],
    }


def main() -> None:
    day = sys.argv[1] if len(sys.argv) > 1 else datetime.now(ET).strftime("%Y-%m-%d")
    strategies = []
    total_loss = 0.0
    for loader in brain.PERCEIVERS:
        try:
            all_t = loader()
        except Exception:
            continue
        today = [t for t in all_t if t.get("ts") and day_of(t["ts"]) == day]
        s = summarize(loader.__name__.replace("_trades", ""), today)
        if s and s["losses"] > 0:
            strategies.append(s)
            total_loss += s["gross_loss"]
    strategies.sort(key=lambda s: s["gross_loss"])   # biggest bleeders first
    doc = {
        "date": day, "generated": int(time.time()),
        "total_gross_loss": round(total_loss, 2),
        "strategies_with_losses": len(strategies),
        "strategies": strategies,
        "note": ("No losing trades resolved today." if not strategies
                 else f"{len(strategies)} strategies took losses; biggest bleeder first."),
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(doc, indent=2))
    print(json.dumps(doc, indent=2))


if __name__ == "__main__":
    main()
