"""
EARNINGS RESOLVER — scores the earnings engine's OWN forecasts against reality.

For every logged forecast whose earnings date has passed, it fetches the actual
result and grades two Brier scores:
  • beat Brier   — was P(beat) right? (actual EPS vs the consensus it faced)
  • dir  Brier   — was P(up after) right? (close the day after vs the day before)

Writes a rolling scorecard to .data/earnings_scorecard.json. A Brier < 0.25 on
EITHER track = skill beyond a coin flip; the direction track beating 0.25 is the
hard, meaningful win (beats are easy, the reaction is near-efficient).

Usage: .venv/bin/python signals/earnings_resolver.py   (daily, overnight loop)
"""
from __future__ import annotations

import json
import time
from datetime import datetime
from pathlib import Path

import sys
sys.path.insert(0, str(Path(__file__).resolve().parent))
from earnings_engine import _get, _raw          # reuse the crumb'd Yahoo client (script or module)

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "earnings_predictions.jsonl"
OUT = ROOT / ".data" / "earnings_scorecard.json"


def actual_result(sym: str, asof_ts: int):
    """Return (beat: bool|None, up_after: bool|None) for the report that has
    happened since the forecast was made."""
    try:
        d = _get(f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{sym}"
                 f"?modules=earningsHistory")["quoteSummary"]["result"][0]
        hist = d.get("earningsHistory", {}).get("history", [])
    except Exception:
        return None, None
    # most recent quarter with an actual reported after the forecast timestamp
    for q in reversed(hist):                     # history is oldest→newest
        qdate = _raw(q, "quarter")
        act, est = _raw(q, "epsActual"), _raw(q, "epsEstimate")
        if act is None or est is None:
            continue
        if qdate and qdate > asof_ts - 5 * 86400:    # this quarter is the forecast's target
            return (act > est), None                 # direction resolved separately below
    return None, None


def price_move(sym: str, earnings_fmt: str | None):
    """Did the stock close up the session after the report vs the session before?"""
    if not earnings_fmt:
        return None
    try:
        edt = datetime.fromisoformat(earnings_fmt.split("T")[0]).timestamp()
    except Exception:
        return None
    try:
        j = _get(f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}"
                 f"?period1={int(edt-6*86400)}&period2={int(edt+6*86400)}&interval=1d")
        res = j["chart"]["result"][0]
        ts = res["timestamp"]
        closes = res["indicators"]["quote"][0]["close"]
    except Exception:
        return None
    pts = [(t, c) for t, c in zip(ts, closes) if c is not None]
    before = [c for t, c in pts if t <= edt]
    after = [c for t, c in pts if t > edt]
    if not before or not after:
        return None
    return after[0] > before[-1]


def main() -> None:
    if not LOG.exists():
        print("[earnings-resolver] no forecasts yet")
        return
    rows = [json.loads(l) for l in LOG.open() if l.strip()]
    now = time.time()
    changed = False
    for r in rows:
        if r.get("resolved"):
            continue
        if not r.get("next_earnings"):
            continue
        try:
            edt = datetime.fromisoformat(r["next_earnings"].split("T")[0]).timestamp()
        except Exception:
            continue
        if now < edt + 2 * 86400 or now > edt + 40 * 86400:
            continue                              # not reported yet, or too stale
        beat, _ = actual_result(r["symbol"], r["asOf"])
        up = price_move(r["symbol"], r["next_earnings"])
        if beat is None and up is None:
            continue
        rec = {"resolvedAt": int(now)}
        if beat is not None:
            rec["beat_actual"] = beat
            rec["beat_correct"] = (r["verdict_beat"] == "BEAT") == beat
            rec["beat_brier"] = round((r["p_beat"] - (1 if beat else 0)) ** 2, 4)
        if up is not None:
            rec["up_actual"] = up
            rec["dir_correct"] = (r["verdict_direction"] == "UP") == up
            rec["dir_brier"] = round((r["p_up_after"] - (1 if up else 0)) ** 2, 4)
        r.update(resolved=True, **rec)
        changed = True
        time.sleep(0.3)

    if changed:
        LOG.write_text("".join(json.dumps(r) + "\n" for r in rows))

    done = [r for r in rows if r.get("resolved")]
    beats = [r for r in done if "beat_brier" in r]
    dirs = [r for r in done if "dir_brier" in r]
    if beats or dirs:
        card = {"ts": int(now), "resolved": len(done)}
        if beats:
            card["beat"] = {
                "n": len(beats),
                "accuracy": round(sum(r["beat_correct"] for r in beats) / len(beats), 3),
                "brier": round(sum(r["beat_brier"] for r in beats) / len(beats), 4),
            }
        if dirs:
            b = sum(r["dir_brier"] for r in dirs) / len(dirs)
            card["direction"] = {
                "n": len(dirs),
                "accuracy": round(sum(r["dir_correct"] for r in dirs) / len(dirs), 3),
                "brier": round(b, 4),
                "verdict": "SKILL (beats coin-flip 0.25)" if b < 0.25 else "near-efficient (expected)",
            }
        card["recent"] = [{"sym": r["symbol"], "p_beat": r["p_beat"],
                           "beat": r.get("beat_actual"), "p_up": r["p_up_after"],
                           "up": r.get("up_actual")} for r in done[-8:]]
        OUT.write_text(json.dumps(card, indent=2))
        print(f"[earnings-resolver] {len(done)} resolved · "
              f"beat n={len(beats)} · dir n={len(dirs)}")
    else:
        print(f"[earnings-resolver] {len([r for r in rows if not r.get('resolved')])} pending")


if __name__ == "__main__":
    main()
