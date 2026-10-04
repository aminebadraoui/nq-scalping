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
# the AI briefing's regeneration cadence across the full session:
# Globex reopen (Sun–Thu) → pre-open → RTH open → Europe close →
# lunch lull → RTH close (post-close runs inside nightly.sh)
BR_EVENING="${CRON_BRIEFING_EVENING:-5 18 * * 0-4}"
BR_PREOPEN="${CRON_BRIEFING_PREOPEN:-15 9 * * 1-5}"
BR_POSTOPEN="${CRON_BRIEFING_POSTOPEN:-35 9 * * 1-5}"
BR_MIDMORNING="${CRON_BRIEFING_MIDMORNING:-30 11 * * 1-5}"
BR_MIDDAY="${CRON_BRIEFING_MIDDAY:-30 13 * * 1-5}"
BR_PRECLOSE="${CRON_BRIEFING_PRECLOSE:-5 16 * * 1-5}"
LOG="/app/gcdata/data/nightly_cron.log"
RLOG="/app/gcdata/data/reconcile_cron.log"
BLOG="/app/gcdata/data/briefing_cron.log"
{
  echo "$RECONCILE_SCHEDULE /bin/bash /app/scripts/reconcile.sh >> $RLOG 2>&1"
  echo "$BR_EVENING /bin/bash /app/scripts/briefing.sh evening-open >> $BLOG 2>&1"
  echo "$BR_PREOPEN /bin/bash /app/scripts/briefing.sh pre-open >> $BLOG 2>&1"
  echo "$BR_POSTOPEN /bin/bash /app/scripts/briefing.sh post-open >> $BLOG 2>&1"
  echo "$BR_MIDMORNING /bin/bash /app/scripts/briefing.sh mid-morning >> $BLOG 2>&1"
  echo "$BR_MIDDAY /bin/bash /app/scripts/briefing.sh midday >> $BLOG 2>&1"
  echo "$BR_PRECLOSE /bin/bash /app/scripts/briefing.sh pre-close >> $BLOG 2>&1"
  echo "$SCHEDULE /bin/bash /app/scripts/nightly.sh >> $LOG 2>&1"
} > /var/spool/cron/crontabs/root
chmod 600 /var/spool/cron/crontabs/root
echo "[jobs] cron installed:"
echo "[jobs]   reconcile $RECONCILE_SCHEDULE (tz=$(date +%Z)) → $RLOG"
echo "[jobs]   briefing  evening $BR_EVENING · pre-open $BR_PREOPEN · post-open $BR_POSTOPEN · mid-morning $BR_MIDMORNING · midday $BR_MIDDAY · pre-close $BR_PRECLOSE (tz=$(date +%Z)) → $BLOG"
echo "[jobs]   nightly   $SCHEDULE (tz=$(date +%Z)) → $LOG"
exec crond -f -l 2
