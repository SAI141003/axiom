#!/bin/bash
# Daily cleanup: caps runaway logs and clears regenerable caches.
# Never touches the trade books (logs/dryrun_*.jsonl) or .data state files
# other than the AI usage log, which only feeds the usage panel.
cd /Users/saiyaganti/polymarket-hft || exit 1
MB=$((1024*1024))

# keep the last $2 MB of a file once it passes $1 MB (first partial line dropped)
cap() {
  local f=$1 max=$2 keep=$3
  [ -f "$f" ] || return
  local size; size=$(stat -f %z "$f")
  if [ "$size" -gt $((max*MB)) ]; then
    tail -c $((keep*MB)) "$f" | tail -n +2 > "$f.tmp" && cat "$f.tmp" > "$f" && rm -f "$f.tmp"
    echo "$(date '+%F %T') capped $f: $((size/MB))MB -> ${keep}MB"
  fi
}

for f in logs/*.log; do cap "$f" 100 20; done      # process logs
cap .data/ai_usage.jsonl 200 50                     # usage panel reads recent days only

# regenerable caches: Next.js fetch/image cache, Python bytecode
rm -rf frontend/.next/cache/fetch-cache frontend/.next/cache/images
find . -name __pycache__ -type d -not -path "./.venv/*" -not -path "*/node_modules/*" -prune -exec rm -rf {} + 2>/dev/null

# old daily reports (keep 14 days)
find logs/reports -type f -mtime +14 -delete 2>/dev/null

echo "$(date '+%F %T') cleanup done · free: $(df -h /System/Volumes/Data | awk 'NR==2{print $4}')"
