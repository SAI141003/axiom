#!/bin/bash
# AXIOM service control.
#   ./scripts/axiom.sh status            every service: running, scheduled or failing
#   ./scripts/axiom.sh stop | start      all services (start = load again; they also start at login)
#   ./scripts/axiom.sh restart <name>    one service, e.g. frontend, dryrun.weather
#   ./scripts/axiom.sh logs <name>       follow its log
#   ./scripts/axiom.sh uninstall         stop and remove every service (code and data stay)
cd "$(dirname "$0")/.." || exit 1
U=$(id -u); AGENTS="$HOME/Library/LaunchAgents"
labels() { ls "$AGENTS" 2>/dev/null | grep '^com\.polymarket\..*\.plist$' | sed 's/\.plist$//'; }

case "${1:-status}" in
  status)
    printf "%-34s %s\n" SERVICE STATE
    for l in $(labels); do
      line=$(launchctl list | awk -v l="$l" '$3==l')
      pid=$(echo "$line" | awk '{print $1}'); code=$(echo "$line" | awk '{print $2}')
      if launchctl print-disabled "gui/$U" 2>/dev/null | grep -q "\"$l\" => disabled"; then s="off (switched off)"
      elif [ -z "$line" ]; then s="not loaded"
      elif [ "$pid" != "-" ]; then s="running (pid $pid)"
      elif [ "$code" = "0" ]; then s="scheduled (last run ok)"
      else s="FAILING (exit $code) — ./scripts/axiom.sh logs ${l#com.polymarket.}"; fi
      printf "%-34s %s\n" "${l#com.polymarket.}" "$s"
    done
    printf "\ndashboard: http://localhost:3300 → %s\n" "$(curl -s -o /dev/null -w '%{http_code}' localhost:3300/ || echo down)" ;;
  stop)  for l in $(labels); do launchctl bootout "gui/$U/$l" 2>/dev/null; done; echo "stopped (they start again at next login, or: ./scripts/axiom.sh start)" ;;
  start) for l in $(labels); do launchctl bootstrap "gui/$U" "$AGENTS/$l.plist" 2>/dev/null; done; echo "started"; sleep 3; "$0" status ;;
  restart)
    [ -n "${2:-}" ] || { echo "usage: $0 restart <name>   e.g. frontend"; exit 1; }
    launchctl kickstart -k "gui/$U/com.polymarket.$2" && echo "restarted $2" ;;
  logs)
    [ -n "${2:-}" ] || { echo "usage: $0 logs <name>"; exit 1; }
    f=$(grep -A1 StandardOutPath "$AGENTS/com.polymarket.$2.plist" 2>/dev/null | grep -o '<string>[^<]*' | head -1 | sed 's/<string>//')
    [ -n "$f" ] && tail -n 60 -f "$f" || echo "no log configured for $2" ;;
  uninstall)
    for l in $(labels); do launchctl bootout "gui/$U/$l" 2>/dev/null; rm -f "$AGENTS/$l.plist"; done; echo "all AXIOM services removed" ;;
  *) sed -n '2,8p' "$0" ;;
esac
