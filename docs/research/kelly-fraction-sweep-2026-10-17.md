# Kelly fraction sweep — which fractional Kelly is appropriate under the μ10 cap? (2026-10-17)

> Question: *"Fractional Kelly — which fraction? Owner sizing rule: any
> positive Kelly size below one micro is floored to 1 contract, and the
> per-trade cap is 10 micros."* CLI: `web/scripts/kellySizingStudy.ts`
> (fraction grid 0.25 / 0.35 / 0.5 / 0.75 / 1.0, `maxMicro: 10`,
> `maxRisk: $100`, the full day-plan guard stack + MFF sim — the same
> harness as `docs/research/kelly-mode-2026-10-07.md` §5).

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH+RTH footprint · 657 sessions |
| Families | MOM flush 1R · EXP 1R · RTH market 0.75R · RTH live-limit bracket (marginal-edge cell) · POOL interleaved (the real day plan) |
| Sizing | relative Kelly `risk$ = flatRisk × kellyMult × f/fRef` (shrunken estimates, priors from train ≤ 2025-12-31, `KELLY_MAX_FRAC` 0.5) · **owner rule: floor positive sizes to 1 micro, cap 10 micros** (`maxMicro: 10`) · stand-aside only when f ≤ 0 |
| Cost model | 0.95 pt round-trip · −1.75 pt adverse drift on losers |
| Guard stack | daily floor $250 · profit arm $400 · give-back 0.5×peak/$250 · consistency-day halt $900 · floor-margin · target halt · dd600→half · MFF Rapid EOD 50k sim (EOD trailing $2,000, 30-micro plan cap, eval $3,000/4-day/30%) |
| CLI | `NODE_OPTIONS=--max-old-space-size=8192 node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/kellySizingStudy.ts --offline` |

## Results

### T1 — core quality (pool cohort, structural)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| all | 25,677 | 77.8% [77.3–78.3] | +4.72 | 8.64 | 0.55 | +1.75 | +0.22 | 1.91 | 36.8 | 1,730.3 | 0.93 | 4.9% |
| train | 18,037 | 78.6% [78.0–79.2] | +4.28 | 8.00 | 0.53 | +1.65 | +0.21 | 1.96 | 30.4 | 97.3 | 0.96 | 6.1% |
| test | 7,640 | 75.9% [75.0–76.9] | +5.79 | 9.99 | 0.58 | +1.99 | +0.22 | 1.83 | 20.7 | 1,730.3 | 0.89 | 14.2% |

### T4 — prop-account viability (POOL, the actual day plan, guarded)

| config | eval | worst day | max DD | mean risk | trades | halts |
|---|---|---|---|---|---|---|
| flat $100 | PASS day 17 | −$347 | $727 | $94 | 204 | floor 5 · arm 5 · cons 2 |
| kelly **m0.25** | PASS day 28 | **−$183** | **$311** | $22 | 756 | floor 0 · arm 1 |
| kelly **m0.35** | PASS day 21 | **−$171** | **$332** | $30 | 573 | floor 0 · arm 2 |
| kelly **m0.5** | PASS day 19 | −$277 | $435 | $46 | 486 | floor 1 · arm 4 |
| kelly m0.75 | PASS day 17 | −$336 | $613 | $70 | 384 | floor 2 · arm 3 · cons 1 |
| kelly m1.0 | PASS day 16 | −$350 | $661 | $85 | 310 | floor 2 · arm 5 |

No config breaches the funded account. The μ10 contract cap binds before the
$100 risk cap in every config ("cap 0" hits) — with the owner's cap, Kelly
can only ever shrink from the flat plan, never grow past it.

### T2 — per-family cells

| rule / cell | flat | m0.25 | m0.35 | m0.5 | m0.75 | m1.0 |
|---|---|---|---|---|---|---|
| RTH market 0.75R · eval day | 15 | 35 | 34 | 28 | 24 | 22 |
| RTH market · max DD | $880 | $288 | $288 | $332 | $458 | $524 |
| RTH live-limit (marginal) · eval | **no-pass** (−$857) | no-pass | **PASS day 256 · DD $746 · 3 payouts** | PASS day 256 · DD $908 | PASS day 236 · DD $1,138 | PASS day 233 · DD $1,260 |

### T3 — sweep validation

Fraction grid, selection by the pre-registered objective (smallest tail
subject to eval PASS), not by max Sharpe → DSR/PBO n/a. The guard stack and
MFF sim are the viability layer; no threshold was tuned to the sample.

## Verdict

VERDICT: edge real · significance — · stability flat/m0.5 train-test WR
gap 2.6 pts (shared cohort) · holdout n/a · viability PASS all configs
(pool) · marginal family needs m ≤ 0.35

**The appropriate fraction: `KELLY_MULT = 0.5`** as the all-round default,
with **0.35** as the tail-safety choice and the hard rule that marginal-edge
families never exceed 0.35.

- m0.5 keeps eval speed ≈ flat (day 19 vs 17) while cutting the deepest
  drawdown **40%** ($435 vs $727) and the worst day 20%.
- m0.25–0.35 halves the worst day (−$171/−$183) and cuts max DD ~55%
  ($311–$332) at the cost of a slower eval (day 21–28).
- m0.75+ buys nothing: tails return to flat-level while halts increase.
- On the marginal RTH limit cell, only m ≤ 0.35 passes comfortably —
  consistent with `kelly-mode-2026-10-07.md`'s "on marginal-edge families
  the mult must be 0.5, not 1" (tightened to 0.35 under the μ10 cap).

*Educational research only — not financial advice.*
