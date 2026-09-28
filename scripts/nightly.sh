#!/bin/bash
# Nightly collection + ingestion for the NQ dashboard.
#
# Order matters: collect first, then ingest, so Neon receives the session that
# just closed rather than yesterday's snapshot. Both steps are idempotent, so a
# failed run is safe to repeat and a partial day is repaired on the next pass
# (backfill.py re-fetches any session whose stored completeness is not "complete").
#
# Usage: nightly.sh [days-back]        (default 6)
#
# Scheduled by docs/launchd/com.scalping.collect.plist, which runs it at 17:15
# New York (14:15 Pacific) Monday-Friday — just after the 16:59 NY session close.
set -uo pipefail

ROOT="/Users/amean/PROJECTS/DEV/Scalping"
DAYS="${1:-6}"
LOG_DIR="$ROOT/gcdata/data"
mkdir -p "$LOG_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }

# Guard: the ETH session is open from 18:00 NY until 16:59 NY the next day.
# Collecting while it is open would write a partial file that the next run has
# to repair anyway, so refuse to run inside that window (checked in minutes past
# midnight with base-10 coercion so 0805 is not read as invalid octal).
NY_HHMM=$(TZ=America/New_York date '+%H%M')
NY_MIN=$(( (10#$NY_HHMM / 100) * 60 + (10#$NY_HHMM % 100) ))
if [ "$NY_MIN" -ge 1080 ] || [ "$NY_MIN" -lt 1020 ]; then
  log "session still open (NY $NY_HHMM) — nothing to collect yet, skipping"
  exit 0
fi

FROM=$(date -v-"${DAYS}"d '+%Y-%m-%d')
TO=$(date '+%Y-%m-%d')
log "=== nightly collection start (window $FROM .. $TO) ==="

cd "$ROOT/gcdata" || exit 1
if [ ! -x ./.venv/bin/python ]; then
  log "ERROR: python venv missing at gcdata/.venv — run: python3 -m venv .venv && .venv/bin/pip install websocket-client protobuf"
  exit 1
fi

log "--- footprint backfill (ETH + RTH) ---"
./.venv/bin/python backfill.py --from "$FROM" --to "$TO" --sessions ETH RTH 2>&1
BACKFILL_RC=$?
log "backfill exit=$BACKFILL_RC"

log "--- OHLC bars (real open/close for the candles) ---"
./.venv/bin/python collect_ohlc.py --windows 4 2>&1
OHLC_RC=$?
log "ohlc exit=$OHLC_RC"

cd "$ROOT/web" || exit 1
if [ -z "${DATABASE_URL:-}" ]; then
  if [ -f .env.local ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env.local
    set +a
  fi
fi
if [ -z "${DATABASE_URL:-}" ]; then
  log "ERROR: DATABASE_URL is not set (launchd env or web/.env.local) — skipping ingest"
  exit 1
fi

log "--- ingest into Neon ---"
/opt/homebrew/bin/node --import ../scripts/ts-loader.mjs ./db/ingest.ts --all --profiles --events 2>&1
INGEST_RC=$?
log "ingest exit=$INGEST_RC"

log "=== nightly collection done (backfill=$BACKFILL_RC ohlc=$OHLC_RC ingest=$INGEST_RC) ==="
exit $INGEST_RC
