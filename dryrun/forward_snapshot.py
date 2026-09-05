"""
FORWARD SNAPSHOT — the honest scoreboard that builds over real days.

Backtests are hindsight; this is the forward test. Once a day it records where each
$100 paper account actually stands, appending one row per day to a time series. In
a few days you have real out-of-sample numbers — no cherry-picking, just what the
bots did while nobody was tuning them. Reads the brain's own account rollup so it
can never disagree with the dashboard.

  python dryrun/forward_snapshot.py         (take one snapshot now)
Runs daily via launchd com.polymarket.dryrun.forwardsnapshot.
Log: logs/forward_perf.jsonl · latest+history: .data/forward_perf.json
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path

import sys
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "dryrun"))
from brain import engines_status

PERF_LOG = ROOT / "logs" / "forward_perf.jsonl"
OUT = ROOT / ".data" / "forward_perf.json"


def snapshot() -> dict:
    s = engines_status()
    accts = {k: v for k, v in s.items() if "($100 acct)" in k}
    row = {"date": datetime.now(timezone.utc).strftime("%Y-%m-%d"), "ts": int(time.time()),
           "accounts": {k: {"account": v.get("account"), "pnl": v.get("pnl"),
                            "trades": v.get("trades"), "win_rate": v.get("win_rate")}
                        for k, v in accts.items()}}
    PERF_LOG.parent.mkdir(exist_ok=True)
    # one row per day — replace today's if it already exists
    rows = []
    if PERF_LOG.exists():
        rows = [json.loads(l) for l in PERF_LOG.open() if l.strip() and json.loads(l).get("date") != row["date"]]
    rows.append(row)
    with PERF_LOG.open("w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    days = len({r["date"] for r in rows})
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"latest": row, "days_tracked": days,
                               "history": rows[-60:]}, indent=2))
    return row


if __name__ == "__main__":
    r = snapshot()
    print(f"[forward] {r['date']} — {len(r['accounts'])} paper accounts snapshotted")
    for k, v in r["accounts"].items():
        wr = f"{v['win_rate']*100:.0f}%" if v.get("win_rate") is not None else "—"
        print(f"  {k:<28} ${v['account']:>7}  P&L {v['pnl']:+.2f}  ({v['trades']} trades, win {wr})")
