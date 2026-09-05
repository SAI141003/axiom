"""
END-OF-DAY COUNCIL LOOP — the self-improving daily cycle. Runs automatically
after the close (launchd com.polymarket.eod.council), so the desk reviews itself
without anyone asking.

The loop: PROPOSE → IMPLEMENT → OBSERVE → PROPOSE NEW.

  PROPOSE      pull today's real losses, have the council explain each (root
               cause / gap / fix) via /api/council/review.
  IMPLEMENT    record each fix as an action. Bounded, reversible knobs already
               owned by KRONOS (e.g. disarm a confirmed stable bleeder) are
               flagged auto_apply; code-level fixes are flagged needs_review —
               we never silently rewrite strategy code.
  OBSERVE      look at yesterday's actions and score them: did the flagged
               strategy's P&L actually improve? (helped / hurt / flat)
  PROPOSE NEW  today's fixes become tomorrow's actions to observe.

State:
  .data/eod_review.json      latest full review (the Council tab auto-loads this)
  .data/eod_history.json     date → {strategy: net_pnl}   (for OBSERVE)
  .data/eod_actions.json     open actions with status + outcome
  .data/eod_loop.jsonl       one line per daily run (audit trail)
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / ".data"
ET = ZoneInfo("America/New_York")

# strategies KRONOS can safely act on itself (bounded, reversible)
AUTO_APPLY = {"kronos1h", "weather", "oraclelag"}


def _load(name: str, default):
    p = DATA / name
    if p.exists():
        try: return json.loads(p.read_text())
        except Exception: pass
    return default


def _save(name: str, obj) -> None:
    DATA.mkdir(exist_ok=True)
    (DATA / name).write_text(json.dumps(obj, indent=2))


def fetch_review() -> dict | None:
    try:
        with urllib.request.urlopen("http://localhost:3000/api/council/review", timeout=180) as r:
            return json.load(r)
    except Exception as e:
        print(f"[eod] review fetch failed: {e}", flush=True)
        return None


def main() -> None:
    today = datetime.now(ET).strftime("%Y-%m-%d")

    # ── PROPOSE: get the council's review of today's losses ──
    review = fetch_review()
    if not review:
        return
    _save("eod_review.json", review)
    verdicts = review.get("verdicts", [])

    # ── update P&L history (for OBSERVE) ──
    history = _load("eod_history.json", {})
    history[today] = {v["strategy"]: v.get("netPnl", 0.0) for v in verdicts}
    # keep 60 days
    for d in sorted(history)[:-60]:
        history.pop(d, None)
    _save("eod_history.json", history)

    # ── OBSERVE: score yesterday's open actions ──
    actions = _load("eod_actions.json", {"open": []})
    days = sorted(history)
    prev_day = days[-2] if len(days) >= 2 else None
    for a in actions["open"]:
        if a.get("outcome") or not prev_day:
            continue
        s = a["strategy"]
        before = a.get("net_at_propose")
        after = history.get(today, {}).get(s)
        if before is None or after is None:
            continue
        # "improved" = today's net for that strategy is less negative / positive
        if after > before + 1:
            a["outcome"] = "helped"
        elif after < before - 1:
            a["outcome"] = "hurt"
        else:
            a["outcome"] = "flat"
        a["net_after"] = round(after, 2)
        a["observed_on"] = today

    # ── PROPOSE NEW: today's fixes become open actions ──
    for v in verdicts:
        actions["open"].append({
            "date": today, "strategy": v["strategy"],
            "gross_loss": v.get("grossLoss"), "net_at_propose": v.get("netPnl", 0.0),
            "root_cause": v.get("rootCause"), "gap": v.get("gap"),
            "recommendation": v.get("recommendation"),
            "status": "auto_apply" if v["strategy"] in AUTO_APPLY else "needs_review",
            "outcome": None,
        })
    # keep the last 100 actions
    actions["open"] = actions["open"][-100:]
    _save("eod_actions.json", actions)

    # ── audit log ──
    scored = [a for a in actions["open"] if a.get("outcome")]
    helped = sum(1 for a in scored if a["outcome"] == "helped")
    entry = {"date": today, "ts": int(time.time()),
             "total_loss": review.get("totalLoss"),
             "new_actions": len(verdicts),
             "observed": len([a for a in actions["open"] if a.get("observed_on") == today]),
             "helped_to_date": helped, "scored_to_date": len(scored)}
    with (DATA / "eod_loop.jsonl").open("a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"[eod] {today}: reviewed ${review.get('totalLoss')} loss, "
          f"{len(verdicts)} new fixes proposed, {entry['observed']} prior scored "
          f"({helped} helped)", flush=True)


if __name__ == "__main__":
    main()
