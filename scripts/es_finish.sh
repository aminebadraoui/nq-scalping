#!/bin/bash
# Finish the ES archive build: heal sparse/partial sessions (incl. roll-week
# refetches under the next contract), verify coverage parity with the NQ
# archive, upload to R2 (data/es/* + manifest-es.json), prune the local disk.
#
# Idempotent: re-running skips complete files and sha-matching uploads.
# Refuses to start while another backfill_es.py is running (one socket,
# one collector).
set -uo pipefail

ROOT="/Users/amean/PROJECTS/DEV/Scalping"
cd "$ROOT/gcdata" || exit 1

if pgrep -f "python.*backfill_es\.py" >/dev/null 2>&1; then
  echo "backfill_es.py still running — wait for it to finish first" >&2
  exit 1
fi

echo "=== heal pass (re-fetches partial/sparse sessions only) ==="
./.venv/bin/python backfill_es.py 2>&1 | tail -8
HEAL_RC=${PIPESTATUS[0]}

echo "=== coverage parity vs NQ archive ==="
./.venv/bin/python check_es_coverage.py
COV_RC=$?

echo "=== upload to R2 + prune local ==="
python3 "$ROOT/scripts/es_r2_sync.py" upload 2>&1 | tail -4
UP_RC=${PIPESTATUS[0]}
if [ "$UP_RC" -eq 0 ]; then
  python3 "$ROOT/scripts/es_r2_sync.py" prune 2>&1 | tail -4
fi

echo "=== done (heal=$HEAL_RC coverage=$COV_RC upload=$UP_RC) ==="
exit $(( HEAL_RC || COV_RC || UP_RC ))
