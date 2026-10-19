#!/bin/sh
# nq-dashboard container entrypoint: Next standalone server + the
# Tradovate md collector as a supervised sidecar.
#
# The collector is compiled to plain JS at build time
# (/app/tvmd/scripts/tradovateMd.js — no TS loader in the runtime image).
# It restarts itself with a 60s backoff so a dead token, a quota event,
# or a crash never takes the web server down with it. Token + JSONL live
# on the mounted /app/data volume (TVMD_OUT / TVMD_TOKEN_FILE defaults).
set -e

node server.js &

(
  while true; do
    node /app/tvmd/scripts/tradovateMd.js || true
    sleep 60
  done
) &

wait -n
