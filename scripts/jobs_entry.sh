#!/bin/sh
# Container entrypoint for the nq-jobs Coolify app (nightly data pipeline).
#
# RUN_ONCE=1   → run the nightly pipeline immediately once, then exit
#                (verification mode: set the env, redeploy, read the logs).
# otherwise    → install the crontab and run crond in the foreground.
#
# The pipeline itself is scripts/nightly.sh — identical to the Mac launchd
# job (com.scalping.collect). NEVER run both in the same window: the R2
# manifest is single-writer.
set -eu

mkdir -p /app/gcdata/data /app/cache

if [ "${RUN_ONCE:-0}" = "1" ]; then
  echo "[jobs] RUN_ONCE=1 — running the nightly pipeline now"
  /bin/bash /app/scripts/nightly.sh "$@"
  echo "[jobs] pipeline finished (rc=$?) — sleeping forever (verification mode)"
  exec tail -f /dev/null
fi

SCHEDULE="${CRON_SCHEDULE:-45 17 * * 1-5}"
RECONCILE_SCHEDULE="${CRON_RECONCILE:-50 16 * * 1-5}"
# the Macro tab's AI interpretation: one daily slot (the combined read
# absorbed the retired AI briefing; post-close also runs in nightly.sh).
# 08:45 ET (was 09:20): still pre-open, but OUT of the 09:15–09:30 open
# ramp so the shared VPS never competes with the executor's warm-up for
# the 9:30 open (the only scheduled job that touched the live window).
INTERPRET="${CRON_INTERPRET:-45 8 * * 1-5}"
LOG="/app/gcdata/data/nightly_cron.log"
RLOG="/app/gcdata/data/reconcile_cron.log"
ILOG="/app/gcdata/data/interpret_cron.log"
{
  echo "$RECONCILE_SCHEDULE /bin/bash /app/scripts/reconcile.sh >> $RLOG 2>&1"
  echo "$INTERPRET /bin/bash /app/scripts/interpret.sh >> $ILOG 2>&1"
  echo "$SCHEDULE /bin/bash /app/scripts/nightly.sh >> $LOG 2>&1"
} > /var/spool/cron/crontabs/root
chmod 600 /var/spool/cron/crontabs/root
echo "[jobs] cron installed:"
echo "[jobs]   reconcile $RECONCILE_SCHEDULE (tz=$(date +%Z)) → $RLOG"
echo "[jobs]   interpret $INTERPRET (tz=$(date +%Z)) → $ILOG"
echo "[jobs]   nightly   $SCHEDULE (tz=$(date +%Z)) → $LOG"
exec crond -f -l 2
