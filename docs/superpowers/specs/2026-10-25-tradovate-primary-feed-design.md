# Tradovate primary live feed, GoCharting fallback — design (2026-10-25)

## Goal

Every live consumer (signal stack, executor, dashboards) reads Tradovate
bars, ticks and quote. GoCharting stays connected as a hot standby and
takes over only when Tradovate is unhealthy. The archive and backtests
stay on GoCharting (Tradovate cannot backfill the 649-session history).

## Decision record

- Scope: live feed + dashboard views (user choice).
- Failover: health-based, hot standby (user choice).
- Rollout: deploy ASAP, no parity backtest — explicit user override of
  `web/EXEC_CHANGE_POLICY.md` rule 1. Known risk: detectors were tuned on
  GC candles; Tradovate classifies aggressor side itself (vs the tick's
  bid/ask), so per-bar delta differs from GC.
- Evidence at decision time: VPS collector streams full-size NQZ6; NQ
  day volume GC 73,569 vs Tradovate 73,621 (0.07%) → Tradovate tick
  chart is the full tape. Local 10-19 journal was MNQ (vol ×7.6, delta
  sign agreement 80%, high/low median diff 0.5pt) — not an NQ parity
  validation.

## Architecture

- `web/lib/tvFeed.ts` — tails `data/tradovate-md/md-<ET-day>.jsonl`
  (500ms, 1MB chunks with yields), routes symbol-stamped chart/quote
  lines to per-symbol `TvBarBuilder`s (full-size NQ/ES only; micros are
  ignored). Bars use the `LiveMinute` shape with `vendor:"tv"`.
  A bar closes 1.5s after its minute ends; it is stamped
  `source:"candle"` (passes the existing card gate unchanged) only if
  complete: not the first minute seen, and tick-id holes ≤ max(2, 1%).
- `web/lib/live.ts` — internal GC buffer renamed `gc`; public `state` is
  a getter composing the served view. Per buffer (NQ, ES) an arbiter:
  - health = bootstrapped, tick < 20s old, a complete bar exists, last
    closed bar < 125s old and complete;
  - unhealthy while market open → GC immediately;
  - healthy continuously 120s → Tradovate; closed market holds.
  - TV mode minutes: complete TV bars win, GC fills history before TV
    coverage and any incomplete TV minute; GC bars newer than the last
    closed TV bar are dropped.
  - `barsRevision` is a monotonic published counter (bumps on any bar
    change of either vendor or a source switch).
- Switches: console `[feed]` line, daybook `t:"feed"` record, Telegram
  (NQ only, ≤ 1 per 2 min). Status in `state.feed` (served by `/api/live`).
- Kill switch: `LIVE_BAR_SOURCE=gc` → raw GC buffer (needs a Coolify env
  change + redeploy — user approval required).

## Testing

`web/tests/tvFeed.test.ts` (builder, gaps, finalize, journal tail,
health, arbiter, composition); full `npm test` + `tsc`; replay of the
local 10-19 journal (mechanics only).

## Not done / follow-ups

- NQ per-minute parity study (TV vs GC candles) once a few sessions of
  stamped NQ journal exist on the VPS; then the matching backtest.
- ES via Tradovate only if the VPS `TVMD_SYMBOLS` includes ESZ6;
  otherwise ES stays on GC.
- The collector journal stores the access token in `authorize` lines.
