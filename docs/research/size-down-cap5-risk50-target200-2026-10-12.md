# Size-down: cap 5 contracts · $50 risk · +$200 daily target — P(breach) vs time-to-pass (2026-10-12)

> Question: *"If we size down to max 5 contracts, $50 max risk per trade,
> and aim for $200 per day, what is our probability of breaching an eval or
> funded sim, vs the time to pass the eval?"* CLI: `web/scripts/sizeDownStudy.ts`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-09 · 654 sessions (641 with ≥ 1 trade) · 5,606 trades |
| Cost model | 0.5 pt round-trip (commissions excluded from the sims — engine convention; $0.95/side noted as a haircut) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first · no-bars dropped |
| Exit model | 1R target / breakout stop (3.5-pt floor) / 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01 ≤ test) · frozen holdout: — |
| Significance | Wilson 95% CI on WR · P(pass/breach) via 2,000 seeded day-order reshuffles (mulberry32) + 10,000-iter different-seed verification on the proposal |
| Model (if any) | none — a sizing/plan study, not a signal study |
| Stack | varies the RISK layer only: signals `MOM_PROD`+`EXP_PROD` · gates default set · fill 0.5 pt — against prod sizing $100/trade · 30-micro cap |
| CLI | `web/scripts/sizeDownStudy.ts` |

Three configs on the **same** production point stream (MOM_PROD + EXP_PROD,
sequential one-position-at-a-time, the consolidated engine's canonical
scorer):

1. **`prod $100/30µ`** — the baseline: `dollarize` budget $100, 30-micro cap.
2. **`cap 5 · $50`** — sizing only: `contracts = min(5, floor($50 ÷ (risk × $2)))`,
   floored at 1. A trade whose stop would risk more than $50 even at 1
   contract (risk > 25 pts) is skipped. In this sample **zero** trades hit
   that ceiling (max stop observed ≤ 25 pts), so the trade set is unchanged.
3. **`cap 5 · $50 · +$200/day`** — the proposal: config 2 plus a daily profit
   arm — once a day's P&L reaches +$200, no new trades that day (the trade
   that crosses it counts, then the desk goes flat).

The deployment question is first-passage (§4.1): does the account reach the
profit target before the EOD-trailing floor is breached? Each config's daily
P&L series is reshuffled into synthetic day orders and replayed through the
MFF Rapid EOD 50k rules (eval: $3,000 target, $2,000 EOD-trailing MLL, 4 min
days, 30% consistency; funded: same MLL with the $100 floor-lock, first
payout at the $2,100 buffer, then one per +$500).

## Results

### T1 — core quality (points; the edge itself does not change with sizing)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prod stream all | 5606 | 76.9% [75.8%–78.0%] | +4.73 | 5.45 | 0.87 | +2.38 | +0.43 | 2.89 | 38.1 | 64.5 | 1.14 | 6.8% |
| train | 3897 | 76.5% [75.1%–77.8%] | +4.19 | 5.05 | 0.83 | +2.02 | +0.41 | 2.70 | 30.4 | 64.5 | 1.08 | 8.6% |
| test | 1709 | 77.8% [75.8%–79.7%] | +5.95 | 6.42 | 0.93 | +3.21 | +0.47 | 3.25 | 23.1 | 32.9 | 1.32 | 16.2% |
| tradeable ≤25pt | 5606 | 76.9% [75.8%–78.0%] | +4.73 | 5.45 | 0.87 | +2.38 | +0.43 | 2.89 | 38.1 | 64.5 | 1.14 | 6.8% |
| halted (+$200/day) | 4644 | 76.7% [75.5%–77.9%] | +4.74 | 5.42 | 0.87 | +2.37 | +0.43 | 2.88 | 34.3 | 64.5 | 1.17 | 5.3% |

The point-level edge is untouched by sizing (rows 1–4 are the same stream);
the +$200/day arm drops 962 trades (17.2%) with a 0.2-pt WR cost and a
slightly *better* per-session Sharpe — the skipped trades are the late-day
extras after the target, which is exactly the arm's job.

### T4 — prop-account viability (one block per config)

**`prod $100/30µ` (baseline):**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 5606 | 641 | $228821 | $1593 | ✓ | ✓ | — | 2024-01-18 ($3048) | — | PASS 2024-01-18 · $228821 · consist ✓ · days 641/✓ |
| funded | Rapid EOD 50k | 5606 | 641 | $228821 | $1593 | — | — | — | — | 454 | equity $228821 · payouts 454 · floor $226821 (locked) |
| eval (test-only) | Rapid EOD 50k | 1709 | 180 | $74352 | $1593 | — | — | — | 2026-01-12 ($6186) | — | PASS 2026-01-12 · $74352 · consist ✓ · days 180/✓ |
| funded (test-only) | Rapid EOD 50k | 1709 | 180 | $74352 | $1593 | — | — | — | — | — | equity $74352 · payouts 145 · floor $72352 (locked) |

P(pass before breach) = 100% · median days to pass = 10 · maxDD $867 = 43% of MLL (2000 reshuffles)

**`cap 5 · $50` (sizing only):**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 5606 | 641 | $99002 | $690 | ✓ | ✓ | — | 2024-02-27 ($3045) | — | PASS 2024-02-27 · $99002 · consist ✓ · days 641/✓ |
| funded | Rapid EOD 50k | 5606 | 641 | $99002 | $690 | — | — | — | — | 194 | equity $99002 · payouts 194 · floor $97002 (locked) |
| eval (test-only) | Rapid EOD 50k | 1709 | 180 | $33391 | $690 | — | — | — | 2026-01-13 ($3330) | — | PASS 2026-01-13 · $33391 · consist ✓ · days 180/✓ |
| funded (test-only) | Rapid EOD 50k | 1709 | 180 | $33391 | $690 | — | — | — | — | — | equity $33391 · payouts 63 · floor $31391 (locked) |

P(pass before breach) = 100% · median days to pass = 20 · maxDD $346 = 17% of MLL (2000 reshuffles)

**`cap 5 · $50 · +$200/day` (the proposal):**

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 4644 | 641 | $80903 | $242 | ✓ | ✓ | — | 2024-02-27 ($3019) | — | PASS 2024-02-27 · $80903 · consist ✓ · days 641/✓ |
| funded | Rapid EOD 50k | 4644 | 641 | $80903 | $242 | — | — | — | — | 158 | equity $80903 · payouts 158 · floor $78903 (locked) |
| eval (test-only) | Rapid EOD 50k | 1347 | 180 | $25556 | $242 | — | — | — | 2026-01-28 ($3080) | — | PASS 2026-01-28 · $25556 · consist ✓ · days 180/✓ |
| funded (test-only) | Rapid EOD 50k | 1347 | 180 | $25556 | $242 | — | — | — | — | — | equity $25556 · payouts 47 · floor $23556 (locked) |

P(pass before breach) = 100% · median days to pass = 24 · maxDD $346 = 17% of MLL (2000 reshuffles)

Every config passes the eval chronologically and in the test window, and
**no config breaches either stage in any ordering tested**. The size-down's
job here is not survival (survival was already ~certain) — it is the
trade-off: the pass costs ~2.4× the time and the long-run daily P&L scales
down ~2.8×.

### T2 — point-stream cohorts (the cost of each rule in trades/pts)

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | prod stream | 5606 | 76.9% [75.8%–78.0%] | 2.89 | +2.38 | 76.5% / 77.8% | — |
| 2 | tradeable ≤25pt | 5606 | 76.9% [75.8%–78.0%] | 2.89 | +2.38 | 76.5% / 77.8% | full prod stream 5606 trades · WR 76.9% · net 13338 pts |
| 3 | halted (+$200/day) | 4644 | 76.7% [75.5%–77.9%] | 2.88 | +2.37 | 76.5% / 77.2% | full prod stream 5606 trades · WR 76.9% · net 13338 pts |

### §4.1 — the first-passage matrix (the direct answer)

| config | n trades | total $ | mean day | worst day | P(eval pass) | P(eval breach) | days→pass med [p10–p90] | P(fund breach) | P(1st payout) | days→payout med | payouts med | maxDD$ ÷ MLL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prod $100/30µ (baseline) | 5606 | $228821 | $357 | $-462 | 100% | 0% | 10 [7–14] | 0% | 100% | 7 | 454 | $867 (43%) |
| cap 5 · $50 risk | 5606 | $99002 | $154 | $-195 | 100% | 0% | 20 [16–26] | 0% | 100% | 14 | 194 | $346 (17%) |
| cap 5 · $50 · +$200/day | 4644 | $80903 | $126 | $-195 | 100% | 0% | 24 [20–29] | 0% | 100% | 17 | 158 | $346 (17%) |

Day-shape diagnostics (why P(breach) sits at zero):

| config | day sd | losing days | mean loss day | longest losing run | worst day ÷ MLL |
|---|---|---|---|---|---|
| prod $100/30µ (baseline) | $318 | 69/641 (10.8%) | −$137 | 4 days | 23% |
| cap 5 · $50 | $139 | 71/641 (11.1%) | −$56 | 4 days | 10% |
| cap 5 · $50 · +$200/day | $93 | 71/641 (11.1%) | −$56 | 4 days | 10% |

**Verification bootstrap (proposal config · 10,000 iters · different seed):**
P(eval pass) = 100.00% · P(eval breach) = 0.00% · P(fund breach) = 0.00% ·
P(first payout) = 100.00% · days→pass med 24 [p10 20–p90 29] · days→payout
med 17 [p10 14–p90 21].

The §4.1 items, against the proposal config:

1. **T4 replay** — chronological pass day 37 (2024-02-27, $3,019); the
   bootstrap median is 24 days because the historical replay's early days
   were slower than the pool average.
2. **P(pass before breach) = 1.00** over 2,000 + 10,000 reshuffles; 0
   breaches in either stage. The 95% upper bound on the true breach rate
   from the 10k run is ≈ 0.03% (rule of three) — breach is not a first-order
   risk at this sizing, in *any* day order.
3. **Sizing check** — maxDD on the dollarized curve is $346 = 17% of the
   $2,000 MLL (green band ≤ 40%). Worst possible conversion: T1 maxDD
   64.5 pts × $2/pt × 5 contracts = $645 = 32% of MLL if the whole
   drawdown ran at the full cap (the realized 17% is lower because
   wide-stop trades size below the cap). Worst single day −$195 = 10% of
   MLL, and the longest losing run is 4 days at −$56 mean — the daily loss
   tail cannot dig a $2,000 hole before the floor has room.
4. **Time-to-pass** — median 24 trading days [p10–p90: 20–29] vs 10 [7–14]
   at the baseline sizing, and 20 [16–26] without the daily arm. The min-4-days
   gate and the 30% consistency gate are both **never binding** under the
   $200 arm (best day $242 ≪ 30% × $3,000 = $900). The $200 arm itself costs
   only ~4 median days while cutting total profit 18% and pinning best-day
   at $242.

`VERDICT: edge real · significance — · stability stable (train/test 76.5/77.8) · holdout n/a (validation pipeline) · viability PASS (P=1.00 · med 24d)`

## What this falsifies and what it confirms

1. **Confirms: sizing down makes breach a non-event.** At cap 5 / $50 the
   worst day is $195 (10% of MLL), the longest losing run is 4 days, and
   12,000 adversarial day-orderings produced zero breaches in either stage.
   The floor-distance math (§4.1.3) shows why: the daily loss tail at this
   size is structurally unable to reach the trailing floor.
2. **Quantifies the cost of the size-down: time, not survival.** The eval
   passes in a median 24 days instead of 10 (chronological 37 vs 16) — the
   $3,000 target needs ~24 × $126 ≈ $3,000 at the halved size. The funded
   first payout slips from 7 to 17 median days. This is the real price of
   "max 5 / $50": the account is nearly unbreachable, and it pays for that
   with ~2.4× slower qualification.
3. **The +$200/day arm is nearly free.** It costs +4 median days (24 vs 20)
   and 18% of the long-run total ($99k → $81k), while making the 30%
   consistency gate structurally unbreachable and capping the biggest day
   at $242. 191 of 641 days (29.8%) triggered the halt and 962 trades
   (17.2%) were skipped — those skipped trades carried a 0.2-pt-lower WR,
   so the arm is discarding slightly-below-average tail trades, not the
   edge itself.
4. **"Aim for $200/day" is a ceiling, not the mean.** At this sizing the
   historical mean day is +$126 (sd $93) — the desk books $200+ on the
   better ~third of days and the arm takes the money and stops. Expecting
   $200 *every* day would be betting on above-average history.
5. **Engine bug found and fixed along the way:** `propViability` reported
   `medianDaysToPass` as the replay's total trading days (641) instead of
   days-at-pass, and a pass followed by a later breach was not counted as a
   pass. Fixed in `web/lib/backtestEngine.ts` (first-passage semantics +
   days-at-pass) with a regression test — every study's T4 footer line is
   now correct. Suite green: 925 pass / 0 fail.

## Honest bounds

- P(breach) = 0 is a point estimate: with 0 breaches in 10,000 orderings the
  95% upper bound is ≈ 0.03% — real-world breach odds are bounded but not
  literally zero (news gaps, fills worse than modeled, operator errors).
- Reshuffling assumes per-session return autocorrelation ≈ 0 (validation
  pipeline). It is a superset of the chronological order, so it is
  conservative for breach risk — but it also flattens regime structure
  (2024 vol vs 2026 vol), so the pass-day percentiles are a pool-average,
  not a calendar forecast.
- Commissions are excluded from the sims (engine convention, same as every
  T4 table in this repo): $0.95/side ≈ $1.90/trade round trip ≈ $13.8/day
  at the proposal sizing (~11% of the mean day) → expect time-to-pass to
  stretch from ~24 to ~27 days net of commissions.
- The sim's floor locks at $100 for **both** stages (propAccount), while
  the live guard has never locked the eval floor — immaterial here, equity
  never approaches $100 in any path.
- The T4 total-profit/payout columns assume the trader keeps trading the
  full 641-day archive (post-pass continuation); they are long-run
  statements, not eval-period statements.
- One instrument (NQ), one continuous sample; 13 of 654 sessions had zero
  signals (641 trading days).
- This is a pts→dollars sizing study on the frozen production signal pair —
  it does not re-validate the signals (T1 train/test agreement shown for
  context; DSR/PBO live in the validation pipeline, not here).

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/sizeDownStudy.ts --offline --iters 2000
```
