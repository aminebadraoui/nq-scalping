# Overfitting-validation pipeline — DSR / PBO / CPCV (2026-10-04)

The backtests stopped having to *argue* they are not overfit: every family's
grid sweep now gets a multiple-testing-corrected audit computed from the same
replay data. This doc is the pipeline contract; the per-family numbers live
in `gcdata/data/sweeps/<family>-*.validation.json` and the `/backtest` page.

## Pipeline (three stages, one direction)

```
web/scripts/exportSweep.ts      TS grid replay (SAME detectors as live)
  --family momentum|expansion|rth --cost 0.95
  → gcdata/data/sweeps/<family>-<stamp>.json
      per config: per-session netUsd/riskUsd/trades/wins (1 MNQ)
      + appends gcdata/data/trials.json (the trial ledger)

gcdata/validate_sweep.py        purgedcv audit (Python 3.14 venv)
  --holdout-last 40 = frozen single-use holdout (pinned in data/holdouts.json)
  → <sweep>.validation.json: PBO (CSCV) · DSR · PSR · MinTRL · MinBTL
      · per-year table · concentration · Sharpe heatmap · top-20 · pick series
      · holdout result + verdict · stamps the trial ledger entry

gcdata/optuna_view.py           viewer-only Optuna study (no search)
  → gcdata/data/optuna/<family>.db   (optuna-dashboard <db>)
```

Run (from `web/` for the sweep, from `gcdata/` for the rest):

```
export GC_REMOTE_URL=<r2 url from web/.env.local>
node --import ./tests/ts-loader.mjs ./scripts/exportSweep.ts --family rth --cost 0.95
../gcdata/.venv/bin/python validate_sweep.py ../gcdata/data/sweeps/rth-*.json --pick s0.45_t1.75_x45 --holdout-last 40
../gcdata/.venv/bin/python optuna_view.py ../gcdata/data/sweeps/rth-*.json --pick s0.45_t1.75_x45
../gcdata/.venv/bin/optuna-dashboard sqlite:///../gcdata/data/optuna/rth.db
```

## Frozen holdout (single-use)

`--holdout-last N` reserves the last N sessions (2026-08-06 → 2026-10-02 for
N=40) as a single-use out-of-sample window:

- The FIRST run that declares a holdout for a family pins `{N, pick}` in
  `gcdata/data/holdouts.json` — the pin is immutable; later runs must reuse
  the same window and pick (goalpost-moving is refused with a warning).
- DSR / PBO / PSR / MinTRL / MinBTL / trial Sharpes / heatmap are all
  computed on the PRE-holdout sessions only; the pick is chosen on
  pre-holdout data (argmax when no `--pick` is given).
- The holdout result is reported separately (n, WR, net, Sharpe) and added
  to the verdict line and the `/backtest` card. Selection never sees it.
- Declaration order matters: the pick must be frozen BEFORE the holdout
  result is looked at. All three families were declared 2026-10-04 with
  their pre-existing picks (momentum/rth from the docs, expansion argmax on
  pre-holdout data).

## Metrics and thresholds

| Metric | What it answers | Pass band |
|---|---|---|
| **DSR** (deflated Sharpe) | is the pick's Sharpe beyond what `n_trials` configs produce by luck? | ≥ 0.95 strong, 0.80–0.95 moderate |
| **PBO** (prob. backtest overfitting, CSCV) | how often the IS-best config lands below the OOS median? | ≤ 0.20 stable, 0.20–0.40 gray |
| **slope** (IS vs OOS perf) | does in-sample strength carry out-of-sample? | only diagnostic when PBO > 0.20 |
| **PSR** | P(true Sharpe > 0) | ≥ 0.95 |
| **MinTRL** | sessions needed to establish the observed Sharpe at 95% | ≤ nSessions |
| **MinBTL** | years below which the annualised Sharpe is selection luck | advisory — per-session returns are far from iid-normal |
| **concentration** | share of net from the top-10 sessions | ≤ 15% good, ≤ 30% gray |

Units: one observation = one session; returns are per-session return-on-risk
(netUsd / riskUsd, 0 when the config did not trade). Trial Sharpes are computed
on the full history (in-sample), so `effective_n_trials` (autocorrelation
heuristic) is used for the deflation — raw count is also reported.

## Known interpretation traps (all observed on real data)

1. **Negative slope + tiny PBO is mechanical, not overfit.** When selection is
   stable the IS-best config is the *same* config in every CSCV combo, so its
   IS and OOS Sharpes are complementary halves of a fixed total — the
   regression slope goes negative by construction. The validator only flags
   the slope when PBO > 0.20.
2. **MinBTL is pessimistic for scalping.** Per-session return-on-risk has
   ~0 autocorrelation and high kurtosis; the iid-normal assumption behind the
   annualised null-max inflates the required years. Read it as a ceiling, not
   a gate.
3. **DSR can be 1.000 while selection is unreliable (momentum case).** The
   family has real edge (observed Sharpe far above the deflated benchmark),
   but the *argmax* config does not transfer — pick on plateaus, not peaks.

## First results (2026-10-04, 649 sessions, 0.95pt, 225 configs each, holdout = last 40)

| Family | Pick | DSR | PBO | observed SR | trials (eff/raw) | holdout (40 sess) | verdict |
|---|---|---|---|---|---|---|---|
| momentum | s0.35_t2.25_x60 (live) | **1.000** | 0.242 | 0.512 | 11/225 | +$328 · 101t · 65.3% · SR 0.48 | edge real · selection gray · holdout PASS |
| expansion | s0.4_t1.75_x45 (frozen argmax) | **1.000** | **0.001** | 1.060 | 25/225 | +$802 · 207t · 72.5% · SR 1.08 | edge real · selection rock-stable · holdout PASS |
| rth | s0.45_t1.75_x45 (doc pick) | **1.000** | **0.003** | 1.153 | 23/225 | +$1,587 · 223t · 74.4% · SR 1.59 | edge real · selection rock-stable · holdout PASS |

All three families pass the frozen single-use holdout. RTH and expansion
selection is far more stable than momentum's (PBO ~0.001-0.003 vs 0.242) —
the higher-frequency families' extra trades pay for themselves in selection
reliability. Momentum's edge is real but its argmax is not — keep
plateau-picking for that family. All three pass concentration (momentum
11.8% top-10; expansion 6.7%; rth 4.7%).

## What still needs work

- **Regime slicing**: per-year is in; add VIX/trend-regime buckets.
- **Ledger count integrity**: raw configs tried (225) understates the real
  trial count — every historical study in `docs/research/*` that swept this
  grid also counts. Decide per family whether pre-pipeline sweeps count
  toward `n_trials` and record the decision in the ledger entry.
- **Holdout re-declaration protocol**: the window is single-use per family;
  when a family's config changes materially, declare a NEW holdout window
  (the old pin documents what it was tested against).
