#!/bin/bash
# Weekly review — the Saturday-morning self-improvement pass.
#
# Rolls up the trading week that just closed (Mon–Fri) and re-runs the
# promotion-contract studies against the frozen production stack, then
# writes one `weekly_reviews` row + an optional Telegram summary.
#
# Pure research/analysis: reads Neon + the R2 archive, never touches
# live-execution state. Verdicts are recorded dry by default;
# WEEKLY_PROMOTE=1 queues contract-passed proposals for the existing
# dashboard-approve / nightly SELF_IMPROVE=1 path; WEEKLY_PROMOTE=now
# applies them immediately. Only the suppressive override gates are
# promotable (the promotion contract); detector code, risk knobs and
# Coolify env stay on the manual EXEC_CHANGE_POLICY path.
#
# Usage: scripts/weekly.sh            (previous Mon–Fri)
#        WEEKLY_WEEK=2026-10-13 scripts/weekly.sh   (pick the week)
#
# Intended cron (inside the nq-jobs container, TZ=America/New_York):
#   15 9 * * 6  scripts/weekly.sh    — Sat 09:15 ET, after the Fri
#                                       nightly + weekly arms are done
# (see deploy/STATE.md §Operate — Coolify cron change needs approval).
set -uo pipefail

ROOT="${SCALPING_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"
LOG_DIR="$ROOT/gcdata/data"
mkdir -p "$LOG_DIR"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }

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
  log "ERROR: DATABASE_URL is not set (launchd env or web/.env.local) — skipping weekly review"
  exit 1
fi

log "=== weekly review start (week ${WEEKLY_WEEK:-auto}) ==="
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/weeklyReview.ts "$@"
RC=$?
log "=== weekly review done (exit=$RC) ==="
exit $RC
