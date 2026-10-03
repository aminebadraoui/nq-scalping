# nq-jobs — the nightly data pipeline container (Coolify compose app).
#
# One image for the whole pipeline:
#   · Python 3  — GoCharting collectors (backfill.py, collect_ohlc.py,
#                 backfill_es.py) + R2 sync (r2_sync.py, es_r2_sync.py)
#   · Node 22   — Neon ingest + trade reconciliation/analysis/insights
#                 (web/db + web/scripts TS, run via scripts/ts-loader.mjs)
#   · cron      — schedules scripts/nightly.sh (Mon–Fri 17:45 America/New_York)
#
# Secrets are injected as environment variables by Coolify; nightly.sh and the
# Python/TS scripts all read env first (the Mac's gcdata/.env is only a local
# fallback). RUN_ONCE=1 runs the pipeline immediately instead of scheduling.
FROM node:22-alpine

RUN apk add --no-cache python3 py3-pip bash tzdata ca-certificates && \
    pip3 install --no-cache-dir --break-system-packages \
        "websocket-client==1.9.2" "protobuf==7.36.2"

WORKDIR /app
COPY . .
RUN cd web && npm ci

ENV SCALPING_ROOT=/app \
    NODE_BIN=node \
    TZ=America/New_York \
    MOM_CACHE_DIR=/app/cache \
    CRON_SCHEDULE="45 17 * * 1-5"

ENTRYPOINT ["/bin/sh", "/app/scripts/jobs_entry.sh"]
