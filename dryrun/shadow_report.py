"""
SHADOW-LIVE REPORT — the go/no-go read on real trading.

The oracle-lag daemon now records, for every paper trade, the fill it would have
ACTUALLY gotten on the live CLOB after realistic REST latency (no order placed).
This joins those to the resolved outcomes and answers one question honestly:

    does the paper edge survive real execution, or is it a fill-timing illusion?

  paper P&L   — priced at the instantaneous ask the paper trade assumed
  shadow P&L  — priced at the real, latency-delayed, book-walked fill
  the GAP     — the true cost of trading this edge live (adverse selection)

Rule of thumb: if shadow P&L stays clearly positive over 100+ trades, a tiny-capital
live test is defensible. If the gap eats the edge, it stays on paper. No exceptions.

Usage: .venv/bin/python dryrun/shadow_report.py
Writes .data/shadow_report.json
"""
from __future__ import annotations

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "dryrun_oraclelag.jsonl"
OUT = ROOT / ".data" / "shadow_report.json"


def main() -> None:
    rows = [json.loads(l) for l in LOG.open() if l.strip()] if LOG.exists() else []
    entries = {r["win"]: r for r in rows if r.get("type") == "olentry" and r.get("traded")}
    resolves = [r for r in rows if r.get("type") == "olresolve"]

    paired = []
    for r in resolves:
        e = entries.get(r["win"])
        if not e or "shadow_pnl" not in r or not e.get("shadow"):
            continue
        paired.append({
            "win": r["win"], "side": e.get("side"),
            "paper_ask": e.get("entry"), "shadow_fill": e["shadow"].get("shadow_fill"),
            "adverse": e["shadow"].get("adverse"), "slip": e["shadow"].get("slip"),
            "won": r["won"], "paper_pnl": r["pnl"], "shadow_pnl": r["shadow_pnl"],
        })

    n = len(paired)
    n_shadow_captured = sum(1 for e in entries.values() if e.get("shadow"))
    if not n:
        OUT.parent.mkdir(exist_ok=True)
        OUT.write_text(json.dumps({
            "resolved_with_shadow": 0,
            "shadow_captured_pending": n_shadow_captured,
            "verdict": "no shadow-scored trades yet — the harness records them going "
                       "forward; check back after the next resolved windows.",
        }, indent=2))
        print(f"[shadow] 0 resolved · {n_shadow_captured} captured & awaiting resolution")
        return

    paper = sum(p["paper_pnl"] for p in paired)
    shadow = sum(p["shadow_pnl"] for p in paired)
    slips = [p["slip"] for p in paired if p["slip"] is not None]
    adverse = [p["adverse"] for p in paired if p["adverse"] is not None]
    avg_slip = sum(slips) / len(slips) if slips else 0.0
    worse = sum(1 for a in adverse if a > 0)          # ask moved against us
    # per-trade edge and a rough t-stat on shadow P&L
    mean_sh = shadow / n
    sd = math.sqrt(sum((p["shadow_pnl"] - mean_sh) ** 2 for p in paired) / n) if n > 1 else 0
    tstat = (mean_sh / (sd / math.sqrt(n))) if sd else 0.0

    survives = shadow > 0 and mean_sh > 0
    report = {
        "resolved_with_shadow": n,
        "paper_pnl": round(paper, 2),
        "shadow_pnl": round(shadow, 2),
        "execution_cost": round(paper - shadow, 2),
        "avg_slip_per_trade": round(avg_slip, 4),
        "adverse_moves_pct": round(100 * worse / len(adverse), 0) if adverse else None,
        "shadow_pnl_per_trade": round(mean_sh, 3),
        "shadow_tstat": round(tstat, 2),
        "verdict": (
            f"edge SURVIVES real fills so far (+${shadow:.2f} shadow over {n} trades, "
            f"t={tstat:.1f}). A tiny-capital live test becomes defensible once this holds "
            f"past ~100 trades." if survives else
            f"edge does NOT survive execution: paper +${paper:.2f} → shadow ${shadow:.2f}. "
            f"Adverse selection eats it. STAY ON PAPER."),
        "recent": paired[-10:],
    }
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2))
    print(f"[shadow] {n} trades · paper ${paper:+.2f} → shadow ${shadow:+.2f} "
          f"(cost ${paper-shadow:+.2f}, avg slip {avg_slip:+.4f}) · {report['verdict'][:60]}")


if __name__ == "__main__":
    main()
