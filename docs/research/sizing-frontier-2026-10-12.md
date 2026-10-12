# Risk-sizing frontier — the fastest breach-proof profile (2026-10-12)

> Question: *"What risk sizing and profile balance time-to-pass against
> breach risk — with breach made effectively impossible?"*
> CLI: `web/scripts/sizeDownStudy.ts --sweep`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-09 · 654 sessions (641 with ≥ 1 trade) · 5,606 trades |
| Cost model | 0.5 pt round-trip (commissions excluded from sims — engine convention; $0.95/side noted as haircut) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first · no-bars dropped |
| Exit model | 1R target / breakout stop (3.5-pt floor) / 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01 ≤ test) · frozen holdout: — |
| Significance | Wilson 95% CI on WR (T1) · per-cell P(pass/breach) over 500 seeded day-order reshuffles · 10,000-iter different-seed verification on the picked cell |
| Model (if any) | none — a risk-layer grid, not a signal study |
| Stack | varies the RISK layer only: signals `MOM_PROD`+`EXP_PROD` · gates default set · fill 0.5 pt — the production point stream from `sizeDownStudy.ts` |
| CLI | `web/scripts/sizeDownStudy.ts --sweep` |

The grid: **10 risk budgets × 10 contract caps × 4 daily arms = 400 cells**.

- budget $ ∈ {25, 40, 50, 60, 75, 100, 125, 150, 200, 250} — hard dollar
  ceiling: `contracts = min(cap, floor($ ÷ (risk × $2)))`, floored at 1;
  a stop that would risk more than the budget even at 1 contract is skipped.
- cap ∈ {2, 3, 4, 5, 6, 8, 10, 15, 20, 30} micros.
- daily arm ∈ {off, +$200, +$300, +$400} — stop taking new trades once the
  day's P&L reaches the target.

Every cell replays the same 5,606-trade production stream (MOM_PROD +
EXP_PROD, sequential, canonical engine scorer), dollarizes it, and runs
the §4.1 first-passage bootstrap on both stages: P(eval pass), P(eval
breach), days-to-pass distribution, P(funded breach), P(first payout),
plus the chronological T4 sims and maxDD ÷ MLL. "Safe" = **0 breaches in
both stages AND maxDD ≤ 40% of MLL** (the standard's green band).

## Results

### T1 — core quality (identical for every cell; the edge does not change with sizing)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prod stream all | 5606 | 76.9% [75.8%–78.0%] | +4.73 | 5.45 | 0.87 | +2.38 | +0.43 | 2.89 | 38.1 | 64.5 | 1.14 | 6.8% |
| train | 3897 | 76.5% [75.1%–77.8%] | +4.19 | 5.05 | 0.83 | +2.02 | +0.41 | 2.70 | 30.4 | 64.5 | 1.08 | 8.6% |
| test | 1709 | 77.8% [75.8%–79.7%] | +5.95 | 6.42 | 0.93 | +3.21 | +0.47 | 3.25 | 23.1 | 32.9 | 1.32 | 16.2% |

### T4 — the picked profile: $125 risk · cap 10 · no daily arm

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval | Rapid EOD 50k | 5606 | 641 | $230745 | $1600 | ✓ | ✓ | — | 2024-01-25 ($3041) | — | PASS 2024-01-25 · $230745 · consist ✓ · days 641/✓ |
| funded | Rapid EOD 50k | 5606 | 641 | $230745 | $1600 | — | — | — | — | 458 | equity $230745 · payouts 458 · floor $228745 (locked) |
| eval (test-only) | Rapid EOD 50k | 1709 | 180 | $84166 | $1600 | — | — | — | 2026-01-09 ($4662) | — | PASS 2026-01-09 · $84166 · consist ✓ · days 180/✓ |
| funded (test-only) | Rapid EOD 50k | 1709 | 180 | $84166 | $1600 | — | — | — | — | — | equity $84166 · payouts 165 · floor $82166 (locked) |

P(pass before breach) = 100% · median days to pass = 10 · maxDD $733 = 37% of MLL (2000 reshuffles)

Day shape: sd $322 · losing days 68/641 (10.6%) · mean loss −$129 · longest
losing run 4 days · worst day −$415 (21% of MLL) · chronological pass at
trading day 21 ($3,041). 10,000-iter verification (different seed):
P(eval pass) = 100.00% · P(eval breach) = 0.00% · P(fund breach) = 0.00% ·
P(1st payout) = 100.00% · days→pass med 10 [7–14] · days→payout med 6.

### §4.1 — the frontier: fastest safe cell at every budget

400 cells × 500 day-order reshuffles per cell = 200,000 stage-replays.
**The highest shuffled-order breach rate anywhere in the grid was 0.0%** —
including $250/cap-30 (deep loss days are too few and too scattered to dig
a $2,000 hole in random orderings). Shuffled orderings are NOT the whole
story: see the cap dimension below — four $250/cap-30 cells carry maxDD
> 100% of MLL, i.e. the **chronological replay itself breaches**. The
discriminators that matter are floor headroom and speed. 327 of 400 cells
satisfy the green-band filter.

| budget | fastest safe cell | days→pass med [p10–p90] | maxDD ÷ MLL | worst day | mean day |
|---|---|---|---|---|---|
| $25 | cap 3 · no arm | 41 [34–49] | 9% | −$101 | $74 |
| $40 | cap 5 · no arm | 24 [20–30] | 16% | −$171 | $129 |
| $50 | cap 6 · no arm | 19 [15–24] | 19% | −$213 | $164 |
| $60 | cap 8 · no arm | 15 [12–20] | 26% | −$272 | $207 |
| $75 | cap 10 · no arm | 12 [9–17] | 32% | −$332 | $261 |
| **$100** | **cap 8 · no arm** | **11 [8–16]** | **29%** | **−$332** | **$286** |
| **$125** | **cap 10 · no arm** | **10 [7–13]** | **37%** | **−$415** | **$360** |
| $150 | cap 10 · +$400 arm | 11 [9–15] | 35% | −$471 | $285 |
| $200 | cap 10 · +$300 arm | 12 [10–16] | 39% | −$606 | $249 |
| $250 | cap 6 · no arm | 13 [10–18] | 39% | −$402 | $250 |

The curve **saturates at $100–125**: beyond that, more money buys no more
speed (10–13 days) and only adds drawdown and worst-day pain. The risky
extreme for contrast — $200/cap-30/no-arm: 8 days but maxDD **88% of MLL**
and worst day −$936 (red band; one bad week reaches the floor). At the big
budgets the daily arm becomes load-bearing: the +$300/+$400 halts are what
keep $150+ cells inside the green band (234–356 halted days).

Context from the size-down study: the cap-5/$50/+$200 proposal passes in
24 days [20–29] at 17% maxDD/MLL — deep in the safe zone, but ~2.4× slower
than the frontier for tail insurance the frontier already provides.

### §4.1b — the cap dimension: perfect cap or no cap?

The cap's only real job is trimming the **tight-stop trades** — the 3.5–6.5
pt bucket, which the sizing-cap study measured as the weakest edge zone
(PF 2.11 on the 3–4 pt bucket vs 2.78 at 4+; 38% of trades). The dollar
budget already caps risk on wide stops, so above the budget's *natural cap*
(`floor($ ÷ (3.5 × $2))` — the most contracts the formula can ever assign)
a higher cap is dead code. Below it, every cap step trades ~1 day of speed
for drawdown. Per budget, no daily arm:

| budget | green-band knee | knee: days / dd% / worst day | no-cap (30µ): days / dd% / worst day |
|---|---|---|---|
| $25 | cap 3 | 41d / 9% / −$101 | 41d / 9% / −$101 (cap never binds) |
| $40 | cap 5 | 24d / 16% / −$171 | 24d / 16% / −$171 (never binds) |
| $50 | cap 6 | 19d / 19% / −$213 | 19d / 21% / −$231 |
| $60 | cap 8 | 15d / 26% / −$272 | 15d / 26% / −$272 (never binds) |
| $75 | cap 10 | 12d / 32% / −$332 | 12d / 32% / −$332 (never binds) |
| **$100** | **cap 8** | **11d / 29% / −$332** | 10d / 43% / −$462 |
| **$125** | **cap 10** | **10d / 37% / −$415** | 9d / 55% / −$563 |
| $150 | cap 6 | 13d / 36% / −$394 | 8d / 66% / −$705 |
| $200 | cap 6 | 13d / 39% / −$402 | 8d / 88% / −$936 |
| $250 | cap 6 | 13d / 39% / −$402 | 8d / **102%** / −$1,077 — chronological breach |

**No-cap is never optimal.** Wherever removing the cap changes anything it
buys ≤ 1 median day of speed for 14–65 points of drawdown; at $250/cap-30
the maxDD is 102% of the MLL and the historical replay breaches outright
(4 of the 400 cells carry > 100% MLL, all $250/cap-30). The cap does not
scale with budget — it stays 6–10 micros at every budget — because its job
is a quality filter on the weakest trades, not a risk limiter. The "no cap"
philosophy is only harmless when the budget is so small the cap never binds
(≤ $75), and that is slower than $100/cap-8 anyway (12d vs 11d at the same
~30% DD).

`VERDICT: edge real · significance — · stability stable (train/test 76.5/77.8) · holdout n/a (validation pipeline) · viability PASS (P=1.00 · med 10d)`

## What this falsifies and what it confirms

1. **"Breaching impossible" is achievable at nearly every sizing** — the
   whole grid, up to $250/cap-30, produced zero breaches in 200,000
   orderings. The historical daily loss tail (worst day −$936 at the
   extreme, runs of ≤ 4 losing days) cannot dig a $2,000 hole. What the
   sizing actually buys is **floor headroom**: 9% → 88% of MLL across the
   grid, which is the thing that matters if live trading is worse than
   backtest (slippage, news, operator error).
2. **The speed curve saturates at ~$100–125.** $125/cap-10 passes in a
   median 10 days — the fastest green-band cell in the grid; $250 can't
   beat it (13d at cap-6, 8d only if you accept 88% DD). Past $125 the
   market stops paying for the extra risk.
3. **The cap is a free lunch at $100.** At $100 budget, cap-8 passes in 11
   days with 29% DD vs 35% at cap-30 — same speed, less tail, because the
   cap only trims the tightest-stop trades. **$100/cap-8 is the best
   balance of speed, headroom, and per-trade risk**; **$125/cap-10 is the
   fastest cell that stays green-band.**
4. **The cap-5/$50/$200 proposal is well below the frontier** — it passes
   in 24 days where $100/cap-8 passes in 11, with both at ~0 breach. If
   $50 risk is a psychological requirement, the frontier says: keep $50
   but raise the cap to 6 and drop the arm → 19 days (or keep the arm for
   consistency discipline and accept ~24).
5. **Daily arms only pay at big budgets.** Below $125 the arm costs 2–4
   days and ~20% of profit for no breach benefit (consistency was never
   binding). Above $150 the arm is what keeps the account inside the green
   band.
6. **A $200/day income target is a sizing statement, not a discipline
   statement.** Mean day at $50/cap-6 is $164; at $100–125 it is
   $286–360. If the goal is $200/day of realized income, the frontier
   argues for $100/cap-8, not for max-5/$50.
7. **The perfect cap exists and is small: 8 at $100, 10 at $125 — and
   "no cap" loses.** Removing the cap buys at most 1 day of speed while
   pushing drawdown from 29–37% to 43–102% of the MLL; at $250/cap-30 the
   historical replay breaches. The cap is a quality filter on the
   weak-edge tight-stop bucket, not a risk limiter, so it should stay
   6–10 micros no matter how the budget grows.

## Honest bounds

- P(breach) = 0 across the grid is conditional on the historical daily-P&L
  shape: the 95% upper bound is ≈ 0.0015% per stage-replay, but live
  trading adds slippage, news gaps, fills and operator behavior that the
  archive cannot contain. The green-band filter (maxDD ≤ 40% MLL) is the
  hedge against exactly that — a cell at 37% has less room than one at 29%.
- This is a 400-cell grid, so the picked cell's days-to-pass carries
  selection noise. Mitigations: every cell uses the same seed and rules;
  the pick was verified at 10,000 iterations with a different seed; and
  the frontier is flat (all $100–125 cells land at 10–11 days), so the
  choice between them is not noise-mining.
- **T3 (DSR/PBO/PSR) is intentionally absent** — those correct for
  signal-parameter grids selected by max-Sharpe (`validate_sweep.py`).
  This is a risk-layer feasibility sweep whose criterion is a safety band
  + time, evaluated per cell on the full sample; the deviation is declared
  per the standard. Run the validation pipeline if a signal grid is ever
  swept on top.
- **T2 is omitted**: the point stream is identical across all sizing
  cells, so the segment comparison is the dollar-level §4.1 table above;
  the arm-cohort point stats are in the size-down study.
- Commissions excluded (engine convention): ≈ $1.90/trade ≈ $16.6/day at
  $100–125 sizing (~5% of mean day) → add ~1 day to every pass estimate.
- One instrument, one continuous sample; day-order reshuffling flattens
  regime structure (a 2024-style vol regime is in the pool, a worse one is
  not). "Perfect" is a decision: the frontier is the menu, the risk
  appetite is yours.

## Regenerate

```bash
# the full grid (400 cells, ~1 min after the archive is cached)
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/sizeDownStudy.ts --offline --sweep --cell-iters 500 --dump /tmp/sizingFrontier.json

# the picked cell, full standard report + 10k verification
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/sizeDownStudy.ts --offline --budget 125 --cap 10 --target 0 --iters 2000
```
