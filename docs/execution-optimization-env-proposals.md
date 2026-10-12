# Execution-optimization — env-knob proposals (owner approval required)

> 2026-10-12 · The artifact for `web/EXEC_CHANGE_POLICY.md` rule 4.
> Every knob below changes live behavior. None is applied — each needs
> the owner's explicit yes with the key/value shown here. The code side
> of the optimization batch is committed behind `[backtested:]` tags
> (commits `30c689a`, `632ce3b`, `f7cf189`, `7da9f5e`); these env flips
> are the last step.

## The batch this doc accompanies

1. Detection 0–15s → sub-second: event tick implemented + made safe
   (non-lossy coalescing, revision-aware re-fire) — `signalFeed.ts`.
2. Dispatch pre-flight parallelized (guard ‖ flat gate) + hydration
   latch + DB timeouts — `crossTrade.ts`, `crossGuard.ts`,
   `accountGuard.ts`, `strategyOverrides.ts`, `asyncTimeout.ts`.
3. Fill watch: 5s timer + pushed-fill immediate confirm —
   `execWatch.ts`, `ctStream.ts`.
4. Retrace limits rest AT THE BROKER at card time — `signalFeed.ts`
   (the `retraceSlippageStudy` 0.0-pt cell, now the live path).
5. Fill model: `stopSlipPts` + `minGapBars` in `backtestEngine.ts`;
   `fillAudit.ts` models the live re-bracket.
6. Interpret cron moved off the open ramp; deploy-window documented.

## Proposals (each = one Coolify env change on `nq-dashboard`)

| # | Key | Value | Effect | Evidence | Verify before/after | Status |
|---|---|---|---|---|---|---|---|
| 1 | `SIGNAL_EVENT_TICK` | `1` | Detection lag 0–15s (mean ~7.5s) → sub-second + vendor candle confirm. THE dominant speed lever; the edge is lag-sensitive (`fillAudit`: ~1 min lag flips momentum +$21k → −$66k) | Code + unit tests; `retraceSlippageStudy`, `fillAudit`, `riskStackStudy` all re-run | Execution tab `detection lag` + `bar age` p50 before/after | ✅ **live (owner, 2026-10-11)** — prod env confirmed via Coolify API + runtime health |
| 2 | `SIGNAL_REFRESH_SECONDS` | `10` | Poll backstop floor tightened to the code minimum | — | Same metric | ✅ **live (owner, 2026-10-11)** |
| 3 | `CONFIRM_RACE_PROBE` | `1` | Read-only diagnostic: per-bar REST-vs-frame candle-confirmation race log. If REST wins consistently, the 60s refresh cadence can be tightened later | — | VPS logs `[confirm-race]` lines | ⏸ **left 0 (owner's choice** — prod 0, local 0). The event tick now measures detection lag directly |
| 4 | `RTH_LIMIT_ENTRIES` | `1` | RTH entries become resting limits at the signal price (validated redesign): market entries PF 0.50 unfundable vs resting-limit +$13.8k | `scripts/rthLimitValidation.ts` (2026-10-06) | RTH fill drift journal | ✅ **live (owner, 2026-10-11)** — prod env confirmed |
| 5 | `MAX_MICRO_CONTRACTS` | `8` | Cap live size during the bounded RTH calibration window (docs/research/fill-model-integrity-2026-10-08 §"bounded live experiment") | Same doc | Trade ledger sizes | ✅ **applied 2026-10-12** via Coolify API (prod env `MAX_MICRO_CONTRACTS=8`) — bakes at next deploy |
| 6 | `NEON_API_KEY` / `NEON_PROJECT_ID` | (jobs env) | Re-enables the nightly Neon quota watchdog | `scripts/neonQuota.ts` | nightly log | ✅ **already armed** — jobs prod env has `NEON_API_KEY`; project default (`proud-waterfall-41356644` = nq-store2) matches the live DB org (verified via Neon API) |

Deploy all env changes inside the deploy window (`web/EXEC_CHANGE_POLICY.md`
§3b): the daily 16:00–18:00 ET halt. Env changes re-bake the container —
a mid-RTH redeploy resets in-memory executor state.

## Pending decisions (study-first, not env-only)

- **Expansion scale-out parity** — live runs the single-leg 1R path
  (`CROSSTRADE_SCALEOUT` OFF) while the published +$58k validation
  measured the bank+runner ladder. Decide: re-validate the single-leg
  path (fillAudit's expansion cell) or enable `CROSSTRADE_SCALEOUT=1`
  after the ladder re-validation. Either way this is the last
  live-vs-model divergence for the family.
- **Retrace study budget** — `retraceSlippageStudy.ts` sizes at $170;
  live now defaults to $100 (`PROP_RISK_PER_TRADE`). Re-run the study
  at $100 for the honest live-size numbers.
- **Stop-slip calibration** — extend the measured stop-slip model
  (currently RTH-only) to momentum/open with the live slippage-alarm
  journal, then feed `stopSlipPts` into their studies.
- **GC/Node tuning + executor process split** — deferred: needs its own
  study (nothing applied).

## What the code changes already fixed (no env needed)

Dispatch pre-flight parallelization · hydration latch · DB timeouts ·
25s snapshot keep-alive · boot warm · fill-watch 5s timer + pushed-fill
confirm · tick coalescing · revision-aware event tick · snapshot hoist ·
chip memoization · retrace-at-broker · risk-budget unification ·
interpret cron 08:45 · deploy-window doc.
