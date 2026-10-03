#!/bin/bash
# Pre-reset reconcile — run 16:50 ET Mon–Fri, BEFORE CrossTrade's ~17:00 ET
# session reset wipes the orders list. Matching the day's fills while orders
# are still alive uses the order-level path (best quality); the 17:45 nightly
# pass keeps its fill-level fallback as the backstop. Idempotent + the
# anti-clobber guard makes re-runs safe.
#
# From now on CrossTrade is the execution source of truth (no manual trading
# expected); occasional manual fills still land in the journal's manual
# bucket / balance ledger residual, never silently dropped.
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

echo "=== pre-reset reconcile $(date '+%F %T %Z') ==="
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/reconcileTrades.ts
RC1=$?
"$NODE_BIN" --import ../scripts/ts-loader.mjs ./scripts/tradeAnalysis.ts
RC2=$?
echo "=== pre-reset reconcile done (reconcile=$RC1 analysis=$RC2) ==="
exit $((RC1 || RC2))
