#!/bin/sh
# Container entrypoint for the nq-jobs Coolify app (nightly data pipeline).
#
# RUN_ONCE=1   → run the nightly pipeline immediately once, then park
#                (sleep forever — verification mode: set the env,
#                redeploy, read the logs; a failed run never restarts it).
# RUN_WEEKLY=1 → run the weekly review (scripts/weekly.sh) once, then fall
#                through to normal cron mode (verification of the Saturday
#                job without missing the nightly slots).
# otherwise    → install the crontab and run crond in the foreground.
#
# The pipeline itself is scripts/nightly.sh — identical to the Mac launchd
# job (com.scalping.collect). NEVER run both in the same window: the R2
# manifest is single-writer.
set -eu

mkdir -p /app/gcdata/data /app/cache

if [ "${RUN_ONCE:-0}" = "1" ]; then
  echo "[jobs] RUN_ONCE=1 — running the nightly pipeline now"
  # `|| rc=$?`: under `set -e` a failing pipeline must NOT kill the
  # entrypoint — compose's restart policy would re-run the whole pipeline
  # in a loop. Log the rc and park, as documented.
  rc=0
  /bin/bash /app/scripts/nightly.sh "$@" || rc=$?
  echo "[jobs] pipeline finished (rc=$rc) — sleeping forever (verification mode)"
  exec tail -f /dev/null
fi

if [ "${RUN_WEEKLY:-0}" = "1" ]; then
  echo "[jobs] RUN_WEEKLY=1 — running the weekly review now (then normal cron mode)"
  # a failed weekly run must still fall through to cron mode — otherwise
  # the container dies before the nightly crontab is installed
  rc=0
  /bin/bash /app/scripts/weekly.sh "$@" || rc=$?
  echo "[jobs] weekly review finished (rc=$rc) — continuing to cron mode"
fi

SCHEDULE="${CRON_SCHEDULE:-45 17 * * 1-5}"
RECONCILE_SCHEDULE="${CRON_RECONCILE:-50 16 * * 1-5}"
# the Macro tab's AI interpretation: one daily slot (the combined read
# absorbed the retired AI briefing; post-close also runs in nightly.sh).
# 08:45 ET (was 09:20): still pre-open, but OUT of the 09:15–09:30 open
# ramp so the shared VPS never competes with the executor's warm-up for
# the 9:30 open (the only scheduled job that touched the live window).
INTERPRET="${CRON_INTERPRET:-45 8 * * 1-5}"
# the Saturday-morning weekly review (self-improvement pass, Phase 1–3):
# after Friday's nightly + weekly arms, before the weekend — read-only vs
# Neon + the R2 archive, dry-run promotion verdicts by default.
WEEKLY="${CRON_WEEKLY:-15 9 * * 6}"
LOG="/app/gcdata/data/nightly_cron.log"
RLOG="/app/gcdata/data/reconcile_cron.log"
ILOG="/app/gcdata/data/interpret_cron.log"
WLOG="/app/gcdata/data/weekly_cron.log"
{
  echo "$RECONCILE_SCHEDULE /bin/bash /app/scripts/reconcile.sh >> $RLOG 2>&1"
  echo "$INTERPRET /bin/bash /app/scripts/interpret.sh >> $ILOG 2>&1"
  echo "$SCHEDULE /bin/bash /app/scripts/nightly.sh >> $LOG 2>&1"
  echo "$WEEKLY /bin/bash /app/scripts/weekly.sh >> $WLOG 2>&1"
} > /var/spool/cron/crontabs/root
chmod 600 /var/spool/cron/crontabs/root
echo "[jobs] cron installed:"
echo "[jobs]   reconcile $RECONCILE_SCHEDULE (tz=$(date +%Z)) → $RLOG"
echo "[jobs]   interpret $INTERPRET (tz=$(date +%Z)) → $ILOG"
echo "[jobs]   nightly   $SCHEDULE (tz=$(date +%Z)) → $LOG"
echo "[jobs]   weekly    $WEEKLY (tz=$(date +%Z)) → $WLOG"
exec crond -f -l 2
