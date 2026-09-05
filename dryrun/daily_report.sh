#!/bin/bash
# Nightly results archive — one dated file per day until Sunday review
cd /Users/saiyaganti/polymarket-hft
OUT="logs/reports/report_$(date +%Y-%m-%d).txt"
{
  echo "════════ DAILY DRY-RUN REPORT $(date '+%Y-%m-%d %H:%M %Z') ════════"
  .venv/bin/python dryrun/analyze.py 2>&1
  echo
  echo "── SELF-LEARNER (refit from tonight's data) ──"
  .venv/bin/python dryrun/learner.py 2>&1
  echo
  echo "── data volume ──"
  for f in dryrun_5m dryrun_weather dryrun_premarket; do
    echo "$f: $(wc -l < logs/$f.jsonl 2>/dev/null || echo 0) records"
  done
  echo "── services ──"
  launchctl list | grep polymarket
} > "$OUT" 2>&1
