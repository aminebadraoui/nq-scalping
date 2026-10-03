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
# Runs on the VPS jobs container (Coolify app `nq-jobs`, cron 17:45 ET Mon–Fri)
# and on the Mac (launchd com.scalping.collect) — never both in the same window:
# the R2 manifest is single-writer. Portable: SCALPING_ROOT, NODE_BIN and PYTHON_BIN
# override the auto-detected paths; date math goes through python3 (GNU/BSD-safe).
set -uo pipefail

ROOT="${SCALPING_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
PY="${PYTHON_BIN:-}"
if [ -z "$PY" ]; then
  if [ -x "$ROOT/gcdata/.venv/bin/python" ]; then PY="$ROOT/gcdata/.venv/bin/python"; else PY="$(command -v python3)"; fi
fi
days_ago() { "$PY" -c 'import datetime,sys;print((datetime.date.today()-datetime.timedelta(days=int(sys.argv[1]))).isoformat())' "$1"; }
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
if [ "${NIGHTLY_FORCE:-0}" != "1" ] && { [ "$NY_MIN" -ge 1080 ] || [ "$NY_MIN" -lt 1020 ]; }; then
  log "session still open (NY $NY_HHMM) — nothing to collect yet, skipping (NIGHTLY_FORCE=1 overrides)"
  exit 0
fi

FROM=$(days_ago "$DAYS")
TO=$(date '+%Y-%m-%d')
log "=== nightly collection start (window $FROM .. $TO) ==="

cd "$ROOT/gcdata" || exit 1

log "--- footprint backfill (ETH + RTH) ---"
"$PY" backfill.py --from "$FROM" --to "$TO" --sessions ETH RTH 2>&1
BACKFILL_RC=$?
log "backfill exit=$BACKFILL_RC"

log "--- OHLC bars (real open/close for the candles) ---"
"$PY" collect_ohlc.py --windows 4 2>&1
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
# Neon Free caps storage at 512 MB; the 2.5-year history stays in
# gcdata/data JSON (the lab/study read those files directly). Ingest a rolling
# ~3-week window so the dashboard's 5-day profile composite stays intact
# without hitting the storage cap.
SINCE=$(days_ago 21)
log "ingest window: $SINCE .. $TO"
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./db/ingest.ts --since "$SINCE" --profiles --events 2>&1
INGEST_RC=$?
log "ingest exit=$INGEST_RC"

log "--- reconcile trades (CrossTrade fills ↔ signals) ---"
# Joins the day's Telegram cards with the CrossTrade fill record into the
# Neon `trades` + `reconcile_runs` tables ("did that card trade, and how?").
# Idempotent (upsert on signal_key) — re-run any time to backfill a gap.
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/reconcileTrades.ts 2>&1
RECONCILE_RC=$?
log "reconcile exit=$RECONCILE_RC"

log "--- analyze trades (win/loss framework) ---"
# Per-trade execution anatomy (drift, MFE/MAE, stop-runs) + win/loss
# aggregates by strategy/hour/side → `trade_analysis` + enriched `trades`.
# Runs after ingest so the bars are vendor-grade. Idempotent.
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/tradeAnalysis.ts 2>&1
ANALYSIS_RC=$?
log "tradeAnalysis exit=$ANALYSIS_RC"

log "--- mine strategy insights (self-improvement) ---"
# Pattern-mines the trade record into `insights` (proposals + AI review).
# With SELF_IMPROVE=1 strong proposals auto-apply into `strategy_overrides`;
# otherwise the dashboard approves. Idempotent (dedup by title).
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/strategyInsights.ts 2>&1
INSIGHTS_RC=$?
log "strategyInsights exit=$INSIGHTS_RC"

log "--- archive to R2 + free the disk ---"
if [ -n "${R2_ACCOUNT_ID:-}" ] || grep -q '^R2_ACCOUNT_ID=' "$ROOT/gcdata/.env" 2>/dev/null; then
  if python3 "$ROOT/scripts/r2_sync.py" upload 2>&1; then
    log "r2 upload ok"
    python3 "$ROOT/scripts/r2_sync.py" prune 2>&1
    log "r2 prune exit=$?"
  else
    log "r2 upload FAILED — keeping local files until the next run"
  fi
else
  log "no R2 credentials — keeping local files"
fi

log "--- ES cross-asset archive (data/es, separate manifest-es.json) ---"
if pgrep -f "python.*backfill_es\.py" >/dev/null 2>&1; then
  log "long ES backfill already running — skipping tonight's ES pass (it covers this window)"
else
  cd "$ROOT/gcdata" || exit 1
  "$PY" backfill_es.py --from "$FROM" --to "$TO" 2>&1
  ES_BF_RC=$?
  log "es backfill exit=$ES_BF_RC"
  if [ -n "${R2_ACCOUNT_ID:-}" ] || grep -q '^R2_ACCOUNT_ID=' "$ROOT/gcdata/.env" 2>/dev/null; then
    if python3 "$ROOT/scripts/es_r2_sync.py" upload 2>&1; then
      log "es r2 upload ok"
      python3 "$ROOT/scripts/es_r2_sync.py" prune 2>&1
      log "es r2 prune exit=$?"
    else
      log "es r2 upload FAILED — keeping local es files until the next run"
    fi
  else
    log "no R2 credentials — keeping local es files"
  fi
  cd "$ROOT/web" || exit 1
fi

log "--- weekly risk-stack backtest (Fridays only) ---"
# Integrated full-stack sim (all families + protections through the MFF
# account rules). Weekly cadence: it re-validates the protection math as
# the archive grows; ~1 min on the warm cache.
RISKSTACK_RC=0
if [ "$(date +%u)" = "5" ]; then
  "$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/riskStackStudy.ts --offline 2>&1 | tail -14
  RISKSTACK_RC=${PIPESTATUS[0]}
  log "riskStack exit=$RISKSTACK_RC"
else
  log "not Friday — skipping the weekly risk-stack backtest"
fi

FINAL_RC=$INGEST_RC
if [ "$RECONCILE_RC" -ne 0 ]; then FINAL_RC=$RECONCILE_RC; fi
if [ "$ANALYSIS_RC" -ne 0 ]; then FINAL_RC=$ANALYSIS_RC; fi
if [ "$INSIGHTS_RC" -ne 0 ]; then FINAL_RC=$INSIGHTS_RC; fi
if [ "$RISKSTACK_RC" -ne 0 ]; then FINAL_RC=$RISKSTACK_RC; fi
log "=== nightly collection done (backfill=$BACKFILL_RC ohlc=$OHLC_RC ingest=$INGEST_RC reconcile=$RECONCILE_RC analysis=$ANALYSIS_RC insights=$INSIGHTS_RC riskstack=$RISKSTACK_RC) ==="
exit $FINAL_RC
