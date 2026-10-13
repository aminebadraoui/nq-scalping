# RTH quality-gate vs first-3 cap — should the daily card cap be replaced/augmented by a setup-quality gate? (2026-10-13)

> Question: *"Should the live RTH first-3-cards-per-day cap (`RTH_MAX_CARDS_PER_DAY=3`) be replaced or augmented by a setup-quality gate built from the per-card chips?"* CLI: `web/scripts/rthQualityGateStudy.ts` (extension of the named RTH campaign `scripts/rthOptimizer.ts` + the cap studies `scripts/gapOnlyValidation.ts` / `scripts/rthCapScratch.ts`).

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · RTH soft-continuation (SOFT_PROD) |
| Sample | 2023-12-18 → 2026-10-12 · 655 sessions · 10,870 cards fired · 9,063 filled (nocap) |
| Cost model | 0.95 pt round-trip (measured live RTH friction; 0.5/1.0 ladder in T2) |
| Fill model | live-style limit entry (resting at signal price, TTL 9 bars, fill at touch-bar open clamped to the limit) · pessimistic stop-first same-bar exit · 60-bar time exit |
| Exit model | 0.5× stop / 2.5R target / 60-bar time exit (live `rthLimitParams` limit-entry redesign) |
| Split | 70/30 by date: train < 2025-12-10 (458) ≤ OOS 197 sessions (2025-12-10 → 2026-10-12) · frozen rth holdout: n/a (pinned to the exit-config study — single-use) |
| Significance | Wilson 95% CI on WR · DSR/PBO/PSR/MinTRL from `gcdata/validate_sweep.py` (10-config θ-grid) |
| Model (if any) | none (pre-registered weighted chip score, no fitted model) |
| Stack | signals SOFT_PROD · gates default set · risk challengeRules+guardCore (Rapid EOD 50k sim) · fill limit-entry 0.95pt — **varying layer: RTH daily card-selection policy (cap vs quality gate)** |
| CLI | `web/scripts/rthQualityGateStudy.ts` |

**Policies compared** (selection layer only — replay, bracket, cost and sizing frozen):
`first3` (live baseline: first 3 fired cards per day) · `top3` (top 3 per day by score, ties → earlier card) · `theta_θ` (no count cap; every card with score ≥ θ, θ ∈ {−1,0,1,2,3}) · `hyb_θ` (cap 3 AND floor score ≥ θ, θ ∈ {0,1,2}; below-floor cards are skipped **without consuming a cap slot**) · `nocap` (reference: every card).

**Quality score — pre-registered weights from PRIOR studies** (every component computable at card time from the archive; live-only chips — esRs, walls, DOM — excluded by design):

| component | weight | source (prior study, pre-existing) |
|---|---|---|
| targetCrossRound | +1 | round-number study: 78.8% WR / PF 3.41 vs 76.5% / 2.80 (n=509) |
| entryAtRound | −1 | same study: 76.2% vs 76.7% WR, 10% vs 5% stop-run share (n=206, weak) |
| gapInPath (unfilled gap in entry→target path) | −2 | gap-proximity study: 57.1% WR / PF 1.12 (n=35) |
| nearestUnfilledGap | >30 pt or none +1 · 10–30 pt −1 · ≤10 pt 0 | gap study buckets: 81.8% / 73.8% / 77.5% |
| vol/medVol | ≥0.8 +1 · 0.65–0.8 0 · <0.65 −1 | detector's own 0.5× volume gate; partly motivated by the 2026-10-13 incident (see Honest bounds) |
| breakRangeR ≥ 1.5 | +1 | quality-filter-sweep: ATR-range is the best footprint quality gate |
| stopAtRound | **0 (excluded on purpose)** | round-number study FALSIFIED the stop-hunt claim (74.3% vs 76.8%, n=202) |

Score range −5…+4. The replay mirrors the live dispatch exactly: no one-trade-at-a-time block (live dispatches every card), the cap counts fired cards per calendar day (`s.d`), and the same chip helpers the live skip-path uses (`roundNumberChips`, `gapChips` on the bars known through the card bar).

## Results

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| first3 (baseline) — all | 1532 | 34.9% [32.6%–37.3%] | +11.13 | 5.59 | 1.99 | +0.25 | +0.05 | 1.07 | 1.2 | 201.5 | 0.05 | 92.6% |
| first3 (baseline) — train | 1058 | 36.0% [33.2%–38.9%] | +10.80 | 5.45 | 1.98 | +0.40 | +0.08 | 1.12 | 1.6 | 137.8 | 0.07 | 78.3% |
| first3 (baseline) — test | 474 | 32.5% [28.4%–36.8%] | +11.92 | 5.87 | 2.03 | −0.09 | −0.02 | 0.98 | -0.3 | 201.5 | -0.01 | 0.0% |
| top3 — all | 1494 | 34.7% [32.4%–37.2%] | +11.17 | 5.48 | 2.04 | +0.30 | +0.05 | 1.08 | 1.3 | 246.3 | 0.07 | 78.1% |
| top3 — train | 1029 | 35.4% [32.5%–38.3%] | +10.95 | 5.36 | 2.04 | +0.41 | +0.07 | 1.12 | 1.4 | 164.4 | 0.08 | 73.5% |
| top3 — test | 465 | 33.3% [29.2%–37.7%] | +11.67 | 5.75 | 2.03 | +0.05 | +0.01 | 1.01 | 0.2 | 246.3 | 0.04 | 1316.3% |
| theta-1 — all | 9053 | 35.6% [34.6%–36.6%] | +8.15 | 4.35 | 1.87 | +0.09 | +0.01 | 1.03 | 0.6 | 577.4 | 0.06 | 88.0% |
| theta-1 — train | 6402 | 35.5% [34.3%–36.7%] | +7.75 | 4.16 | 1.86 | +0.06 | −0.00 | 1.02 | -0.1 | 577.4 | 0.07 | 157.7% |
| theta-1 — test | 2651 | 35.8% [34.0%–37.7%] | +9.11 | 4.83 | 1.89 | +0.17 | +0.04 | 1.05 | 1.3 | 403.4 | 0.05 | 140.4% |
| theta0 — all | 8684 | 35.6% [34.6%–36.6%] | +8.22 | 4.38 | 1.88 | +0.11 | +0.01 | 1.04 | 0.7 | 526.8 | 0.07 | 78.3% |
| theta0 — train | 6149 | 35.6% [34.4%–36.8%] | +7.82 | 4.18 | 1.87 | +0.09 | +0.00 | 1.03 | 0.2 | 526.8 | 0.08 | 121.5% |
| theta0 — test | 2535 | 35.6% [33.8%–37.5%] | +9.18 | 4.84 | 1.90 | +0.15 | +0.03 | 1.05 | 1.1 | 413.0 | 0.05 | 153.7% |
| theta1 — all | 7766 | 35.5% [34.4%–36.6%] | +8.29 | 4.43 | 1.87 | +0.09 | +0.01 | 1.03 | 0.6 | 501.1 | 0.06 | 95.6% |
| theta1 — train | 5528 | 35.4% [34.2%–36.7%] | +7.94 | 4.25 | 1.87 | +0.07 | +0.00 | 1.03 | 0.1 | 501.1 | 0.06 | 150.9% |
| theta1 — test | 2238 | 35.6% [33.7%–37.6%] | +9.15 | 4.87 | 1.88 | +0.12 | +0.03 | 1.04 | 1.0 | 334.7 | 0.06 | 196.3% |
| theta2 — all | 3771 | 34.7% [33.2%–36.3%] | +9.35 | 4.85 | 1.93 | +0.08 | +0.01 | 1.03 | 0.4 | 305.5 | 0.04 | 174.6% |
| theta2 — train | 2718 | 35.0% [33.3%–36.8%] | +9.07 | 4.71 | 1.93 | +0.12 | +0.02 | 1.04 | 0.5 | 305.5 | 0.04 | 154.3% |
| theta2 — test | 1053 | 34.0% [31.2%–36.9%] | +10.08 | 5.21 | 1.93 | −0.01 | −0.00 | 1.00 | -0.1 | 269.8 | 0.04 | 0.0% |
| theta3 — all | 673 | 32.1% [28.7%–35.7%] | +9.92 | 5.11 | 1.94 | −0.28 | −0.05 | 0.92 | -0.9 | 272.5 | 0.00 | 0.0% |
| theta3 — train | 482 | 32.0% [27.9%–36.2%] | +9.70 | 5.02 | 1.93 | −0.32 | −0.06 | 0.91 | -0.9 | 272.5 | -0.02 | 0.0% |
| theta3 — test | 191 | 32.5% [26.2%–39.4%] | +10.46 | 5.32 | 1.97 | −0.20 | −0.03 | 0.94 | -0.3 | 131.6 | 0.04 | 0.0% |
| hyb0 — all | 1526 | 35.5% [33.2%–38.0%] | +11.20 | 5.58 | 2.01 | +0.38 | +0.07 | 1.11 | 1.7 | 200.4 | 0.07 | 61.9% |
| hyb0 — train | 1055 | 36.0% [33.2%–39.0%] | +10.89 | 5.44 | 2.00 | +0.44 | +0.08 | 1.13 | 1.7 | 129.7 | 0.07 | 70.2% |
| hyb0 — test | 471 | 34.4% [30.2%–38.8%] | +11.91 | 5.88 | 2.02 | +0.24 | +0.04 | 1.06 | 0.6 | 200.4 | 0.06 | 291.2% |
| hyb1 — all | 1524 | 34.9% [32.6%–37.3%] | +11.15 | 5.57 | 2.00 | +0.26 | +0.05 | 1.07 | 1.2 | 179.0 | 0.05 | 89.1% |
| hyb1 — train | 1056 | 35.5% [32.7%–38.4%] | +10.84 | 5.45 | 1.99 | +0.34 | +0.07 | 1.10 | 1.4 | 141.1 | 0.06 | 94.6% |
| hyb1 — test | 468 | 33.5% [29.4%–37.9%] | +11.88 | 5.84 | 2.04 | +0.11 | +0.01 | 1.03 | 0.2 | 179.0 | 0.03 | 630.2% |
| hyb2 — all | 1386 | 34.4% [32.0%–37.0%] | +11.37 | 5.63 | 2.02 | +0.22 | +0.04 | 1.06 | 0.9 | 231.7 | 0.04 | 116.6% |
| hyb2 — train | 961 | 35.4% [32.4%–38.5%] | +11.20 | 5.51 | 2.03 | +0.40 | +0.07 | 1.11 | 1.3 | 184.3 | 0.05 | 83.0% |
| hyb2 — test | 425 | 32.2% [28.0%–36.8%] | +11.81 | 5.89 | 2.00 | −0.19 | −0.03 | 0.95 | -0.4 | 231.7 | 0.01 | 0.0% |
| nocap — all | 9063 | 35.6% [34.6%–36.6%] | +8.15 | 4.35 | 1.87 | +0.10 | +0.01 | 1.04 | 0.7 | 563.4 | 0.06 | 84.3% |
| nocap — train | 6410 | 35.5% [34.3%–36.7%] | +7.75 | 4.16 | 1.86 | +0.07 | −0.00 | 1.03 | -0.1 | 563.4 | 0.07 | 147.0% |
| nocap — test | 2653 | 35.9% [34.1%–37.7%] | +9.09 | 4.83 | 1.88 | +0.17 | +0.04 | 1.05 | 1.3 | 403.4 | 0.05 | 138.6% |

**Train-stage constrained selection (mirrors rthOptimizer's: train eval PASS + train PF ≥ 0.9 × first3):** every policy — **including the live first-3 baseline** — BREACHES the Rapid EOD 50k eval sim on train, so no candidate survives the constraint and the pick falls back to the baseline. Train dollar-sims: first3 $+8,017 BREACH · hyb0 $+8,162 BREACH · theta-1 $−2,087 BREACH · nocap $−1,629 BREACH … (all 11 BREACH).

### T4 — prop-account viability (Rapid EOD 50k)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 1532 | 631 | $7161 | $735 | ✓ | ✓ | 2024-04-30 ($-654) | — | — | breach 2024-04-30 (equity $-654) |
| funded | Rapid EOD 50k | 1532 | 631 | $7161 | $735 | — | — | 2024-04-30 ($-654) | — | 0 | breach 2024-04-30 (equity $-654) |
| eval (test-only) | Rapid EOD 50k | 474 | 193 | $-856 | $735 | — | — | 2026-02-06 ($-2007) | — | — | breach 2026-02-06 (equity $-2007) |
| funded (test-only) | Rapid EOD 50k | 474 | 193 | $-856 | $735 | — | — | 2026-02-06 ($-2007) | — | — | breach 2026-02-06 (equity $-2007) |

`first3` (baseline): P(pass before breach) = **44%** · median days to pass = 80 · maxDD $3,558 = **178% of MLL** (500 reshuffles).

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 1526 | 629 | $10010 | $735 | ✓ | ✓ | 2024-04-30 ($-67) | — | — | breach 2024-04-30 (equity $-67) |
| funded | Rapid EOD 50k | 1526 | 629 | $10010 | $735 | — | — | 2024-04-30 ($-67) | — | 0 | breach 2024-04-30 (equity $-67) |
| eval (test-only) | Rapid EOD 50k | 471 | 192 | $1847 | $735 | — | — | 2026-09-24 ($2167) | — | — | breach 2026-09-24 (equity $2167) |
| funded (test-only) | Rapid EOD 50k | 471 | 192 | $1847 | $735 | — | — | 2026-09-24 ($2167) | — | — | breach 2026-09-24 (equity $2167) |

`hyb0` (best-OOS candidate, test exp +0.24): P(pass before breach) = **53%** · median days to pass = 75 · maxDD $2,949 = **147% of MLL** (500 reshuffles).

### T2 — policy comparison (all sessions, net of 0.95 pt)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | first3 (baseline) | 1532 | 34.9% [32.6%–37.3%] | 1.07 | +0.25 | 36% / 32% | — |
| 2 | top3 | 1494 | 34.7% [32.4%–37.2%] | 1.08 | +0.30 | 35% / 33% | first3 all WR 35% · exp +0.25 |
| 3 | theta-1 | 9053 | 35.6% [34.6%–36.6%] | 1.03 | +0.09 | 35% / 36% | first3 all WR 35% · exp +0.25 |
| 4 | theta0 | 8684 | 35.6% [34.6%–36.6%] | 1.04 | +0.11 | 36% / 36% | first3 all WR 35% · exp +0.25 |
| 5 | theta1 | 7766 | 35.5% [34.4%–36.6%] | 1.03 | +0.09 | 35% / 36% | first3 all WR 35% · exp +0.25 |
| 6 | theta2 | 3771 | 34.7% [33.2%–36.3%] | 1.03 | +0.08 | 35% / 34% | first3 all WR 35% · exp +0.25 |
| 7 | theta3 | 673 | 32.1% [28.7%–35.7%] | 0.92 | −0.28 | 32% / 32% | first3 all WR 35% · exp +0.25 |
| 8 | hyb0 | 1526 | 35.5% [33.2%–38.0%] | 1.11 | +0.38 | 36% / 34% | first3 all WR 35% · exp +0.25 |
| 9 | hyb1 | 1524 | 34.9% [32.6%–37.3%] | 1.07 | +0.26 | 36% / 34% | first3 all WR 35% · exp +0.25 |
| 10 | hyb2 | 1386 | 34.4% [32.0%–37.0%] | 1.06 | +0.22 | 35% / 32% | first3 all WR 35% · exp +0.25 |
| 11 | nocap | 9063 | 35.6% [34.6%–36.6%] | 1.04 | +0.10 | 35% / 36% | first3 all WR 35% · exp +0.25 |

Cost ladder (first3, all sessions): 0.5 pt exp **+0.70** PF 1.21 · 0.95 pt +0.25 PF 1.07 · 1.0 pt +0.20 PF 1.05 — the family's edge is a cost story: it exists at 0.5 pt and degrades to marginal at the measured 0.95 pt.

Hour-of-day diagnostic (filled cards, descriptive — **not** a score component): hour 9 exp +1.04 (n=159) · 10 +0.28 · 11 +0.17 · 12 +0.03 · 13 −0.03 · 14 −0.05 · 15 +0.23.

### T3 — sweep validation (θ-grid, `gcdata/validate_sweep.py`, 458 train sessions)

| pick | DSR | PBO | observed SR | trials (eff/raw) | holdout (n sess) | verdict |
|---|---|---|---|---|---|---|
| first3 | 0.741 | 0.754 | 0.072 | 8 / 10 | OOS 197 sess (2025-12-10 → 2026-10-12) | DSR weak (0.74 < 0.80) · PBO high (0.75 > 0.20) · slope −1.009 · MinTRL 499 > 458 (track record short) |

Sharpe landscape over the 10-config grid: mean 0.057 · max 0.083 · var 0.0009 — the grid is flat; no selection policy is distinguishable from the others at per-session return-on-risk. PSR 0.943 (probabilistic, benchmark 0) but DSR/PBO both fail the deployment bands.

### 2026-10-13 illustration (DB-recorded chips · observational only · NO evidential weight)

| ET | side | entry | score | first3 | top3 | θ≥1 | θ≥2 | hyb(θ≥1) | DB outcome |
|---|---|---|---|---|---|---|---|---|---|
| 10:16 | short | 30786.13 | −1 | ✓ | · | · | · | · | win |
| 10:25 | short | 30773.63 | +0 | ✓ | · | · | · | · | loss |
| 10:59 | short | 30704.75 | +1 | ✓ | ✓ | ✓ | · | ✓ | loss |
| 11:08 | short | 30707.88 | +0 | · | · | · | · | · | win |
| 11:21 | short | 30700.50 | +1 | · | · | ✓ | · | ✓ | win |
| 12:47 | short | 30777.25 | +1 | · | · | ✓ | · | ✓ | win |
| 13:24 | short | 30719.38 | +2 | · | ✓ | ✓ | ✓ | · | win |
| 13:46 | short | 30733.25 | +1 | · | · | ✓ | · | · | win |
| 14:35 | short | 30750.00 | −1 | · | · | · | · | · | win |
| 15:35 | short | 30785.63 | +3 | · | ✓ | ✓ | ✓ | · | win |

Live fill facts (verified, operator record): the 3 executed (first-3) were the day's only losers — 10:16 filled 30787.75, stopped 30792.75 in ~1 s (−$83.30); 10:25 filled +3.62 pts adverse, stopped in 3 s (−$56.40); 10:59 filled +2.75 pts adverse, stopped in 1.2 s (−$43.20). The 7 cap-skipped cards (11:08–15:35) all reached target observationally (+56.6 pts combined).

On this day θ≥2 takes {13:24, 15:35} (both observational wins); θ≥1 takes 6 cards incl. the 10:59 loss; top3 takes {10:59, 13:24, 15:35}; hyb(θ≥1) takes {10:59, 11:21, 12:47}. Two honest observations: (a) the cap did select the day's worst outcome, but (b) the day's losers were **not** chip-poor — 10:59 scored +1 — their failure was adverse limit-fill drift in the first session hour, which the chip score barely sees. The day is one sample and is **not in the archive yet** (last session: 2026-10-12), so it carries zero evidential weight in the study proper.

`VERDICT: edge unproven · significance FAIL (DSR 0.74 · PBO 0.75 · MinTRL 499 > 458) · stability gray (train/test WR 36.0/32.5, θ-grid flat) · holdout n/a (frozen rth holdout pinned to the exit-config study; OOS = last 30% by date) · viability FAIL (P=0.44 baseline · P=0.53 best-OOS)`

## What this falsifies and what it confirms

1. **Falsifies: the quality gate as a validated replacement for the cap.** No θ, top-3, or hybrid config passes the train-stage constrained selection (train eval PASS + PF ≥ 0.9 × baseline) — and neither does the live first-3 baseline itself. The grid is flat (trial Sharpes 0.057±0.029, DSR 0.741, PBO 0.754): at the live limit-entry 0.95-pt friction model, card selection is not the lever that moves the family.
2. **Falsifies (on this archive): the chip score's monotone quality gradient.** θ=3 — the highest-quality tier — is the WORST cell (−0.28 pts/trade all-history, PF 0.92). Chips that were predictive on the momentum family's 1R brackets (round-number, gap-proximity studies) do not transfer to the RTH 0.5×/2.5R limit bracket.
3. **Falsifies (for the current live config): the cap's original justification.** The first-3 cap was adopted from `gapOnlyValidation` (structural 0.75R market entries: +4.28 pts/trade, eval PASS). Under the CURRENT live model (limit entry, 0.5× stop, 2.5R target, 0.95 pt) first-3 is **underwater OOS** (−0.09 pts/trade, PF 0.98) and breaches the eval sim on both train (2024-04-30) and test (2026-02-06).
4. **Confirms the cap's risk-bound role, weakly.** All-history, the capped policies (first3, hyb0/1/2, top3) hold maxDD 179–246 pts vs 272.5–577 pts for the un-capped θ gates and nocap — but capped or not, every policy breaches the prop floor (maxDD 147–178% of MLL), so the bound does not save the account.
5. **Confirms 2026-10-13 was partly a selection failure and partly a fill-drift failure.** The illustration shows a quality gate would have kept most of the day's 7 winners (θ≥1 keeps 5/7, θ≥2 keeps 2) — but the 10:59 loser scores +1 and passes every gate except θ≥2, so the gate does not cleanly excise the day's losers either.
6. **Direction on OOS (weak, not deployable):** every gate variant beats the cap in the OOS window (hyb0 +0.24, nocap +0.17, θ−1 +0.17, top3 +0.05 vs first3 −0.09), i.e. the cap is the worst-performing selection policy OOS — but the differences are within Wilson noise and DSR/PBO refuse to certify any pick.

## Honest bounds

- **The incident day is not in the archive.** The R2 archive ends at session 2026-10-12 (655 sessions); 2026-10-13 has not been uploaded, so the OOS window ends the day BEFORE the incident and the incident appears only as the DB-chips illustration. The study therefore cannot directly OOS-validate any policy on the day that motivated it.
- **Selection fallback:** because no policy passed the train constraint, the "pick" is the baseline by fallback — the study's headline is a null result on the gate, not a certification of first-3 (first-3 itself fails OOS and the sim).
- **Score components are pre-registered from prior studies, but choosing those six components is itself a selection step** (bounded by the 10-config θ/hybrid sweep: DSR 0.741, PBO 0.754 — the grid does not clear the deployment bands). The vol/medVol component is partly motivated by the 2026-10-13 10:16 card; its weight is small and the sweep bounds its influence.
- **Live-only chips excluded:** esRs/esConfirm (ES feed), gamma walls (CBOE daily), and DOM candidates have no historical archive, so a score that includes them cannot be tested here — a future richer score is possible but unfalsifiable offline today.
- **Thin cells:** theta3 test n=191 is the only sub-200 cell; all policies have n ≥ 425 OOS. WR CIs are ±3–6 pts; the OOS expectancy differences (±0.3 pt) sit inside noise.
- **The replay omits the crossed-stop dispatch gate and the 1.75-pt loser drift** used by gapOnlyValidation (its market-entry-era measurement; the limit-fill model already carries structural adverse drift, and adding both would double-count). Numbers therefore differ from the cap's original study by design (same caveat as rthCapScratch).
- **The account sim sizes at $100 budget** (dollarize default) with the 0.5× stop — the same sizing the cap studies used; the prop-failure headline is robust to the choice (maxDD 147–178% of MLL across policies).
- A **Recommendation section was appended** after these bounds (not part of the fixed skeleton) because the study feeds the EXEC_CHANGE_POLICY approval workflow; the skeleton's required sections all appear above in order.

## Recommendation (what the data supports — nothing applied)

1. **Do NOT replace the cap with a quality gate now.** The data do not support a quality-gate mode as a validated change: no gate config passes the train constraint, DSR 0.741/PBO 0.754 fail the deployment bands, and θ has no monotone quality gradient. Proposing a code path (`signalFeed.ts` around line 1878) for a score gate would be an unvalidated live-exec change and is blocked by EXEC_CHANGE_POLICY rule 5.
2. **Keep `RTH_MAX_CARDS_PER_DAY=3` unchanged** as the risk-bound knob. The cap's OOS failure is real but no tested alternative clears the same bar.
3. **If the operator nevertheless wants the least-bad OOS variant while keeping the cap's daily risk bound** (this is a probe candidate, NOT a validated deployment): add `RTH_QUALITY_FLOOR=0` alongside `RTH_MAX_CARDS_PER_DAY=3` — i.e. hybrid θ≥0 + cap 3, below-floor cards skipped without consuming a cap slot (hyb0: train +0.44 / OOS +0.24 vs baseline train +0.40 / OOS −0.09). It still breaches the eval sim (train 2024-04-30, OOS 2026-09-24) and P(pass)=53%, so it needs the full `scripts/rthOptimizer.ts` campaign + owner approval before any env change — and only inside the 16:00–18:00 ET deploy window.
4. **The stronger lever the data point at is the family config, not card selection:** at 0.5 pt the baseline earns +0.70/trade (PF 1.21) and at 0.95 pt it degrades to +0.25 — re-run `scripts/rthDriftOptimizer.ts` / `scripts/rthOptimizer.ts` at the live limit model (fill drift + fees) before touching selection. Out of scope here.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/rthQualityGateStudy.ts
# the run prints its sweep JSON path; then:
cd ../gcdata
./.venv/bin/python validate_sweep.py data/sweeps/rthqg-<stamp>.json --pick first3
```
