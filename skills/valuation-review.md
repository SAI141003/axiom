---
name: valuation-review
agent: Ledger (Valuation Reviewer)
description: Assess whether a stock is cheap or expensive from DCF fair value, multiples, quality, and leverage.
data_connectors: [fmp]
implemented_by: frontend/app/api/valuation/route.ts
---

# Valuation Review

Mirrors Anthropic's "Valuation Reviewer" finance template. Triangulates a fair
value from three independent lenses and states a verdict with the reasoning,
never a bare number.

## Method

1. **DCF fair value** — FMP's discounted-cash-flow estimate vs current price →
   upside/downside %. The anchor.
2. **Multiples** — P/E (TTM) vs the sector's typical range; a rich multiple
   needs growth/margins to justify it.
3. **Quality & leverage** — net margin, ROE, debt/equity. High-quality compounders
   deserve a premium; levered low-ROE names do not.
4. **Synthesis** — an LLM analyst (Ledger) weighs the three, names the key risk,
   and gives a verdict: UNDERVALUED / FAIR / OVERVALUED with a one-line thesis.

## Rules

- **Requires the FMP connector** (`FMP_API_KEY`). Without it, the agent reports
  "data unavailable" rather than guessing — no fabricated fundamentals.
- A DCF is a model, not truth: always pair the number with the key assumption it
  rides on (growth, discount rate) and the main risk.
- Never issue a buy/sell instruction — this is analysis, paper-only.

## Data

`signals/fmp_connector.py` → profile, ratios-ttm, discounted-cash-flow (FMP free tier).
