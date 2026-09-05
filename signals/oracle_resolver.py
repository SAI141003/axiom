"""
ORACLE RESOLVER — scores the Oracle's OWN forecasts against reality.

This is what separates our Oracle from any prompt-an-LLM tool: its predictions
become a tracked, Brier-scored record. Every stock-direction / earnings forecast
is resolved next session against the real close; the Brier score (Tetlock's
honesty-optimal metric) is computed and surfaced. Calibration you can audit.

Resolves:
  - stock_direction "today"/"week": did it close up vs the reference prev-close?
  - (business_idea / long-horizon: left open — they resolve on a real timeline)

Output: appends {resolved:true, outcome, brier} back into the log and writes a
rolling scorecard to .data/oracle_scorecard.json.
Usage: .venv/bin/python signals/oracle_resolver.py   (overnight loop, daily)
"""
from __future__ import annotations

import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "oracle_predictions.jsonl"
OUT = ROOT / ".data" / "oracle_scorecard.json"


def quote(sym: str):
    try:
        req = urllib.request.Request(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=5d&interval=1d",
            headers={"User-Agent": "Mozilla/5.0"})
        m = json.load(urllib.request.urlopen(req, timeout=12))["chart"]["result"][0]["meta"]
        return m.get("regularMarketPrice")
    except Exception:
        return None


def main() -> None:
    if not LOG.exists():
        print("[oracle-resolver] no predictions yet")
        return
    rows = [json.loads(l) for l in LOG.open() if l.strip()]
    now = time.time()
    changed = False
    for r in rows:
        if r.get("resolved") or r.get("type") != "stock_direction":
            continue
        age = now - r["ts"]
        horizon_s = 3 * 86400 if r.get("horizon") == "today" else 8 * 86400
        if age < 20 * 3600 or age > horizon_s + 5 * 86400:
            continue                      # too soon, or too old to fairly resolve
        px = quote(r["symbol"]) if r.get("symbol") else None
        ref = r.get("refPrevClose") or r.get("refPrice")
        if px is None or not ref:
            continue
        up = px > ref
        predicted_up = r["verdict"] == "UP"
        outcome = 1 if up else 0
        # `probability` is always P(up); Brier is on P(up) vs the realized outcome.
        p_up = r["probability"]
        brier = round((p_up - outcome) ** 2, 4)
        r.update(resolved=True, outcome="UP" if up else "DOWN",
                 correct=bool(predicted_up == up), brier=brier,
                 resolvedPx=px, resolvedAt=int(now))
        changed = True
        time.sleep(0.3)

    if changed:
        LOG.write_text("".join(json.dumps(r) + "\n" for r in rows))

    # scorecard over resolved predictions
    done = [r for r in rows if r.get("resolved") and "brier" in r]
    if done:
        n = len(done)
        acc = sum(1 for r in done if r.get("correct")) / n
        brier = sum(r["brier"] for r in done) / n
        # confident calls (|p-0.5|>0.15) accuracy — where it commits
        conf = [r for r in done if abs(r["probability"] - 0.5) > 0.15]
        conf_acc = sum(1 for r in conf if r.get("correct")) / len(conf) if conf else None
        OUT.write_text(json.dumps({
            "ts": int(now), "resolved": n,
            "accuracy": round(acc, 3),
            "brier": round(brier, 4),
            "brier_verdict": ("skilled (beats 0.25 coin-flip)" if brier < 0.25
                              else "no skill yet"),
            "confident_calls": len(conf),
            "confident_accuracy": round(conf_acc, 3) if conf_acc is not None else None,
            "recent": [{"q": r["question"][:60], "verdict": r["verdict"],
                        "p": r["probability"], "outcome": r.get("outcome"),
                        "correct": r.get("correct")} for r in done[-8:]],
        }, indent=2))
        print(f"[oracle-resolver] {n} resolved · accuracy {acc:.0%} · Brier {brier:.3f}")
    else:
        print(f"[oracle-resolver] {len([r for r in rows if not r.get('resolved')])} pending, none resolvable yet")


if __name__ == "__main__":
    main()
