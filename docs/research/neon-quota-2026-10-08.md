# Neon transfer-cap incident — root cause, probes, and the fix (2026-10-08)

## What happened

The `nq-store` Neon project (`summer-poetry-26619129`, org `nq-scalping`,
`free_v3`) was paused with: *"Project nq-store is paused after reaching its
monthly free plan limit."* Every connection failed at handshake with
SQLSTATE `53000` — *"Your account or project has exceeded the quota."* The
journal, ingest, reconcile and every other nightly DB step went blind; only
the DB-less daybook (volume + R2) kept the journal alive.

## Root cause — measured, not guessed

Project meter on 2026-10-08 (Neon API):

| Meter | Value | Cap | Verdict |
|---|---|---|---|
| `data_transfer_bytes` | **5,505,425,989 (5.13 GiB)** | **5 GiB/month (Free)** | **BLOWN — the pauser** |
| `compute_time_seconds` | 114,494 (~32h) | ~190h/month | fine |
| `synthetic_storage_size` | 431,915,008 (~412 MiB) | 512 MiB | fine |
| `consumption_period_end` | 2026-11-01T00:00:00Z | — | **resets Nov 1** |

The 5 GiB went out in ~10 days of the period. Sources, in order of weight:

1. **Nightly bulk re-ingest** (`nightly.sh` → `db/ingest.ts --since <21d>`):
   a 3-week window of `candles_1m` + `footprint_ticks` upserted every night
   (footprint_ticks = per-price-tick clusters, tens of thousands of rows per
   day, ×21 days, every single night).
2. **Live per-minute writes** (`lib/liveStore.ts`): the feed wrote each
   minute's candles AND its tick clusters into Neon all session long.
3. **Dashboard readthrough** (`lib/gcdb.ts` ← `lib/gcdata.ts`): every
   historical read (profile sheets, day bars, footprint charts) hit Neon
   first — whole days of `footprint_ticks` per panel load.

## Account level or project level? — probed empirically

Created two throwaway projects via the Neon API (same key), reset their
role passwords, connected with `postgres.js`:

| Probe | Result |
|---|---|
| New project in the SAME org (`nq-scalping`) | **CONNECTED, `select 1` OK** |
| New project in a different org | **CONNECTED, `select 1` OK** |

→ The transfer allowance is enforced **per project**, not per account/org.
`nq-store` is paused because IT transferred 5.13 GiB; a fresh project starts
at 0 and connects. (Both probes were deleted afterwards.)

## Decision

- **No delete/recreate.** The paused project can't be `pg_dump`ed while
  paused, and its `signals`/`trades` history is only partially recoverable
  from the VPS daybook volume + CrossTrade fills. Recreating now would
  discard that history for a cap reset we get anyway on **2026-11-01**.
- **Wait for the Nov 1 reset** — the project resumes with a fresh 5 GiB —
  and make sure the workload never comes near the cap again (below).

## The fix (shipped 2026-10-08)

1. **Bulk market data left Neon entirely.** `db/ingest.ts`: candles +
   footprint_ticks are now opt-in (`--candles`, default OFF); `nightly.sh`
   ingests only the small operational tables (profile sheets, events). Bars
   and ticks stay where the consumers already read them: gcdata JSON + R2
   (free egress) — the backtest engine and every study already read the
   archive, never Neon.
2. **Live footprint writes stopped.** `lib/liveStore.ts` keeps only the tiny
   ETH candle row per minute; the tick-cluster write is removed (ticks live
   in LiveFeed RAM + the archive).
3. **Readthrough no longer serves partial days.** `lib/gcdb.ts dbLoadDay`
   returns null when a day has bars but no ticks, so `gcdata.ts` falls back
   to the archive instead of rendering footprint-less charts.
4. **Quota watchdog** (`web/scripts/neonQuota.ts`, hooked into `nightly.sh`
   pre/post): reads the project's `data_transfer_bytes` from the Neon API,
   prints GiB/% + reset date every run, and pages the operator via the
   Telegram bot past `NEON_QUOTA_PAGE_PCT` (default 80%). Armed when
   `NEON_API_KEY` is present in the jobs env (a Coolify env addition —
   owner-approved per repo policy).

Net effect: Neon now carries only signals/trades/exec/guard/insights/sheets
— kilobytes-to-megabytes per day, order(s) of magnitude under the cap. The
nightly tapeParity steps were retired with the bulk ingest they diffed
against (kept in git for `--candles` use).

## Recurrence guard

Even with the slim workload, the watchdog is the backstop: if a future
change reintroduces heavy Neon traffic, the operator gets paged at 80% —
with the project's reset date in the message — instead of discovering the
pause when the journal stops updating.

## The rebuild — fresh project `nq-store2` (same day)

Chosen over waiting for the reset: a new project starts with a full 5 GiB
meter immediately. `nq-store` was KEPT (paused projects retain data) for a
post-reset dump of the Neon-only history (pre-10-06 signals/trades).

| Fact | Value |
|---|---|
| New project | `nq-store2` (`proud-waterfall-41356644`, org `nq-scalping`, aws-us-west-2) |
| Meter at cutover | 0.00 GiB / 5 GiB · resets 2026-11-01 |
| Endpoints updated | `nq-dashboard` + `nq-jobs` Coolify env `DATABASE_URL`, `web/.env.local` |

Rebuild pipeline (all idempotent, committed):

1. `scripts/restoreJournal.ts` — pulls the DB-less sources from the live
   dashboard (`/api/daybook`, volume ∪ R2) and rebuilds `signals` (10 rows
   with full 50-key feature vectors), `exec_log` (17), and the 10-06
   `trades` from the dayend summary (9 rows, `source='daybook'`). Applies
   the full `db/schema.sql` + operational-table DDL (incl. the empty
   `manual_trades` `/api/trades` references).
2. `scripts/reconcileTrades.ts --since 2026-09-28` — re-paired CrossTrade
   fills (durable history, both accounts) against the restored signals:
   5 matched + 3 unexecuted (10-07 session) + 23 unmatched fills.
3. `scripts/tradeAnalysis.ts` — anatomy recomputed from the R2 archive
   (refactored off `candles_1m`; per-trade archive-day mapping because the
   bar files are named by the closing NY date while `trades.day` uses the
   daybook trading-day key).
4. `scripts/scoreSignals.ts` — runs, but outcomes stay unscored until the
   VPS nightly (its container holds the collected session files the file
   replay reads).

Verified in production after deploy: `/api/trades` and `/api/trades/table`
both serve `source: db` — 17 trades, 55 variable columns, journal net
+$168.80 (10-06 summary +$500.90 ∔ 10-07 reconcile −$332.10).

Known gaps (accepted): Neon-only history before 10-06 (recoverable when
`nq-store` resumes on 2026-11-01 — then dump + merge); `manual_trades`
rows from the MFF/Tradovate export (re-import when the next export is
pulled); signal outcomes (next nightly).

Open env request: add `NEON_API_KEY` (+ `TELEGRAM_BOT_TOKEN`) to the
`nq-jobs` env so the watchdog's 80% page actually sends on the VPS —
owner-approved per repo policy.
