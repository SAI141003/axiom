"""
SCENARIO RESOLVER — scores the Company Scenario engine's OWN forecasts vs reality.

Every scenario forecast is logged with a horizon. Once that horizon has passed,
this fetches the REAL price then and grades a Brier score — the same self-audit
the Oracle and earnings engine use. No forecast is trusted until it's scored.

Writes .data/scenario_scorecard.json. Run daily (overnight loop).
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from earnings_engine import _get, _raw

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "scenario_predictions.jsonl"
OUT = ROOT / ".data" / "scenario_scorecard.json"


def spot(sym: str):
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=1d")
        return j["chart"]["result"][0]["meta"].get("regularMarketPrice")
    except Exception:
        return None


def main() -> None:
    if not LOG.exists():
        print("[scenario-resolver] no forecasts yet")
        return
    rows = [json.loads(l) for l in LOG.open() if l.strip()]
    now = time.time()
    changed = False
    for r in rows:
        if r.get("resolved"):
            continue
        horizon_s = r.get("horizon_days", 21) * 86400 * 1.4   # trading→calendar cushion
        if now < r["ts"] + horizon_s:
            continue
        px = spot(r["symbol"])
        if px is None or not r.get("ref_price"):
            continue
        up = px > r["ref_price"]
        p_up = r["p_up"]
        r.update(resolved=True, outcome="UP" if up else "DOWN",
                 correct=bool((r["verdict"] == "UP") == up),
                 brier=round((p_up - (1 if up else 0)) ** 2, 4),
                 resolved_px=px, resolved_at=int(now))
        changed = True
        time.sleep(0.3)
    if changed:
        LOG.write_text("".join(json.dumps(r) + "\n" for r in rows))

    done = [r for r in rows if r.get("resolved") and "brier" in r]
    if done:
        n = len(done)
        acc = sum(1 for r in done if r["correct"]) / n
        brier = sum(r["brier"] for r in done) / n
        OUT.write_text(json.dumps({
            "ts": int(now), "resolved": n,
            "accuracy": round(acc, 3), "brier": round(brier, 4),
            "verdict": "skilled (beats 0.25 coin-flip)" if brier < 0.25 else "no skill yet",
            "recent": [{"sym": r["symbol"], "verdict": r["verdict"], "p": r["p_up"],
                        "outcome": r.get("outcome"), "correct": r.get("correct")}
                       for r in done[-8:]],
        }, indent=2))
        print(f"[scenario-resolver] {n} scored · accuracy {acc:.0%} · Brier {brier:.3f}")
    else:
        pend = len([r for r in rows if not r.get("resolved")])
        OUT.write_text(json.dumps({"ts": int(now), "resolved": 0, "pending": pend,
                                   "verdict": "building record — forecasts resolve at horizon"}, indent=2))
        print(f"[scenario-resolver] {pend} pending, none at horizon yet")


if __name__ == "__main__":
    main()
