#!/bin/bash
# Build AXIOM 2.0 — the stocks / ETF / options edition — from this desk.
#
#   ./scripts/make_axiom2.sh [destination]      (default ~/Downloads/AXIOM-2.0)
#
# Takes the committed code (git HEAD — nothing uncommitted, no .env, no logs,
# no data), removes Polymarket, the crypto and weather bots and all paper
# trading, keeps the stock / ETF / options pages, the SIP planner and advisor,
# the AXIOM brain and the Council, renames the services com.axiom2.*, and
# writes a folder plus a .zip beside it.
set -eu
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$HOME/Downloads/AXIOM-2.0}"
rm -rf "$DEST" "$DEST.zip"; mkdir -p "$DEST"
git -C "$SRC" archive HEAD | tar -x -C "$DEST"
cd "$DEST"

# ── remove Polymarket, crypto, weather and paper trading ──
rm -rf .claude .mcp.json CLAUDE.md pytest.ini .github docs/axiom_stack.html main.py ws_bridge.py crypto_sim.py paper_sim.py docker-compose.yml Dockerfile \
       BUG_FIX_REPORT.md HANDOFF.md HANDOVER.md SESSION_LOG.md RESEARCH_*.md DISCLAIMER.md \
       ingest match execute execution paper persist portfolio risk compound consensus monitor monitoring workers \
       migrations tests testing backtest dryrun brody_repo kronos_repo rdagent_repo vibe_trading_repo graft skills skills-lock.json \
       scripts/weather_alerts.py scripts/clob_balance.py scripts/make_axiom2.sh docs/RUNNING.md
for p in weather crypto arbitrage live tape oracle terminal venues live-account bots journal lab workforce connectome; do rm -rf "frontend/app/$p"; done

# ── services: the advisory desk only ──
KEEP="frontend jarvis jarvis.freshness stt mirofish data.openbb newsdesk.poll advisor cleanup dryrun.caffeinate"
for t in deploy/launchd/*.plist.in; do
  name=$(basename "$t" .plist.in); name=${name#com.polymarket.}
  case " $KEEP " in *" $name "*) ;; *) rm -f "$t" ;; esac
done
mv deploy/launchd/com.polymarket.dryrun.caffeinate.plist.in deploy/launchd/com.polymarket.keepawake.plist.in
sed -i '' 's/com\.polymarket\.dryrun\.caffeinate/com.polymarket.keepawake/' deploy/launchd/com.polymarket.keepawake.plist.in
for t in deploy/launchd/com.polymarket.*.plist.in; do mv "$t" "${t/com.polymarket./com.axiom2.}"; done
grep -rl 'com\.polymarket' --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh' --include='*.py' --include='*.in' . 2>/dev/null \
  | xargs sed -i '' 's/com\.polymarket\./com.axiom2./g; s/com\.polymarket/com.axiom2/g'

# ── edition switches ──
printf 'NEXT_PUBLIC_EDITION=stocks\n' > frontend/.env.production
cp "$SRC/deploy/axiom2/env.example" .env.example
cp "$SRC/deploy/axiom2/requirements.txt" requirements.txt
cp "$SRC/deploy/axiom2/requirements.txt" requirements-core.txt
cp "$SRC/deploy/axiom2/README.md" README.md
cp "$SRC/deploy/axiom2/HANDOFF.md" HANDOFF.md
rm -rf deploy/axiom2

# ── package ──
cd "$(dirname "$DEST")"
zip -qr "$(basename "$DEST").zip" "$(basename "$DEST")" -x '*/node_modules/*' '*/.next/*' '*/.venv/*' '*/__pycache__/*'
echo "AXIOM 2.0 → $DEST  ($(du -sh "$DEST" | cut -f1))"
echo "zip       → $DEST.zip  ($(du -sh "$DEST.zip" | cut -f1))"
