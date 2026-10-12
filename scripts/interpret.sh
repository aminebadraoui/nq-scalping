#!/bin/bash
# Macro interpretation — one regeneration slot (cron, see jobs_entry.sh).
#
# Generates the DeepSeek per-metric / per-family / combined interpretation
# over the macro context (the same sources the Macro tab's panels show)
# and stores one macro_interpretations row the tab reads. Read-only
# against Neon apart from that one row; never touches gcdata JSON or R2,
# so it cannot conflict with the single-writer nightly pipeline. Any
# time of day is a valid snapshot — vintages are stated in the caveats.
set -uo pipefail

ROOT="${SCALPING_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
NODE_BIN="${NODE_BIN:-/opt/homebrew/bin/node}"

cd "$ROOT/web" || exit 1
if [ -z "${DATABASE_URL:-}" ] && [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

echo "=== interpret $(date '+%F %T %Z') ==="
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/macroInterpret.ts
RC=$?
echo "=== interpret done (rc=$RC) ==="
exit $RC
