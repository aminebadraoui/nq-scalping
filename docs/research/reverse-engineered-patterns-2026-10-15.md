# Reverse-engineered pattern families — can new footprint patterns capture the "best trades"? (2026-10-15)

> Question: *"Can we reverse-engineer the recent price action and footprint
> data into strategies that would have captured the best trades the current
> stack missed (the PPI crash day, the V-morning, the RTH limit no-fills)?
> Which of those patterns survive the full archive?"*
> CLI: `web/scripts/reverseEngineerStudy.ts` + `web/scripts/reverseEngineerExhibit.ts`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (full session, footprint + OHLC twin) |
| Sample | 2023-12-18 → 2026-10-13 · 656 sessions (manifest) · families A–E, 12 arms |
| Cost model | 0.5 pt round-trip, inside the P&L (engine standard) |
| Fill model | market at the trigger close (`scoreTrade`) · pessimistic same-bar exit · stop-first; limit arms = resting limit fill-or-better at bar open (local replay, same convention as rthLimitFillDriftStudy) |
| Exit model | 1R target (A/B/D/E) / SOFT_PROD structural 0.75R (C) · stop · 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01, 472 sess; test ≥, 184 sess) |
| Significance | Wilson 95% CI on WR · no grid sweep → no DSR/PBO (T3 n/a) |
| Model (if any) | none (five hand-designed pattern detectors, not fitted models) |
| Stack | new detectors only · risk `challengeRules`+`guardCore` (propViability) · $100-budget sizing — NOTHING live changed |
| CLI | `web/scripts/reverseEngineerStudy.ts` · exhibit `web/scripts/reverseEngineerExhibit.ts` |

**The five families** (each mined from the missed-beautiful-trades audit,
`docs/research/missed-beautiful-trades-2026-10-15.md`):

- **A. shockBarContinuation** — the 08:30 ET bar ≥ X pts (the CPI/PPI-shock
  proxy, data-driven, no calendar); trade its delta sign at the 08:41 ET
  close (past the 10-min news blackout), stop 1×ATR14, target 1R.
- **B. failedBreakdownReclaim** — a sell-frac ≥ 70% flush that makes a REAL
  new session low, then within 6 bars a buy-frac ≥ Y bar clears the flush
  high → long at the reclaim close; stop = flush low − 0.5 (3.5 floor);
  target 1R. Mirror for shorts. (The V-morning pattern.)
- **C. trendMarketRTH** — SOFT_PROD cards gated by session cumulative-delta
  agreement (|cumD| ≥ Z, sign match), marketable at the close, structural
  0.75R bracket; plus two honest fill-model arms: `@dispatch-tape` (next-bar
  mid, signal-anchored brackets) and `@limit` (live limit mechanics, 0.5×
  stop, 2.5R target, TTL 9).
- **D. firstBigBarContinuation** — the session's FIRST bar with range ≥ X
  pts; trade its delta sign at the close, stop 1×ATR14, target 1R; plus a
  `@limit` harvest arm (flushLimit mechanics, TTL 9).
- **E. flushLimitHourFilter** — MOM_PROD flush cards replayed with the live
  flushLimit mechanics, split by entry hour (evening 18:00–01:59 ET vs core
  02:00–09:29 ET).

## Results

### A — shock-bar continuation (the CPI/PPI-day proxy)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A primary (A100) | 47 | 42.6% [29.5%–56.7%] | +34.98 | 36.37 | 0.96 | −6.01 | −0.16 | 0.71 | −1.1 | 354.5 | −0.04 | 0.0% |
| A train | 33 | 42.4% [27.2%–59.2%] | +37.44 | 33.72 | 1.11 | −3.53 | −0.17 | 0.82 | −1.0 | 258.8 | −0.04 | 0.0% |
| A test | 14 | 42.9% [21.4%–67.4%] | +29.24 | 42.68 | 0.69 | −11.86 | −0.16 | 0.51 | −0.6 | 204.5 | −0.04 | 0.0% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | A shock≥75pts | 75 | 40.0% [29.7%–51.3%] | 0.66 | −6.54 | 40% / 39% | A100 WR 42.6% · PF 0.71 |
| 2 | A shock≥100pts | 47 | 42.6% [29.5%–56.7%] | 0.71 | −6.01 | 42% / 43% | — |
| 3 | A shock≥150pts | 20 | 45.0% [25.8%–65.8%] | 0.71 | −7.06 | 56% / 0% | A100 WR 42.6% · PF 0.71 |

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 47 | 47 | $−618 | $111 | ✗ | ✓ | — | — | — | `no-pass · $−618 · consist ✗` |

`VERDICT: edge absent · significance — (n<100 per arm) · stability n/a · holdout n/a · viability FAIL (P=0.00)`

**A is rejected.** The 08:30-shock continuation loses money in every
window and every threshold — the post-shock tape mean-reverts more often
than it continues. The PPI crash day was the tail, not the rule: even on
10-14 itself the A-arm got stopped on the bounce (−41.8) before the
second leg down.

### B — failed-breakdown reclaim (the V-morning pattern)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B primary (B070) | 448 | 62.3% [57.7%–66.6%] | +7.62 | 8.54 | 0.89 | +1.53 | +0.16 | 1.47 | 3.5 | 94.5 | 0.14 | 58.1% |
| B train | 340 | 62.1% [56.8%–67.1%] | +6.18 | 8.00 | 0.77 | +0.80 | +0.15 | 1.26 | 2.9 | 94.5 | 0.13 | 83.3% |
| B test | 108 | 63.0% [53.6%–71.5%] | +12.11 | 10.28 | 1.18 | +3.82 | +0.19 | 2.00 | 2.0 | 62.8 | 0.19 | 89.1% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | B reclaim bf≥0.70 | 448 | 62.3% [57.7%–66.6%] | 1.47 | +1.53 | 62% / 62% | — |
| 2 | B reclaim bf≥0.80 | 101 | 61.4% [51.6%–70.3%] | 1.38 | +1.22 | 64% / 54% | B070 WR 62.3% · PF 1.47 |

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 448 | 314 | $6,712 | $261 | ✓ | ✓ | — | 2025-07-30 ($3,056) | — | `PASS 2025-07-30 · consist ✓` |
| eval (test-only) | Rapid EOD 50k | 108 | 79 | $1,848 | $230 | — | — | — | — | — | `no-pass (test-only, target not reached in window)` |

P(pass before breach) = 100% · median days to pass = **132** · maxDD **$1,427 = 71% of MLL** (500 reshuffles)

`VERDICT: edge real · significance PASS · stability stable (train/test 62.4/62.0) · holdout n/a · viability weak (P=1.00 but 71% MLL DD · 132d median pass · conc 66%)`

**B is real but weak.** The V-reclaim fades exist and are stable
(train/test 62/63, per-year PF 1.21 → 1.35 → 2.00 improving), but the
edge is session-heavy (top-10 = 58% of net on the primary arm, 66% across
arms), the drawdown rides the MLL line (71%), and it pays out slowly
(median 132 days). A seasoning for a label or a forward log — not a
standalone strategy. Same close-fill caveat as everything marketable.

### C — trend-gated marketable RTH (the one-way-tape question)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| C primary (C500, close-fill) | 2,148 | 84.1% [82.5%–85.6%] | +5.96 | 8.51 | 0.70 | +3.67 | +0.40 | 3.71 | 29.2 | 66.5 | 1.05 | 4.6% |
| C train | 1,586 | 84.6% [82.7%–86.2%] | +5.65 | 7.91 | 0.71 | +3.56 | +0.41 | 3.91 | 25.6 | 66.5 | 1.16 | 5.9% |
| C test | 562 | 82.9% [79.6%–85.8%] | +6.86 | 10.04 | 0.68 | +3.97 | +0.39 | 3.31 | 14.2 | 57.6 | 0.85 | 14.8% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | C ungated (baseline) | 2,851 | 84.2% [82.8%–85.5%] | 3.86 | +3.80 | 85% / 83% | C500 WR 84.1% · PF 3.71 |
| 2 | C cumD≥300 | 2,232 | 84.1% [82.5%–85.6%] | 3.73 | +3.69 | 84% / 83% | C500 WR 84.1% · PF 3.71 |
| 3 | C cumD≥500 | 2,148 | 84.1% [82.5%–85.6%] | 3.71 | +3.67 | 85% / 83% | — |
| 4 | C cumD≥800 | 2,013 | 84.2% [82.5%–85.7%] | 3.70 | +3.65 | 85% / 83% | C500 WR 84.1% · PF 3.71 |
| 5 | **C cumD≥500 @dispatch-tape** | 1,704 | **67.7%** [65.4%–69.8%] | **1.13** | **+0.22** | 68% / 66% | C500 WR 84.1% · PF 3.71 |
| 6 | **C cumD≥500 @limit** | 1,965 | **33.3%** [31.2%–35.4%] | **1.05** | **+0.15** | 34% / 33% | C500 WR 84.1% · PF 3.71 |

`VERDICT: edge real on the idealized fill only · significance PASS · stability stable · holdout n/a · viability PASS (close-fill only) — NOT harvestable (tape-fill PF 1.13 · limit-fill PF 1.05)`

**C is the honest centerpiece.** The trend gate itself is nearly free as a
quality label: removing counter-trend cards (2,851 → 2,148) leaves WR/PF
essentially unchanged, so `cumD-agreement` is a cheap journal label, not a
new edge. The big number (84.1% / PF 3.71) exists ONLY on the idealized
close fill — and the two drift-aware fill models kill it exactly the way
the flush and RTH studies predicted: `@dispatch-tape` PF 1.13, `@limit`
PF 1.05. **The trend gate does not fix the chase problem.** No new entry
mechanism for one-way tapes exists in the footprint data beyond the
resting-limit family already live.

### D — first big-bar continuation (the macro-day capture machine)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| D primary (D100, close-fill) | 149 | 76.5% [69.1%–82.6%] | +27.07 | 23.58 | 1.15 | +15.17 | +0.51 | 3.74 | 7.3 | 99.7 | 0.25 | 21.8% |
| D train | 86 | 76.7% [66.8%–84.4%] | +25.44 | 23.06 | 1.10 | +14.16 | +0.51 | 3.64 | 5.6 | 99.7 | 0.23 | 35.6% |
| D test | 63 | 76.2% [64.4%–85.0%] | +29.30 | 24.27 | 1.21 | +16.55 | +0.50 | 3.86 | 4.7 | 66.8 | 0.31 | 42.3% |

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | D first≥100pts | 149 | 76.5% [69.1%–82.6%] | 3.74 | +15.17 | 77% / 76% | — |
| 2 | D first≥150pts | 56 | 87.5% [76.4%–93.8%] | 5.49 | +22.70 | 86% / 89% | D100 WR 76.5% · PF 3.74 |
| 3 | D first≥200pts | 18 | 83.3% [60.8%–94.2%] | 2.83 | +18.25 | 83% / 83% | D100 WR 76.5% · PF 3.74 |
| 4 | D first≥100pts @limit | 107 | 57.0% [47.5%–66.0%] | 1.42 | +4.63 | 52% / 62% | D100 WR 76.5% · PF 3.74 |

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 149 | 149 | $5,604 | $136 | ✓ | ✓ | — | 2025-11-20 ($3,092) | — | `PASS 2025-11-20 · consist ✓` |
| funded | Rapid EOD 50k | 149 | 149 | $5,604 | $136 | — | — | — | — | 8 | `equity $5,604 · payouts 8 · floor $3,685 (locked)` |
| eval (test-only) | Rapid EOD 50k | 63 | 63 | $2,333 | $136 | — | — | — | — | — | `no-pass (target not reached in test window alone)` |

P(pass before breach) = 100% · median days to pass = **78** · maxDD **$315 = 16% of MLL** (500 reshuffles)

`VERDICT: edge real · significance weak (n=149) · stability stable (train/test 76.7/76.2) · holdout n/a · viability gray (P=1.00 · 16% MLL DD · 78d median pass)`

**D is the discovery.** The session's first ≥100-pt bar, continued in its
delta direction at 1×ATR risk, is positive every year (PF 2.13 → 5.19 →
3.86), stable train/test, tiny MLL usage (16%), and it is the ONLY family
that actually captured both macro days in the exhibit: **PPI crash day
+28.5 pts in 1 bar, V-morning +29.0 pts in 1 bar** (and one honest loss on
10-08). Caveats that keep it a proposal: one trade per ~1.1 weeks (n=149),
concentration 22–42% (red band), 1×ATR stops ≈ 29 pts (1 micro at the
$100 budget), and the close-fill caveat — the harvestable `@limit` version
keeps only a third of the edge (+4.63 pts, PF 1.42, train WR 52% thin).
Forward-log candidate, not a deployment.

### E — flushLimit hour filter (the evening question)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | E evening 18:00–01:59 | 940 | 58.5% [55.3%–61.6%] | 1.19 | +0.43 | 55% / 66% | all-hours WR 59.6% · PF 1.22 |
| 2 | E core 02:00–09:29 | 388 | 62.1% [57.2%–66.8%] | 1.31 | +0.67 | 61% / 64% | all-hours WR 59.6% · PF 1.22 |

**E is label-grade.** The flush family's edge sits in the core overnight
hours (02:00–09:29 ET: 62.1%, PF 1.31) more than the evening leg (58.5%,
PF 1.19, and the evening train/test gap 55/66 is unstable). Mild, and it
says nothing about entry mechanics — a journal label at most. (As a
standalone strategy E re-breaches in this replay's sequencing: breach
2025-08-22, maxDD 139% of MLL — the hour split is the finding, not the
family as a new strategy; momentumEntryMechanics owns the canonical
flushLimit numbers.)

### The exhibit — which missed trades would each family have captured (10-08 → 10-15, labeled, n small)

| session | family card | replay outcome | the missed-beautiful counterpart |
|---|---|---|---|
| 10-14 (PPI) | D short @30,747.63 (the 210-pt bar, 08:30 ET) | **target +28.5 pts, 1 bar** | the whole crash afternoon the stack missed |
| 10-14 | A short @30,579.38 (08:41) | stop −41.8 (bounce) | A loses even on the crash day |
| 10-15 (V-day) | D short @29,780.50 (08:30 ET flush) | **target +29.0 pts, 1 bar** | the 09:30 open cascade |
| 10-15 | A short @29,836.00 (08:41) | target +40.5 pts, 9 bars | the flush extension to 29,622 |
| 10-12 | C long @30,929.75 (11:42) | **target +10.0 pts, 2 bars** | the missed-beautiful +17.5 card the limit family no-filled |
| 10-13 | C long @30,765.50 (12:24) | target +9.8 pts, 6 bars | — |
| 10-08 | D long @31,275.00 (12:17, the 117-pt bar) | stop −18.4 | D's honest loss |
| 10-14 | E flushLimit 01:45 short / 04:50 short | +6.0 / +5.1 | the two live chase cards |

## What this falsifies and what it confirms

1. **Confirms: the patterns ARE in the footprint data.** First-big-bar
   continuation (D) found the two macro days with +28.5/+29.0 one-bar
   wins; the failed-breakdown reclaim (B) is a stable 62% pattern; the
   cumD-agreement gate is a free quality label on RTH cards.
2. **Falsifies: shock-bar continuation (A) has no edge** — the 08:30-shock
   continuation is a coin flip with big brackets (−6 pts/trade); the PPI
   day was an outlier, not a rule, and A even lost on it.
3. **Confirms the repo's central wall, now from the other side:** every
   family that needs a marketable entry decays to nothing under the
   drift-aware fill models (C: PF 3.71 → 1.13; D: +15.2 → +4.6 pts via
   limit). The edge lives in the one bar after the signal; the vendor's
   32–57 s confirmation lag makes it structurally unreachable at dispatch.
   **Reverse-engineering the data could not find a fill mechanism better
   than the resting-limit family already live** — it found patterns, not
   a harvest upgrade.
4. **Confirms the limit-family tradeoff quantitatively.** D@limit keeps
   ~30% of D's edge (+4.63 pts, PF 1.42) — the same ratio class as
   flushLimit vs its perfect arm. Resting limits are the only honest
   harvest, and they harvest a third.

## Honest bounds

- **n limits:** A/D arms are 18–149 trades (below the 200-trust floor;
  D150/D200 are † cells), B is 448, only C/E are large-n. The D verdict
  is "real but thin" — one trade per ~1.1 weeks, concentration in the red
  band.
- **Close-fill arms are idealized** (the engine's market-at-close model,
  explicitly flagged): A/B/C/D primary numbers assume a fill at the
  trigger close that the live stack cannot deliver; the drift-aware arms
  (C500T/C500L/D100L) are the honest readings and are the ones the
  verdicts lean on.
- **No DSR/PBO (T3 n/a):** no parameter grid was selected-then-validated;
  threshold arms are shown as T2 cells only. Thresholds were chosen from
  the exhibit, not fit on train — but they are still single picks.
- **The exhibit is n=6 sessions** — a labeled illustration, never a
  cohort; 10-14/10-15 use vendor pulls taken at audit time (10-15 is the
  partial in-progress session).
- **Detector divergence:** on 10-14 the settled vendor tape does not
  reproduce the live 12:10/13:26/13:50 RTH shorts, so C's crash-day
  capture is unmeasurable on that day — measured on the archive instead.
- **Sequencing:** one-position-at-a-time with 60-bar occupancy per family;
  families are evaluated independently (they would share one account live).

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/reverseEngineerStudy.ts
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/reverseEngineerExhibit.ts
```

## Proposals (NOTHING applied — per EXEC_CHANGE_POLICY)

1. **Forward-log D (first big-bar continuation) + D@limit** as journal-only
   cards for several sessions, comparing the marketable and limit harvest
   on the live tape (the only honest next step for a real-but-thin edge).
2. **Add the cumD-agreement label** to RTH cards (journal chip, never a
   gate — the gate is free but the fill models show it buys no harvest).
3. **Do NOT adopt A** (absent edge), and treat B as a label/forward-log
   seasoning at most (66% concentration, 71% MLL drawdown).
4. If D forward-logs well, a dedicated drift-sensitivity study
   (momentumEntryMechanics discipline) before any live consideration —
   and even then only with explicit owner approval per policy.

*Educational research only — not financial advice.*
