#!/usr/bin/env bash
# hermes-gateway-watchdog
# Detects the gateway crash-loop / dual-gateway lock conflict and auto-heals it.
# Symptoms it catches:
#   - systemd hermes-agent crash-looping ("Scheduled restart" / "already running")
#   - gateway.pid pointing at a dead PID (stale lock)
# Heal = stop service, clear the lock via hermes' own CLI, drop a stale pidfile,
#        reset the failed counter, start the single supervised gateway again.
# Runs from a systemd timer every 2 minutes. Idempotent; only acts on a real fault.

set -uo pipefail

LOG=/root/.hermes/logs/gateway-watchdog.log
PIDFILE=/root/.hermes/gateway.pid
mkdir -p "$(dirname "$LOG")"

ts()  { date "+%Y-%m-%d %H:%M:%S"; }
log() { echo "$(ts) $*" >> "$LOG"; }

pidfile_pid() {
  [ -f "$PIDFILE" ] || return 1
  grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$PIDFILE" | grep -oE '[0-9]+' | head -1
}

heal() {
  log "HEAL start: reason=$*"
  systemctl stop hermes-agent 2>/dev/null
  timeout 40 hermes gateway stop >/dev/null 2>&1
  local p; p="$(pidfile_pid || true)"
  if [ -n "${p:-}" ] && ! kill -0 "$p" 2>/dev/null; then
    rm -f "$PIDFILE"; log "removed stale pidfile (pid $p was dead)"
  fi
  systemctl reset-failed hermes-agent 2>/dev/null
  systemctl start hermes-agent 2>/dev/null
  sleep 6
  log "HEAL done: active=$(systemctl is-active hermes-agent) gateways=$(pgrep -fc 'hermes gateway run')"
}

# --- Detection -------------------------------------------------------------
loops=$(journalctl -u hermes-agent --since "3 minutes ago" 2>/dev/null | grep -c "Scheduled restart job" || true)
already=$(journalctl -u hermes-agent --since "3 minutes ago" 2>/dev/null | grep -c "already running" || true)

pid_dead=0
p="$(pidfile_pid || true)"
if [ -n "${p:-}" ] && ! kill -0 "$p" 2>/dev/null; then pid_dead=1; fi

if [ "${loops:-0}" -ge 3 ] || [ "${already:-0}" -ge 2 ]; then
  heal "crash-loop loops=$loops already_running=$already"
elif [ "$pid_dead" -eq 1 ]; then
  heal "stale-pidfile pid=$p dead but service thinks it owns the lock"
fi
# Healthy path: do nothing (keeps the log quiet so HEAL lines stand out).
