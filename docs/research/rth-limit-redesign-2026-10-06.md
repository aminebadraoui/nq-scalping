# RTH limit-entry redesign — 2026-10-06

## Problem

Live RTH soft-continuation trades executed as MARKET entries with brackets
anchored at the SIGNAL price (`CROSSTRADE_REST=1` absolute prices). In a
fast tape the fill drifts from the signal between bar close and dispatch
(measured live 2026-10-06: 19.25 / 10.5 / 2.25 pts on the three RTH cards):

- fill beyond the absolute take-profit → CrossTrade OCO closes instantly
  (the 2026-10-04 failure mode, twice on 2026-10-06) → −0.5/−0.25 scratches;
- fill near the take-profit → target only ~0.75 pts away → fee-eaten
  "win" (−$4.80 net on the 15:35 card);
- fill far from the stop → silently enlarged risk.

All three 2026-10-06 RTH cards lost net (−$27.90) and the signal dashboard
still scored them as wins — the outcome column is signal-level scoring,
not execution.

## Studies (all three scripts replay the 650-session archive)

### rthStaleGateStudy.ts — can a pre-dispatch stale gate save market entries?

- Gate: skip when adverse move > k×risk OR favorable move > targetDist − 1.5
  (the tape ltp at card-fire time — what the live feed actually sees).
- Cell A (signal-level scoring): the gate forfeits the family's best trades
  (+11.9k pts at k=0.5, 93% WR) — the RTH edge LIVES in moved-market trades.
- Cell B (drift-aware fills, $1.90/RT): those "winners" are scratches and
  mis-anchored stop-outs in reality. No-gate baseline: PF 0.50, 1,081
  scratches, −$67k, BREACH. The gate removes all scratches and avoids a
  net-losing set, but the kept set stays PF ~0.55 — mitigation, not a cure.
- **Verdict: gate rejected** — it also hurts the limit-entry configs below.

### rthDriftOptimizer.ts — does ANY config survive fees under realistic fills?

112 configs (stop × target × market/limit × gate). Only resting-LIMIT
entries survive; every market config breaches. Top: s0.5/t2.5 limit
+$13.8k PASS; s0.5/t2.0 limit +$3.0k PASS; current live config −$67k.

### rthLimitValidation.ts — train/OOS validation of the surviving configs

Train (< 2026-01-01): PASS + PF ≥ 1.2 + dd ≥ −1900 → 8/24 qualify, all
PASS out-of-sample:

| config | train | OOS 2026 | 2024 / 2025 / 2026 | total @$1.90/RT |
|---|---|---|---|---|
| s0.5 t2.5 limit | +$8.1k | +$5.7k PASS | −$1.3k / +$10.2k / +$5.7k all PASS | +$13.8k |
| s0.5 t2.5 limit 3/day | +$2.2k | +$2.7k PASS | all PASS | +$4.9k |
| s0.5 t2.0 limit 3/day | +$1.2k | +$1.6k PASS | all PASS | +$2.7k |
| s0.5 t2.0 limit | +$0.7k | +$2.3k PASS | all PASS | +$3.0k |

TTL sweep on the winner: 10 bars +$17.6k (dd −$1.1k) > 5 bars +$13.8k >
3 bars BREACH. Fee sensitivity: positive through ~$2.10/RT (measured live
fee = $1.90/RT); negative at $2.40/RT.

## Change shipped

- `lib/signalFeed.ts` — `rthLimitParams()` + the RTH limit-entry path
  (resting limit at the signal price via the existing `placeOrder({limitPrice})`
  and execWatch limit lifecycle: fill-or-expire, cancel on expiry).
  **OFF by default** (`RTH_LIMIT_ENTRIES=1` enables; knobs
  `RTH_LIMIT_STOP_MULT` 0.5, `RTH_LIMIT_TARGET_R` 2.5, `RTH_LIMIT_TTL_MS`
  default 9 min — under the 10-min watcher give-up clock so expiry takes
  the clean `limit_expired` path).
- `tests/rthLimitEntry.test.ts` — param parsing.

## Live ops

- `FEED_RTH=0` applied to the `nq-dashboard` Coolify env 2026-10-06
  (approved) — the losing market-order RTH path is off until the
  limit-entry redesign is enabled (explicit approval + env change first).
- Momentum family untouched (already resting-limit via the retrace path).
