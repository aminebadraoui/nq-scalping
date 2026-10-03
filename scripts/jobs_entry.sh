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
  exec /bin/bash /app/scripts/nightly.sh "$@"
fi

SCHEDULE="${CRON_SCHEDULE:-45 17 * * 1-5}"
LOG="/app/gcdata/data/nightly_cron.log"
echo "$SCHEDULE /bin/bash /app/scripts/nightly.sh >> $LOG 2>&1" > /var/spool/cron/crontabs/root
chmod 600 /var/spool/cron/crontabs/root
echo "[jobs] cron installed: '$SCHEDULE' (tz=$(date +%Z)) → $LOG"
exec crond -f -l 2
