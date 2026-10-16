#!/usr/bin/env bash
# nq-watchdog — external healer for the nq-dashboard container.
#
# Cron (root, every minute):
#   * * * * * /root/scripts/nq-watchdog.sh >> /dev/null 2>&1
#
# Watches https://nq-dashboard.31.97.138.30.sslip.io/api/healthz
# (tests Traefik + the container end-to-end). After 2 consecutive
# failures it restarts the dashboard container and pages Telegram via
# the bot token read from the container env (no secrets stored twice).
# Guards: a 4-min boot grace (never restarts a fresh/deploying
# container) and a 10-min restart cooldown (no restart loops).
#
# 2026-10-16: the morning outage ran 19 minutes with nobody watching —
# this healer would have cut it to ~2 (and the 09:35 open-drive card
# would have survived).

set -u

URL="${NQ_WATCH_URL:-https://nq-dashboard.31.97.138.30.sslip.io/api/healthz}"
STATE_FILE="/root/.nq-watchdog-state"
LOG="/var/log/nq-watchdog.log"
BOOT_GRACE_S=240
COOLDOWN_S=600

log() { echo "$(date -u '+%F %T') $*" >> "$LOG"; }

C=$(docker ps --format '{{.Names}}' | grep '^vwtq' | head -1)
if [ -z "$C" ]; then
  log "no dashboard container found — nothing to watch"
  exit 0
fi

# boot grace: a fresh container (deploy/boot) is not a failure to fix
STARTED=$(docker inspect --format '{{.State.StartedAt}}' "$C" 2>/dev/null)
if [ -n "$STARTED" ]; then
  AGE=$(( $(date +%s) - $(date -u -d "$STARTED" +%s 2>/dev/null || echo 0) ))
  if [ "$AGE" -lt "$BOOT_GRACE_S" ]; then
    echo "0 $(cut -d' ' -f2 "$STATE_FILE" 2>/dev/null || echo 0)" > "$STATE_FILE"
    exit 0
  fi
fi

HTTP=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || echo 000)

read -r FAILS LAST_RESTART < "$STATE_FILE" 2>/dev/null || true
FAILS=${FAILS:-0}
LAST_RESTART=${LAST_RESTART:-0}
NOW=$(date +%s)

if [ "$HTTP" = "200" ]; then
  if [ "$FAILS" -gt 0 ]; then
    log "recovered (healthz 200) after $FAILS failure(s)"
  fi
  echo "0 $LAST_RESTART" > "$STATE_FILE"
  exit 0
fi

FAILS=$((FAILS + 1))
echo "$FAILS $LAST_RESTART" > "$STATE_FILE"
log "healthz failed (HTTP $HTTP) — failure $FAILS/2"

if [ "$FAILS" -ge 2 ]; then
  if [ "$LAST_RESTART" -gt 0 ] && [ $((NOW - LAST_RESTART)) -lt "$COOLDOWN_S" ]; then
    log "restart skipped — cooldown (last restart $(( (NOW - LAST_RESTART) / 60 ))m ago)"
    exit 0
  fi
  log "RESTARTING $C (healthz HTTP $HTTP)"
  if ! docker restart "$C" > /dev/null 2>&1; then
    log "docker restart failed — manual intervention needed"
    exit 1
  fi
  echo "0 $NOW" > "$STATE_FILE"

  TOKEN=$(docker exec "$C" printenv TELEGRAM_BOT_TOKEN 2>/dev/null | tr -d '\r')
  CHAT=$(docker exec "$C" printenv TELEGRAM_CHAT_ID 2>/dev/null | tr -d '\r')
  if [ -n "$TOKEN" ] && [ -n "$CHAT" ]; then
    curl -sS -m 10 -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
      -H 'Content-Type: application/json' \
      -d "{\"chat_id\":\"${CHAT}\",\"text\":\"🔄 <b>WATCHDOG RESTART</b> — the dashboard was unhealthy (healthz HTTP ${HTTP}) and the container was restarted.\\n<i>external healer — verify /api/gc?action=health after boot</i>\"}" \
      > /dev/null 2>&1 && log "telegram alert sent"
  else
    log "telegram creds unreadable — no alert sent"
  fi
fi

exit 0
