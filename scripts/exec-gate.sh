#!/usr/bin/env bash
# Shared live-execution change gate (used by the pre-push hook and CI).
# Usage: exec-gate.sh <base-sha> <head-sha>
# Fails (exit 1) when the range touches protected live-execution files
# and no commit in the range carries a [backtested: ...] tag.
# Prints the protected files for the caller.
set -u
cd "$(git rev-parse --show-toplevel)" 2>/dev/null || exit 1

PROTECTED=(
  web/lib/crossTrade.ts
  web/lib/executor.ts
  web/lib/execWatch.ts
  web/lib/execLog.ts
  web/lib/crossGuard.ts
  web/lib/accountGuard.ts
  web/lib/propRules.ts
  web/lib/propAccount.ts
  web/lib/profile.ts
  web/lib/timeExit.ts
  web/lib/runner.ts
  web/lib/runnerTracker.ts
  web/lib/newsGate.ts
  web/lib/openDrive.ts
  web/lib/momentum.ts
  web/lib/softMomentum.ts
  web/lib/signalFeed.ts
  web/lib/unusualVolume.ts
)

base="$1"
head="$2"
z40=0000000000000000000000000000000000000000
if [ "$base" = "$z40" ]; then
  # new branch: diff against its merge base with origin/main (or the parent)
  base=$(git merge-base origin/main "$head" 2>/dev/null || echo "$head~1")
fi

files=$(git diff --name-only "$base" "$head" 2>/dev/null)
if [ -z "$files" ]; then
  exit 0
fi

touched=""
for p in "${PROTECTED[@]}"; do
  if printf '%s\n' "$files" | grep -qxF "$p"; then
    touched="$touched $p"
  fi
done

if [ -z "$touched" ]; then
  exit 0
fi

echo "protected files changed:$touched"
msgs=$(git log "$base..$head" --format=%B 2>/dev/null)
if printf '%s' "$msgs" | grep -q '\[backtested:'; then
  echo "gate: [backtested:] evidence present"
  exit 0
fi

echo "gate: FAIL — no [backtested: ...] tag in the pushed commits" >&2
echo "      cite the study (web/EXEC_CHANGE_POLICY.md §2): e.g. [backtested: scripts/rthOptimizer.ts --offline]" >&2
exit 1
