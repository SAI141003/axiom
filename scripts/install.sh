#!/bin/bash
# AXIOM — one-command install on a Mac.
#
#   git clone https://github.com/SAI141003/axiom.git && cd axiom
#   ./scripts/install.sh
#
# Installs the Python and Node dependencies, builds the dashboard, and registers
# every service with launchd so the whole desk starts by itself at every login
# and restarts if anything crashes. Safe to run again: it updates in place.
#
#   --skip-build   reuse the existing dashboard build
#   --core-only    skip the heavy ML packages (torch etc.); the Kronos bot won't run
#   --no-services  install and build only, register nothing (for testing)
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
SKIP_BUILD=0; CORE_ONLY=0; NO_SERVICES=0
for a in "$@"; do case "$a" in --skip-build) SKIP_BUILD=1 ;; --core-only) CORE_ONLY=1 ;; --no-services) NO_SERVICES=1 ;; esac; done

say()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$1"; }
ok()   { printf "  \033[32m✓\033[0m %s\n" "$1"; }
warn() { printf "  \033[33m!\033[0m %s\n" "$1"; }
die()  { printf "  \033[31m✗ %s\033[0m\n" "$1"; exit 1; }

say "Checking this Mac"
[ "$(uname)" = "Darwin" ] || die "AXIOM's services use macOS launchd. On Linux, run the commands in docs/RUNNING.md by hand."
PY=$(command -v python3) || die "python3 not found — install Python 3.11+ (brew install python)"
"$PY" -c 'import sys; sys.exit(sys.version_info < (3, 11))' || die "Python 3.11+ needed, found $("$PY" --version)"
ok "$("$PY" --version)"
NODE=$(command -v node) || die "node not found — install Node 18+ (brew install node)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ] || die "Node 18+ needed, found $(node --version)"
NPX=$(command -v npx); NODEBIN=$(dirname "$NODE")
ok "node $(node --version)"
has() { ls deploy/launchd/*."$1".plist.in >/dev/null 2>&1; }   # is this service part of this edition?
REDIS=""
if has redis; then
REDIS=$(command -v redis-server || true)
[ -z "$REDIS" ] && for p in /opt/homebrew/opt/redis/bin/redis-server /usr/local/bin/redis-server; do [ -x "$p" ] && REDIS=$p; done
if [ -n "$REDIS" ]; then ok "redis $("$REDIS" --version | awk '{print $3}')"; else warn "redis-server not found — run: brew install redis   (the bridge and live bot need it; everything else runs without)"; fi
fi
PGBIN=""; PGDATA=""
PGB=""; has postgres && PGB=$(command -v postgres || ls -d /opt/homebrew/opt/postgresql@*/bin/postgres /usr/local/opt/postgresql@*/bin/postgres 2>/dev/null | tail -1)
if [ -n "$PGB" ]; then
  PGBIN=$(dirname "$PGB")
  PGDATA=$(ls -d /opt/homebrew/var/postgresql@* /usr/local/var/postgresql@* 2>/dev/null | tail -1)
  [ -z "$PGDATA" ] && PGDATA="$ROOT/.pgdata"
  ok "postgres $("$PGBIN/postgres" --version | awk '{print $3}') · data $PGDATA"
elif has postgres; then
  warn "postgres not found — run: brew install postgresql@16   (only the original Polymarket engine, service 'bot', needs it)"
fi
if has stt; then
  command -v ffmpeg >/dev/null || ls /opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg >/dev/null 2>&1 && ok "ffmpeg" || warn "ffmpeg not found — run: brew install ffmpeg   (for the \"hey Axiom\" voice; the browser's own speech works without it)"
fi

say "Keys"
if [ ! -f .env ]; then cp .env.example .env; warn "created .env from .env.example — add your keys there, or on the Settings page once it is running"; else ok ".env present (left untouched)"; fi
mkdir -p logs .data

if [ -n "$PGBIN" ]; then
  say "Database"
  if [ ! -f "$PGDATA/PG_VERSION" ]; then "$PGBIN/initdb" -D "$PGDATA" -U "$(whoami)" >/dev/null && ok "created a database cluster in $PGDATA"; fi
  pgrep -x postgres >/dev/null || { rm -f "$PGDATA/postmaster.pid"; "$PGBIN/pg_ctl" -D "$PGDATA" -l logs/postgres.log start >/dev/null; sleep 3; }
  # role and database from DATABASE_URL in .env (postgresql://user:pass@host:port/db)
  URL=$(grep '^DATABASE_URL=' .env | cut -d= -f2-)
  if [[ "$URL" =~ ^postgres(ql)?://([^:]+):([^@]+)@[^/]+/([^?]+) ]]; then
    PU=${BASH_REMATCH[2]}; PP=${BASH_REMATCH[3]}; PD=${BASH_REMATCH[4]}
    "$PGBIN/psql" -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='$PU'" | grep -q 1 || "$PGBIN/psql" -d postgres -qc "CREATE ROLE \"$PU\" LOGIN PASSWORD '$PP'"
    "$PGBIN/psql" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$PD'" | grep -q 1 || "$PGBIN/psql" -d postgres -qc "CREATE DATABASE \"$PD\" OWNER \"$PU\""
    ok "database $PD ready for $PU"
  else
    warn "DATABASE_URL in .env is not set — the 'bot' service will not start until it is"
  fi
  "$PGBIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1   # launchd takes it over below
fi

say "Python packages"
[ -d .venv ] || "$PY" -m venv .venv
./.venv/bin/pip install -q --upgrade pip
./.venv/bin/pip install -q -r requirements-core.txt || die "core packages failed"
ok "core packages"
if [ "$CORE_ONLY" = 0 ]; then
  if ./.venv/bin/pip install -q -r requirements.txt; then ok "all packages"; else warn "some full packages failed — the core desk runs; the Kronos bot may not"; fi
fi

if has stt && [ ! -f .data/whisper/ggml-base.en.bin ]; then
  say "Speech model for the voice (142 MB, once)"
  mkdir -p .data/whisper
  curl -fsSL -o .data/whisper/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
    && ok "whisper base.en" || warn "download failed — the voice falls back to the browser's speech recognition"
fi

say "Node packages"
(cd frontend && npm ci --no-audit --no-fund --loglevel=error) || die "dashboard packages failed"
(cd jarvis && npm ci --no-audit --no-fund --loglevel=error) || warn "AXIOM voice bridge packages failed — the dashboard still runs"
ok "dashboard + voice bridge"

if [ "$SKIP_BUILD" = 0 ]; then
  say "Building the dashboard (1–2 minutes)"
  (cd frontend && npm run build >/dev/null 2>&1) || die "build failed — run 'cd frontend && npm run build' to see why"
  ok "built"
fi

if [ "$NO_SERVICES" = 1 ]; then printf "\nInstalled and built (services not registered: --no-services).\n"; exit 0; fi

say "Registering services (start at login, restart on crash)"
AGENTS="$HOME/Library/LaunchAgents"; mkdir -p "$AGENTS"
U=$(id -u); n=0
for t in deploy/launchd/*.plist.in; do
  label=$(basename "$t" .plist.in)
  if [ "$label" = "com.polymarket.redis" ] && [ -z "$REDIS" ]; then warn "skipped $label (no redis-server)"; continue; fi
  if [ "$label" = "com.polymarket.postgres" ] || [ "$label" = "com.polymarket.bot" ]; then [ -z "$PGBIN" ] && { warn "skipped $label (no postgres)"; continue; }; fi
  out="$AGENTS/$label.plist"
  sed -e "s#__ROOT__#$ROOT#g" -e "s#__HOME__#$HOME#g" -e "s#__NODEBIN__#$NODEBIN#g" \
      -e "s#__NODE__#$NODE#g" -e "s#__NPX__#$NPX#g" -e "s#__REDIS__#${REDIS:-redis-server}#g" \
      -e "s#__PGBIN__#$PGBIN#g" -e "s#__PGDATA__#$PGDATA#g" "$t" > "$out"
  launchctl bootout "gui/$U/$label" 2>/dev/null
  launchctl enable "gui/$U/$label" 2>/dev/null
  launchctl bootstrap "gui/$U" "$out" 2>/dev/null || warn "could not load $label"
  n=$((n + 1))
done
ok "$n services registered"

say "Waiting for the dashboard"
for i in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' localhost:3300/)" = 200 ] && break; sleep 2; done
if [ "$(curl -s -o /dev/null -w '%{http_code}' localhost:3300/)" = 200 ]; then ok "AXIOM is up: http://localhost:3300"; else warn "dashboard not answering yet — check: ./scripts/axiom.sh logs frontend"; fi
./scripts/axiom.sh status
printf "\nDone. Everything starts by itself at login. Control it with ./scripts/axiom.sh (status | stop | start | restart <name> | logs <name>).\n"
