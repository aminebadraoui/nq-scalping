#!/bin/bash
# Backfill every NQ contract's front-month tenure. Each contract comes back
# COMPLETE (contiguous, 17:00 -> 15:59 CT) for roughly its 3-month tenure as the
# front month, and the vendor thins it once expired. Walking the quarterly cycle
# (H/M/U/Z) from Dec-2023 to now recovers ~2.5 years of usable sessions.
#
# Oldest first, so that where two contracts overlap around a roll, the first
# (older, hence the front-month at that date) wins and already-complete files are
# never overwritten by a less-liquid contract.
#
# Run:   scripts/backfill_contracts.sh [--force]
# Log:   gcdata/data/backfill_contracts.log

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/gcdata" || exit 1
PY=".venv/bin/python"
LOG="$ROOT/gcdata/data/backfill_contracts.log"

# symbol  from        to          (front-month tenure; roll = 3rd Friday of H/M/U/Z)
CONTRACTS=(
  "NQH24 2023-12-18 2024-03-15"
  "NQM24 2024-03-18 2024-06-21"
  "NQU24 2024-06-24 2024-09-20"
  "NQZ24 2024-09-23 2024-12-20"
  "NQH25 2024-12-23 2025-03-21"
  "NQM25 2025-03-24 2025-06-20"
  "NQU25 2025-06-23 2025-09-19"
  "NQZ25 2025-09-22 2025-12-19"
  "NQH26 2025-12-22 2026-03-20"
  "NQM26 2026-03-23 2026-06-19"
  "NQU26 2026-06-22 2026-09-18"
)

force=""
[ "${1:-}" = "--force" ] && force="--force"

: > "$LOG" 2>/dev/null || true
echo "=== contract backfill start $(date '+%F %T') ===" | tee -a "$LOG"
for row in "${CONTRACTS[@]}"; do
  read -r sym from to <<< "$row"
  echo "--- $sym  $from .. $to  ($(date '+%T')) ---" | tee -a "$LOG"
  $PY backfill.py --symbol "$sym" --from "$from" --to "$to" --sessions ETH RTH $force 2>&1 | tee -a "$LOG"
  sleep 2
done
echo "=== contract backfill done $(date '+%F %T') ===" | tee -a "$LOG"

# summary of usable sessions now on disk
$PY - "$LOG" <<'PY'
import json, glob, os, sys
ok = []
for f in sorted(glob.glob("data/*_ETH.json")):
    try:
        j = json.load(open(f))
        n = len(j.get("candles", []))
        m = j.get("_meta", {})
    except Exception:
        continue
    if m.get("kind") == "complete":
        ok.append((f[5:15], m.get("symbol", "?"), n))
print(f"\nusable complete ETH sessions on disk: {len(ok)}")
for d, sym, n in ok:
    print(f"  {d}  {sym}  {n}")
PY
