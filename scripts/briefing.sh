#!/bin/bash
# AI macro briefing — one regeneration slot (cron, see jobs_entry.sh).
#
#   briefing.sh <kind>   kind ∈ evening-open | pre-open | post-open |
#                        mid-morning | midday | pre-close | post-close
#                        (default pre-open)
#
# Generates the DeepSeek situation analysis over the macro context + the
# current NQ tape (live-written to Neon) and stores one macro_briefings
# row the dashboard card reads. Read-only against Neon apart from that
# one row; never touches gcdata JSON or R2, so it cannot conflict with
# the single-writer nightly pipeline. The CLI self-skips on CME holidays
# and outside its kind's NY window.
set -uo pipefail

KIND="${1:-pre-open}"

ROOT="${SCALPING_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"

cd "$ROOT/web" || exit 1
if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

echo "=== briefing $KIND $(date '+%F %T %Z') ==="
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/macroBriefing.ts "$KIND"
RC=$?
echo "=== briefing $KIND done (rc=$RC) ==="
exit $RC
