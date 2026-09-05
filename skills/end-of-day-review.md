---
name: end-of-day-review
agent: The Council (chaired by KRONOS)
description: Convene the desk over every real loss taken today; explain why, name the gap, prescribe one fix per strategy.
data_connectors: [strategy-trade-logs]
implemented_by: signals/loss_review.py + frontend/app/api/council/review/route.ts
---

# End-of-Day Review

The council's daily loss autopsy. Grounded entirely in the day's real resolved
trades — no hypothetical losses.

## Method

1. **Gather** — `loss_review.py` reuses the brain's per-strategy loaders and
   isolates today's losers per strategy (count, gross loss, worst trades, and a
   mechanical pattern hint like "losers entered richer than winners").
2. **Autopsy** — each bleeding strategy is handed to its named analyst (Dex for
   options, Nova for crypto, Vera for VWAP, …). The analyst returns, in JSON:
   `root_cause`, `gap`, `recommendation` — blunt, specific, one fix.
3. **Close** — KRONOS synthesises the day: biggest leak, the common thread, the
   single highest-priority fix.

## Rules

- Losses are **understood, never deleted or hidden**. A sunk loss stays on the
  book; the review explains it and prevents the repeat.
- Every recommendation must be **one concrete, testable change** ("add a −55%
  stop", "cap sector exposure at 30%"), not a platitude.
- Distinguish a **signal leak** (entry prices identical for winners/losers) from
  a **sizing leak** (losers entered richer) — they need different fixes.

## Cadence

Run at end of each trading day (or on demand from the Council → End-of-Day
Review tab). The fixes feed KRONOS's nightly rule-rewrite.
