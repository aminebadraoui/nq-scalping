#!/bin/bash
# Backfill every NQ contract's front-month tenure — calendar-driven.
#
# The contract calendar (gcdata/contracts.py: expiry = 3rd Friday of H/M/U/Z)
# is generated on the fly, so the 10-year walk keeps working as new quarters
# roll over without editing a hardcoded table. backfill_tenures.py walks the
# calendar oldest first, so where two contracts overlap around a roll the
# older (the true front month at that date) wins and complete files are
# never overwritten by a less-liquid contract.
#
# Run:   scripts/backfill_contracts.sh [--force] [--from 2017-03-01] [--to today]
# Log:   gcdata/data/backfill_contracts.log

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/gcdata" || exit 1
PY=".venv/bin/python"
LOG="$ROOT/gcdata/data/backfill_contracts.log"

: > "$LOG" 2>/dev/null || true
echo "=== contract backfill start $(date '+%F %T') ===" | tee -a "$LOG"
$PY backfill_tenures.py "$@" 2>&1 | tee -a "$LOG"
echo "=== contract backfill done $(date '+%F %T') ===" | tee -a "$LOG"

# summary of usable sessions now on disk
$PY - <<'PY'
import json, glob
ok = []
for f in sorted(glob.glob("data/*_ETH.json")):
    try:
        j = json.load(open(f))
        m = j.get("_meta", {})
    except Exception:
        continue
    if m.get("kind") == "complete":
        ok.append((f[5:15], m.get("symbol", "?"), len(j.get("candles", []))))
print(f"\nusable complete ETH sessions on disk: {len(ok)}")
for d, sym, n in ok:
    print(f"  {d}  {sym}  {n}")
PY
