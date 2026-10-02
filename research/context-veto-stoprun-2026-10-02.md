# Context vetoes + stop-run study (2026-10-02)

Follow-up on trade-review findings #2 (expansion context filter) and #3
(stop-run clustering). Method: the same 648-session archive (2023-12 →
2026-09), lookahead-free, sequential one-trade-at-a-time replay, first-touch
scoring, 0.5 pt round-trip cost, 60-bar time exit, train/test split
2026-01-01, MFF Rapid EOD 50k account sim. Runners:
`scripts/momentumStudy.ts --mode veto` and `scripts/stopRunStudy.ts`.

## 1. Expansion context vetoes — REJECTED (all variants)

The 22:50 (counter-trend short) and 00:41 (double-top long) losses suggested
three gates: session cumulative-delta agreement, session-VWAP side, and a
swing-extreme (double-top) veto. All measured in the replay:

| Variant | n | WR | PF | expR | Total $ |
|---|---|---|---|---|---|
| exp base | 4,845 | 78.1% | 3.06 | 0.45 | $361,100 |
| exp+cumD | 2,874 | 77.7% | 2.98 | 0.44 | $210,975 |
| exp+vwap | 2,999 | 77.4% | 2.93 | 0.44 | $216,485 |
| exp+both | 2,308 | 77.3% | 2.93 | 0.44 | $166,487 |
| exp+swing.25 | 2,542 | 76.9% | 2.81 | 0.43 | $179,631 |
| exp+swing.5 | 2,492 | 76.8% | 2.81 | 0.43 | $176,014 |

**Every veto removes trades at or ABOVE the survivors' quality.** The removed
subsets had higher win rates than the kept trades (e.g. the swing-vetoed
double-top entries went ~79% — the tape *rewards* a huge one-sided bar at a
clean double top). The huge-bar continuation edge does not care about session
trend, VWAP position, or double tops. The two review losses were in-model
noise, exactly as suspected. `EXP_PROD` stays unchanged; the knobs
(`sessionTrend`, `swingVetoTolPts`) remain for future sweeps.

## 2. Flush-trigger overhead veto — per-trade gain, volume cost

The 21:18 case (breakout into overhead congestion) operationalized as
`requireTrailProgress`: the breakout bar must clear the trailing N-bar high
(long) / low (short):

| Variant | n | WR | PF | expR | Total $ |
|---|---|---|---|---|---|
| mom base | 2,106 | 75.7% | 2.72 | 0.40 | $138,306 |
| mom+trail20 | 1,296 | 77.1% | 2.95 | 0.43 | $91,393 |
| mom+trail60 | 744 | 76.1% | 2.88 | 0.41 | $50,139 |
| mom+trail120 | 543 | 77.5% | 3.25 | 0.44 | $39,330 |

trail20 is the only veto in the whole study that isolates a genuinely worse
subset: the 810 vetoed trades averaged 1.82 pts vs 2.32 for the survivors,
and the vetoed group carried the 21:18-style losses. Per-trade expectancy
improves +7.5%, test PF 3.23 → 3.46. But it removes 39% of flush cards and
33% of flush dollars — at fixed 9-contract sizing that is real income lost.
**Verdict: opt-in quality filter (`requireTrailProgress: true`), not a
default.** trail60/120 cut further with no per-trade gain — reject.

## 3. Stop-run clustering + padding — the 3-of-5 night was noise

Every stopped trade measured for stopDepth (pts probed beyond the stop) and
postStopFav (pts run back in the trade direction over the next 30 bars).
A "stop-run" = depth ≤ 0.75 (stopped at the tick) AND fav ≥ 1R.

- **Stop-runs are 5% of stops** for both triggers — and that share is flat
  at every reversal threshold (0.5R–2R). The 19:15 / 00:41 / 01:27 pattern
  is a small-sample anecdote, not a systematic leak.
- **No hour clustering.** Run share by hour: 00:00 6%, 01:00 5%, 02:00 2%
  vs 5% overall — the 00:00–02:00 ET hypothesis is rejected. (16:00 shows
  13% on 24 stops — the EOD close hour, thin and near-zero dollars.)
- **Padding does not pay, anywhere.** WR and PF degrade monotonically with
  pad size (exp: 78.1/3.06 at 0.5 → 71.7/2.27 at 1.5), per-trade expectancy
  falls (2.48 → 2.03 pts), and the worst-day tail gets WORSE (exp pad 1.0:
  −$974 vs −$704; night 1.5: −$1,190). The hour-conditional night pad
  (00–02 ET) moved net +1.1–1.5% at the cost of WR — noise, with a worse
  tail. The structural stop at pad 0.5 is the measured optimum; the
  "safe ticks come from the 80% hit rates, not from widening" line in the
  playbook is now confirmed by a dedicated sweep.

Side-finding: flush **shorts** are the weakest cell in the whole study
(72.7% WR, PF 2.32 vs flush longs 78.6/3.24) — same disease as the retired
sweep-reclaim fade. A direction/context study for flush shorts is the next
candidate, not stop placement.

## Implemented

- `lib/momentum.ts`: `ExpansionConfig.sessionTrend` ("none"|"cumDelta"|
  "vwap"|"both"), `swingVetoTolPts`, `swingLookback`; `MomConfig.
  requireTrailProgress` + `trailProgBars`; `stopPadNight` on both (the
  hour-conditional pad, off by default). Expansion signals now carry real
  session `cumDelta` / `distVwapPts`.
- `scripts/momentumStudy.ts`: `--mode veto` variant family.
- `scripts/stopRunStudy.ts`: the clustering + pad-sweep runner.
- Tests: 5 new unit tests in `tests/momentum.test.ts` (all 25 pass).
- **Prod configs unchanged** — `EXP_PROD` and `MOM_PROD` behave exactly as
  before; every gate here is opt-in.
