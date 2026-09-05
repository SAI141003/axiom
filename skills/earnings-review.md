---
name: earnings-review
agent: Quill (Earnings Analyst)
description: Forecast a company's EPS beat probability and post-earnings reaction from cited market microstructure and fundamentals.
data_connectors: [yahoo-quotesummary, fmp (optional)]
implemented_by: signals/earnings_engine.py
---

# Earnings Review

Mirrors Anthropic's "Earnings Reviewer" finance template. Produces a calibrated,
decomposed forecast — never an overconfident single number.

## Method (each signal is a cited effect, not a vibe)

1. **P(beat consensus)** — Beta-Binomial shrink of the firm's beat streak toward
   the 75% market base rate (FactSet), tilted by analyst estimate-revision
   momentum. *Chan, Jegadeesh & Lakonishok (1996).*
2. **Expected surprise** — persistence of standardized surprises (they
   autocorrelate → drift). *Bernard & Thomas (1989, 1990), PEAD / SUE.*
3. **Dispersion** — high analyst disagreement predicts lower forward returns
   under short-sale constraints. *Diether, Malloy & Scherbina (2002).*
4. **Options-implied move** — ATM straddle / spot = the market's own expected
   magnitude.
5. **Priced-in penalty** — a beat everyone expects pops less.
6. **Fundamentals (optional, FMP connector)** — sector, margins, ROE, DCF fair
   value for context.

## Rules

- P(up after) is **hard-capped 0.30–0.72**: the post-earnings reaction is
  near-efficient. Never claim more — the benchmark confirms it ≈ coin-flip.
- Every forecast is **logged and Brier-scored** the next day
  (`earnings_resolver.py`). Trust is earned, not asserted.
- If `n_analysts < 10` or `< 4` quarters of history: flag `thin-data`.

## Verification

`signals/earnings_benchmark.py` — walk-forward on real historical quarters,
scored vs coin-flip and always-beat baselines with Brier + ECE.
