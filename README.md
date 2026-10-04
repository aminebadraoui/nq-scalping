# NQ Scalping System

Personal NQ (Nasdaq-100 futures) scalping research & execution system:
collects GoCharting footprint/order-flow data, stores it in Neon Postgres +
Cloudflare R2, serves a live dashboard, computes Telegram trade signals, and
auto-executes them on an MFF Tradovate eval account via CrossTrade.

> **This file is the entry point.** Everything else in the repo is reachable
> from here. Educational research only — not financial advice.

## Where to start (read in this order)

| # | Doc | What it answers |
|---|---|---|
| 1 | **this README** | what the system is, how the repo is organized |
| 2 | **`PLAYBOOK.md`** | every strategy we test, every threshold, and the measured results — the single strategy reference |
| 3 | **`web/README.md`** | what the dashboard does, its two surfaces, the Telegram card inventory |
| 4 | **`deploy/STATE.md`** | infrastructure truth: what is deployed where, the data flow, ops commands, lessons learned |
| 5 | **`gcdata/README.md`** | how footprint data is collected, the archive file contract, DOM_V2 L2 feed |
| 6 | **in-app `/docs`** (dashboard → Docs) | the "real reversal or fakeout?" research narrative: evidence grading, tool stack, checklist, sources |
| 7 | **`DOCS.md`** | the full classified index of every markdown file — what is active, what is superseded, what each preserves |

If you only have five minutes: read this README, then `PLAYBOOK.md`, then the
first two sections of `deploy/STATE.md`.

## What is live right now

- **Dashboard:** https://nq-dashboard.31.97.138.30.sslip.io (Coolify VPS,
  auto-deployed on every push to `main`)
- **Feed toggles (deployed VPS, verified via `/api/gc?action=health`):**
  `FEED_MOMENTUM=1` · `FEED_RTH=1` · `FEED_OPEN_DRIVE=1` · `FEED_OPEN=1` ·
  unusual-volume alerts ON (context only) · reversal, sweep-reclaim,
  pullback-ticket, open-pullback, open-sniper OFF
- **Execution:** the VPS is the single live executor (`EXECUTE_LIVE=1` only
  there; the Mac keeps `EXECUTE_LIVE=0`)
- **Nightly pipeline:** runs on the VPS (`nq-jobs` Coolify app, cron 17:45 ET
  Mon–Fri) — collection, Neon ingest, R2 upload/prune, reconciliation,
  analysis, insights, ES twin. The Mac is a read-only consumer (lab +
  backtests + dev) with a launchd fallback that stays booted out.
- **Data:** NQ footprint archive 2023-12-18 → now (649 usable sessions, R2);
  ES cross-asset twin archive same range; Neon holds a rolling ~21-day window

## Architecture (one diagram)

```
[Coolify VPS] nq-dashboard container ── dashboard · signal feed · DOM feed
     │          live capture → Neon (LIVE_WRITE) · Telegram cards
     │          └─ CrossTrade REST ──► MFF Tradovate (bracketed, guard-gated)
     │
[Coolify VPS] nq-jobs container — cron 17:45 ET Mon–Fri (single writer)
     │          collect → ingest → reconcile → analyze → insights → R2 sync
     ▼
Neon Postgres (rolling 21-day window) · Cloudflare R2 (2.5y archive + manifest)
     ▼  one read chain: Neon → R2 → local fallback
deployed dashboard · localhost dev · Mac lab/backtests (Mac = read-only consumer)
```

## Code map

```
web/                 the dashboard + signal engine (Next.js 16, React 19, TS)
  app/               routes: / · /docs · /journal · /backtest · /lab · /dashboard
                     API:  /api/gc /api/live /api/dom /api/signal
                           /api/trades /api/insights /api/lab /api/backtest
                           /api/macro (display-only macro panels)
  components/        dashboard panels + the /docs content sections + the macro
                     bento (MacroPulseCard · CrossAssetCard · TreasuriesCard ·
                     NewsCalendarPanel · EarningsPanel · MacroFooter · BentoCard ·
                     TickMomentumPanel — live tick-speed read, study aid)
  lib/               the engine (~60 modules, pure functions + live singletons):
      feeds          live.ts · liveStore.ts · dom.ts · domBook.ts · domStore.ts ·
                     optionsFeed.ts · useLive.ts · useDom.ts · tickMomentum.ts
                     (velocity/impact/rejection-speed decode of the live tape)
      macro context  macroFeed.ts · newsCalendar.ts · earnings.ts · bonds.ts ·
        (display-only — never imported by signals)   macroWatch.ts · macroFmt.ts ·
                     useMacro.ts
      signals        signalFeed.ts · signalEngine.ts · signals.ts · signalText.ts ·
                     signalHistory.ts · momentum.ts · softMomentum.ts ·
                     openDrive.ts · reclaimSetup.ts · sweepReclaimV2.ts ·
                     pullback.ts · unusualVolume.ts · balanceBreak.ts ·
                     wallStop.ts · priceaction.ts · mechanism.ts · story.ts
      risk & exec    crossTrade.ts · crossGuard.ts · accountGuard.ts ·
                     propRules.ts · propAccount.ts · execWatch.ts · execLog.ts ·
                     executor.ts · runner.ts · runnerTracker.ts · newsGate.ts
      self-improv.   strategyInsights.ts · strategyOverrides.ts · strategyStats.ts ·
                     tradeStats.ts · reconcile.ts · edgeMonitor.ts · esJoin.ts
      data & time    gcdata.ts · gcdb.ts · data.ts · footprint.ts · footprintProto.ts ·
                     volumeProfile.ts · imbalance.ts · archive.ts · lab.ts ·
                     labPresets.ts · times.ts · marketHours.ts · backtest.ts
      notify.ts      Telegram
  db/                Neon schema + ingest + backtest/study helpers + local executor
  scripts/           study CLIs — 4 wired into nightly.sh (reconcileTrades,
                     tradeAnalysis, strategyInsights, riskStackStudy), the rest
                     are ad-hoc research tools matching the docs/research/ notes
  tests/             427 regression tests (420 pass / 7 skipped, offline ~2.5s)
gcdata/              Python collectors (GoCharting footprint/OHLC/DOM), protobuf
                     schemas, contract calendar, ES twin; venv + .env (gitignored)
scripts/             ops: nightly.sh (the pipeline), r2_sync.py, es_r2_sync.py,
                     repair_data.py, backfill_contracts.sh, es_finish.sh
deploy/              STATE.md (canonical ops record) · setup.sh
docs/strategy/       signal design docs (momentum, RTH, open, reversal, boxes)
docs/research/       empirical studies + trade reviews (the measured results)
docs/data/           data-source audits + macro/PIT methodology + the dashboard
                     macro-panels research (DASHBOARD_MACRO_PANELS.md)
docs/launchd/        the two launchd job definitions (collect + domprobe)
PLAYBOOK.md          the canonical strategy reference · DOCS.md the corpus index
```

## Run it locally

```bash
cd web
npm run dev      # dashboard on http://localhost:3000 (EXECUTE_LIVE=0 locally)
npm test         # 427 tests, no network
npm run build && npm start          # production standalone (what the VPS runs)
```

Nightly pipeline: `scripts/nightly.sh` runs on the VPS `nq-jobs` cron
(17:45 ET Mon–Fri). Manual local runs: `NIGHTLY_FORCE=1 scripts/nightly.sh`
— never in the same window as the VPS job (the R2 manifest is single-writer).
Manual pieces are documented in `deploy/STATE.md` §Operate.

## Conventions & invariants

- **Nothing secret is committed** — creds live in gitignored files
  (`gcdata/.env`, `web/.env.local`, `.agents/skills/coolify-deploy/`, Coolify
  env). If a secret ever lands in git: rotate AND rewrite history.
- **`lib/marketHours.ts` is the single market calendar**; `deploy/STATE.md`
  is the single ops record; `PLAYBOOK.md` is the single strategy record —
  update them when behavior changes.
- Commits are conventional (`feat:`, `fix:`, `diag:`, `docs:`, `chore:`);
  every push to `main` auto-deploys.
- Empirical claims in the playbook are re-measurable: each study has a
  matching `web/scripts/*.ts` CLI and usually a `docs/research/*.md` note.
