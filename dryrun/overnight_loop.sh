#!/bin/bash
# Overnight robustness loop: MC backtest + learner, hourly, on the growing dataset.
cd /Users/saiyaganti/polymarket-hft
OUT="logs/reports/overnight_$(date +%Y%m%d_%H%M).txt"
{
  echo "════ OVERNIGHT ROBUSTNESS PASS $(date '+%Y-%m-%d %H:%M %Z') ════"
  echo "── Monte Carlo (10,000 iterations) ──"
  ./.venv/bin/python dryrun/montecarlo_backtest.py 10000 2>&1
  echo
  echo "── Self-learner refit (stability-tested params) ──"
  ./.venv/bin/python dryrun/learner.py 2>&1
  echo
  echo "── Brain reflection pass (attribution → lessons → bounded actions) ──"
  ./.venv/bin/python dryrun/brain.py 2>&1
  echo
  echo "── Meta-label trainer (oracle-lag P(win|features)) ──"
  ./.venv/bin/python dryrun/metalabel.py 2>&1
  echo
  echo "── RD-Agent factor R&D loop (LLM proposes → purged-CV validates → keep survivors) ──"
  ./.venv/bin/python dryrun/rd_agent.py 2 2>&1 | grep -viE "warning|pydantic"
  echo
  echo "── Semantic memory reindex (new lessons become recallable) ──"
  ./.venv/bin/python signals/semantic_memory.py reindex 2>&1 | grep -v "Loading"
  echo
  echo "── Oracle self-scoring (Brier on its own forecasts) ──"
  ./.venv/bin/python signals/oracle_resolver.py 2>&1
  ./.venv/bin/python signals/council_resolver.py 2>&1
  echo "── Earnings engine self-scoring (beat + direction Brier) ──"
  ./.venv/bin/python signals/earnings_resolver.py 2>&1
  echo "── Shadow-live: does the edge survive real fills? ──"
  ./.venv/bin/python dryrun/shadow_report.py 2>&1
  echo "── Company Scenario self-scoring (Brier vs reality) ──"
  ./.venv/bin/python signals/scenario_resolver.py 2>&1
  echo "── Auto-tuner: council self-fixes strategy knobs on real data ──"
  ./.venv/bin/python dryrun/auto_tuner.py 2>&1
  echo "── Model benchmark: our direction vs real financial models ──"
  ./.venv/bin/python signals/market_model_benchmark.py 2>&1 | tail -8
  echo "── Vol benchmark: realized MC vs GARCH/EWMA (model auto-adopts winner) ──"
  ./.venv/bin/python signals/vol_model_benchmark.py 2>&1 | tail -6
  ./.venv/bin/python signals/industry_comparison.py 2>&1 | tail -3
  echo
  echo "── Maker-entry simulator (resting bids vs taker, probe data) ──"
  ./.venv/bin/python dryrun/maker_sim.py 2>&1
  echo
  echo "── Alpha factors (Vibe-Trading zoo, watchlist cross-section) ──"
  ./.venv/bin/python signals/alpha_factors.py 2>&1
  echo
  echo "── Gamma levels (dealer walls, zero-gamma regime) ──"
  ./.venv/bin/python signals/gamma_levels.py 2>&1
  echo
  echo "── data volume this pass ──"
  for f in dryrun_5m dryrun_weather dryrun_kronos1h dryrun_premarket dryrun_options; do
    echo "  $f: $(wc -l < logs/$f.jsonl 2>/dev/null || echo 0) records"
  done
} > "$OUT" 2>&1
# keep a rolling 'latest' pointer
cp "$OUT" logs/reports/overnight_latest.txt
