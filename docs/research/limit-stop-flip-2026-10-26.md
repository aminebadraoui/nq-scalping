# Limit → stop flip — does sending every resting limit as the opposite-side stop entry beat the limit? (2026-10-26)

Owner's question: the live limit entries keep losing. What happens if
every resting limit is sent as the OPPOSITE-side STOP entry at the same
price, with the bracket mirrored around that price? (A buy limit at P
becomes a sell stop at P: same contracts, same point distances.) The code
is in `web/lib/stopFlip.ts`, and `LIMIT_TO_STOP_FLIP=0` turns it off.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · ETH (momentum families) + RTH (soft-momentum family) |
| Sample | 662 archive sessions, 8,957 baseline limit trades / 7,811 flipped (all families) |
| Cost model | $1.90/RT commission in the $ sim; gross pts in T1 (same convention as `rthLimitValidation.ts`) |
| Fill model | **limit**: fill at P or better (min/max of bar open, P) when a bar trades P within the TTL · **stop**: same trigger bar, filled at P or WORSE (gap-through at the open) plus an adverse slip ladder of +0 / 0.25 / 0.5 / 1.0 pt |
| Exit model | stop / target touch from the bar after the fill (stop-first), else the 60-bar time-exit close; identical for every arm |
| Split | train < 2026-01-01 ≤ test |
| Significance | Wilson 95% CI on WR · no grid swept (the live knobs only), so no DSR/PBO |
| Model (if any) | none |
| Stack | varies the ENTRY ORDER TYPE + SIDE only; detectors `SOFT_PROD` / `MOM_PROD` / `EXP_PROD` / `detectBigBar`, live limit knobs (RTH s0.5/t2.5 TTL 9 · flush AT close ±1R TTL 9 · expansion 1 pt behind ±1R TTL 5 · big-bar flush path), crossed-stop dispatch gate, $100 budget sizing |
| CLI | `web/scripts/stopFlipStudy.ts` |

The study covers every live limit path in `signalFeed`: the RTH session
continuation, the momentum failed-flush, the expansion retrace, and the
big-bar continuation. Each family is replayed on its own, with a
one-trade-at-a-time latch per family. The `all` cohort pools those
trades. That makes `all` an upper bound on trade count, because live
trading shares one flat gate across families.

## Results

T1, all families pooled:

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| limit (baseline) · all | 8957 | 44.0% [43.0%–45.0%] | +6.88 | 4.79 | 1.44 | +0.35 | +0.09 | 1.13 | 7.4 | 458.3 | 0.21 | 23.0% |
| limit (baseline) · test | 2776 | 45.3% [43.4%–47.1%] | +8.40 | 6.16 | 1.36 | +0.43 | +0.10 | 1.13 | 4.5 | 458.3 | 0.25 | 58.9% |
| flip stop +0 · all | 7811 | 47.6% [46.5%–48.7%] | +5.86 | 5.33 | 1.10 | −0.00 | +0.00 | 1.00 | 0.1 | 879.3 | 0.00 | 0.0% |
| flip stop +0 · train | 5348 | 47.9% [46.5%–49.2%] | +5.16 | 4.69 | 1.10 | +0.03 | +0.01 | 1.01 | 0.5 | 772.2 | 0.03 | 369.4% |
| flip stop +0 · test | 2463 | 47.1% [45.2%–49.1%] | +7.41 | 6.71 | 1.10 | −0.06 | −0.01 | 0.98 | -0.6 | 713.1 | -0.06 | 0.0% |
| flip stop +0.25 · all | 7811 | 47.5% [46.4%–48.6%] | +5.63 | 5.57 | 1.01 | −0.25 | −0.06 | 0.91 | -4.2 | 2585.8 | -0.12 | 0.0% |
| flip stop +0.25 · test | 2463 | 47.1% [45.2%–49.1%] | +7.16 | 6.96 | 1.03 | −0.31 | −0.06 | 0.92 | -2.6 | 1180.3 | -0.17 | 0.0% |

T1, per family. Each row shows the all-sample figures; the OOS columns
are on the right.

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 | OOS exp (pts) | OOS PF |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| rth · limit | 2596 | 35.2% [33.4%–37.1%] | +10.33 | 3.85 | 2.68 | +1.14 | +0.29 | 1.46 | 9.2 | 104.3 | 0.32 | 14.8% | +1.26 | 1.44 |
| rth · flip +0 | 2079 | 37.5% [35.4%–39.6%] | +8.59 | 4.45 | 1.93 | +0.44 | +0.10 | 1.16 | 2.9 | 184.2 | 0.11 | 41.8% | +0.90 | 1.29 |
| rth · flip +0.25 | 2079 | 37.4% [35.3%–39.5%] | +8.36 | 4.69 | 1.78 | +0.19 | +0.03 | 1.06 | 0.9 | 316.9 | 0.04 | 95.4% | +0.65 | 1.20 |
| flush · limit | 2787 | 46.7% [44.8%–48.5%] | +5.38 | 4.84 | 1.11 | −0.07 | +0.01 | 0.97 | 0.5 | 435.1 | 0.02 | 0.0% | −0.11 | 0.97 |
| flush · flip +0 | 2570 | 52.3% [50.3%–54.2%] | +4.79 | 5.36 | 0.89 | −0.05 | −0.03 | 0.98 | -1.5 | 485.0 | -0.04 | 0.0% | −0.15 | 0.96 |
| flush · flip +0.25 | 2570 | 52.1% [50.1%–54.0%] | +4.56 | 5.59 | 0.82 | −0.30 | −0.08 | 0.89 | -4.3 | 1087.6 | -0.13 | 0.0% | −0.40 | 0.89 |
| expansion · limit | 3475 | 48.1% [46.5%–49.8%] | +5.50 | 5.13 | 1.07 | −0.02 | +0.01 | 0.99 | 0.8 | 404.0 | 0.02 | 0.0% | +0.05 | 1.02 |
| expansion · flip +0 | 3101 | 50.8% [49.1%–52.6%] | +5.17 | 5.51 | 0.94 | −0.08 | −0.03 | 0.97 | -1.9 | 445.0 | -0.05 | 0.0% | −0.24 | 0.93 |
| expansion · flip +0.25 | 3101 | 50.8% [49.0%–52.5%] | +4.93 | 5.75 | 0.86 | −0.33 | −0.09 | 0.88 | -4.8 | 1115.4 | -0.15 | 0.0% | −0.49 | 0.87 |
| bigbar · limit † | 99 | 53.5% [43.8%–63.0%] | +27.70 | 23.65 | 1.17 | +3.84 | +0.15 | 1.35 | 1.6 | 225.1 | 0.16 | 120.1% | +7.27 | 1.67 |
| bigbar · flip +0 † | 61 | 37.7% [26.6%–50.3%] | +23.39 | 27.83 | 0.84 | −8.52 | −0.41 | 0.51 | -3.0 | 605.3 | -0.38 | 0.0% | −8.91 | 0.49 |

† The big-bar cohort is thin (n < 100; OOS n = 49 / 31).

$ account sim (eval, $100 budget, $1.90/RT fees in the $):

| family | limit all $ | limit OOS $ | flip +0 all $ | flip +0 OOS $ | flip +0.25 all $ | flip +0.25 OOS $ |
|---|---|---|---|---|---|---|
| rth | **+8,472 PASS** | +5,357 PASS | −33,512 BREACH | −3,115 PASS | −47,565 BREACH | −6,323 BREACH |
| flush | −53,073 BREACH | −13,080 BREACH | −58,209 BREACH | −18,333 BREACH | −71,684 BREACH | −21,909 BREACH |
| expansion | −61,225 BREACH | −12,272 BREACH | −69,014 BREACH | −22,126 BREACH | −84,473 BREACH | −26,122 BREACH |
| bigbar | +802 PASS | +746 PASS | −2,174 BREACH | −964 PASS | −2,227 BREACH | −988 PASS |
| all | −105,023 BREACH | −19,248 BREACH | −162,909 BREACH | −44,538 BREACH | −205,949 BREACH | −55,342 BREACH |

T4, all families pooled. The engine `propViability` dollarizes gross
pts, so these figures carry no commission:

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval · limit | Rapid EOD 50k | 8957 | 661 | $81531 | $1557 | ✓ | ✓ | 2025-05-05 ($39246) | — | — | breach 2025-05-05 (equity $39246) |
| eval (test-only) · limit | Rapid EOD 50k | 2776 | 190 | $26991 | $1364 | — | — | 2026-10-08 ($26180) | — | — | breach 2026-10-08 (equity $26180) |
| eval · flip +0.25 | Rapid EOD 50k | 7811 | 660 | $-42393 | $1362 | ✗ | ✓ | 2024-01-10 ($-533) | — | — | breach 2024-01-10 (equity $-533) |
| eval (test-only) · flip +0.25 | Rapid EOD 50k | 2463 | 190 | $-14286 | $886 | — | — | 2026-01-13 ($-1684) | — | — | breach 2026-01-13 (equity $-1684) |

- **Limit:** P(pass before breach) = 83%, median 22 days to pass, maxDD
  $3,680 = 184% of the MLL.
- **Flip +0.25:** P(pass before breach) = 5%, maxDD $51,628 = 2,581% of
  the MLL.
- **RTH alone:** limit P = 0.99, flip +0.25 P = 0.32.

VERDICT (flip +0.25, all families): edge absent · significance — · stability train/test WR gap 0.6 pts · holdout OOS ≥ 2026-01-01 · viability FAIL (P=0.05)

### Addendum: risk/reward variants (owner follow-up: "is it the RR?")

These arms change the traded bracket, applied to the flipped side or to
the limit as a reference:

- `1R`: the stop distance on both sides.
- `1R wide`: the target distance on both sides.
- `swapRR`: the stop-loss and take-profit distances swap places.

The momentum families (flush, expansion and big-bar) already trade a
symmetric 1R bracket, so every RR variant there is identical to the
mirrored flip; their figures above stand. The only family where RR
matters is RTH, where the stop is 0.5× the signal risk and the target is
2.5R.

RTH only ($ = eval sim, $100 budget, $1.90/RT):

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | limit (live: 0.5× stop, 2.5R) | 2596 | 35.2% [33.4%–37.1%] | **1.46** | **+1.14** | 35% / 35% | — · $ +8,472 PASS |
| 2 | flip, mirrored | 2079 | 37.5% [35.4%–39.6%] | 1.16 | +0.44 | 37% / 40% | vs #1 · $ −33,512 BREACH |
| 3 | limit 1R (0.5× both ways) | 2596 | 46.5% [44.6%–48.4%] | 1.01 | +0.01 | — / 46% | vs #1 · $ −63,034 BREACH |
| 4 | flip 1R | 2079 | 41.4% [39.3%–43.5%] | 0.59 | −1.01 | — / 43% | vs #3 · $ −105,982 BREACH |
| 5 | limit 1R wide (1.25× both ways) | 2634 | 50.3% [48.4%–52.2%] | 1.13 | +0.62 | — / 52% | vs #1 · $ −8,743 BREACH |
| 6 | flip 1R wide | 2574 | 49.1% [47.2%–51.0%] | 0.88 | −0.66 | — / 49% | vs #5 · $ −41,559 BREACH |
| 7 | flip swapRR (wide stop, tight target) | 2574 | 60.2% [58.3%–62.1%] | 0.60 | −1.53 | — / 59% | vs #1 · $ −58,621 BREACH |

All flip rows are at zero slip. The +0.25 pt rows are worse by about
0.25 pts/trade.

What the RR variants show:

1. **The RR is not why the flip fails. Under every geometry, the flipped
   side loses to the limit side.** With the same bracket on both sides
   (#3 vs #4, #5 vs #6), the limit is about breakeven or positive and
   the flip is clearly negative. The edge is in the limit's direction.
2. **The live 0.5×/2.5R bracket IS the RTH edge.** Moving the limit to
   1R kills it (PF 1.46 → 1.01). The wide 1R keeps a thin pts edge
   (+0.62) but fails the account after fees.
3. **Swapping the RR on the flip buys win rate, not money.** WR rises to
   60%, but the payoff falls to 0.40, so PF is 0.60.

### Addendum: live setups and fills audit (exec ledger 2026-10-08 → 2026-10-26)

Source: the dashboard's `/api/exec-ledger` (read-only), with 42 closed
live trades. Each trade was replayed against the archive 1-min bars from
card → fill → exit using the scratch script `web/scripts/liveFillReplay.ts`.

| family | live closed | W / L | live WR | net $ | median entry vs limit | losses held < 10 s |
|---|---|---|---|---|---|---|
| RTH (session continuation) | 13 | 2 / 11 | 15% | −$2,199 (−$435 ex the 10-15 naked fill) | 0.62 pt better | 5 / 11 |
| momentum (flush / retrace / big-bar) | 27 | 11 / 16 | 41% | −$210 | 0.12 pt better | 3 / 16 |

The fills themselves are clean: limits fill at or better than the price,
with no slippage problem on entry. The losses come from what happens
**within the same minute as the fill**:

- **8 of the 15 RTH trades in the replay (incl. the 10-15 naked fill)
  hit the stop inside the very 1-min bar that filled the limit.** The
  live holds were 1–3 s. RTH's 0.5× stop is only 3.5–7 pts, and the bar
  that runs up to a short limit routinely keeps running 5–20 pts past it.
- In 6 cases (2 RTH, 4 momentum), price ran all the way to the TARGET
  before the limit ever filled, then came back, filled the limit, and
  three of those were then stopped. The pre-fill run was 13–42 pts.

#### The backtest fill-bar gap (what the live trades exposed)

`rthLimitValidation.ts`, and this study's default rule, scan exits from
the bar AFTER the fill. The fill bar's own adverse range is never
checked, so a stop-out within the fill bar is invisible. That breaks the
standard's "pessimistic same-bar exit, stop-first" rule. The
`limit HONEST fill bar` arm counts a fill-bar stop touch as a stop-out
and credits no target on the fill bar:

| # | rule / cell | n | WR [CI95] | PF | exp (pts) | train/test WR | baseline or opposite side |
|---|---|---|---|---|---|---|---|
| 1 | RTH limit, legacy (next-bar scan) | 2596 | 35.2% [33.4%–37.1%] | 1.46 | +1.14 | 35% / 35% | — · $ +8,472 PASS |
| 2 | RTH limit, HONEST fill bar | 2596 | 28.6% [26.9%–30.4%] | 1.08 | +0.23 | — / 29% | vs #1 · $ −49,455 BREACH |
| 3 | flush limit, HONEST | 2787 | 44.7% [42.8%–46.5%] | 0.90 | −0.28 | — / 44% | legacy 0.97 / −0.07 |
| 4 | expansion limit, HONEST | 3475 | 46.6% [44.9%–48.2%] | 0.93 | −0.18 | — / 47% | legacy 0.99 / −0.02 |
| 5 | big-bar limit, HONEST † | 99 | 45.5% [36.0%–55.2%] | 0.99 | −0.12 | — / 51% | legacy 1.35 / +3.84 |
| 6 | all families, HONEST | 8957 | 40.8% [39.7%–41.8%] | 0.97 | −0.09 | — / 42% | legacy 1.13 / +0.35 |
| 7 | flip, HONEST +0.25 (all) | 7811 | 31.9% [30.9%–33.0%] | 0.41 | — | — / 33% | vs #6 |

VERDICT (RTH limit, honest fill bar): edge absent (+0.06 R, PF 1.08 gross, unfundable after fees) · significance — · stability train/test WR gap −0.3 pts · holdout OOS ≥ 2026-01-01 · viability FAIL ($ −49k BREACH)

What the audit shows:

1. **The RTH limit "edge" (+$8.5k PASS) is mostly a backtest artifact of
   skipping the fill bar.** Scored honestly, it is about breakeven gross
   and loses after fees. The live WR of 15% (n=13, very thin) sits below
   even the honest 28.6%.
2. **The momentum limit families are breakeven-to-negative under either
   rule.** The live 41% WR matches the honest 45% within noise.
3. **The flip is worse still under honest scoring** (PF 0.41). Every
   conclusion above stands.
4. **The dashboard's paper `signalOutcome` overstates limit cards.**
   `signalScorer` enters at the limit price on the signal bar even when
   the tape is 10–15 pts away and the limit never filled. That is why
   executed RTH cards show 9 paper wins against 2 real wins.

### Addendum: execution fixes under honest scoring (owner: "fix it without turning anything off")

Study: `web/scripts/limitFixStudy.ts`. It sweeps 64 configs per family:

- **Stop distance:** 4 multiples of the signal risk. RTH and big-bar use
  0.5 / 0.75 / 1 / 1.5; flush and expansion use 0.75 / 1 / 1.5 / 2.
- **Target:** 1 / 1.5 / 2 / 2.5R.
- **Entry type:** one of four:
  - `limit`: rest at the family's limit price (today's behaviour)
  - `cancel`: the limit, cancelled if price prints the target before a fill
  - `deep`: the limit rested 0.25× the signal risk further back
  - `confirm`: wait for the touch bar to close back on the signal side,
    then enter at market on the next bar's open, with 0.25 pt slip

Scoring is honest throughout: stop-first on the fill bar, bracket
anchored at the fill, $1.90/RT per contract, $100 budget sizing. Breach
means falling $2,000 below the running peak, fees included. A config
qualifies on train (< 2026-01-01) with PASS + PF ≥ 1.1 + net $ > 0 +
n ≥ 30.

| family | data | today (live config) OOS | best train config | its OOS | train-qualified |
|---|---|---|---|---|---|
| RTH | real OHLC (543 sess) | PF 1.18 · exp +0.68 · $ −3,074 BREACH (train PF 1.05, $ −17k) | limit s1.5 t2.5 (train $ −1,128) | PF 0.99 · $ −1,699 | **0 / 64** |
| RTH | archive (662 sess) | PF 0.97 · $ −14,189 | cancel s1.5 t2.0 (train $ −4,177) | PF 1.11 · $ −422 | **0 / 64** |
| flush | real OHLC | PF 0.95 · $ −13,874 | deep s2 t2 (train $ −8,882) | PF 1.01 · $ −7,359 | **0 / 64** |
| flush | archive | PF 0.91 · $ −16,913 | limit/cancel s2 t2 | PF 1.02–1.03 · $ −7k | **0 / 64** |
| expansion | real OHLC | PF 0.88 · $ −18,478 | limit s2 t2 (train $ −12,633) | PF 0.96 · $ −8,679 | **0 / 64** |
| expansion | archive | PF 0.96 · $ −16,496 | cancel s2 t2 | PF 1.00 · $ −9,980 | **0 / 64** |
| big-bar † | real OHLC | PF 0.62 · $ −1,236 | limit s1.5 t2.5 (train PF 1.37) | PF 0.73 · $ −915 | 7 / 64, all fail OOS |
| big-bar † | archive | PF 1.12 · $ +41 | deep s1.5 t1.0 (train PF 1.43) | PF 1.15 · $ +225 | 3 / 64 |
| stack | real OHLC | PF 0.93 · $ −36,662 | each family at its pick | PF 0.93 · $ −36,341 | — |

† The big-bar cohort is thin (n ≈ 50–65 per split), and the two data
sets disagree on it.

VERDICT (stack, best execution config per family): edge absent · significance 64 configs/family, none qualify · stability — · holdout OOS ≥ 2026-01-01 PF 0.93 · viability FAIL

What the fix sweep shows:

1. **No execution lever makes any family fundable.** Stop width, RR,
   cancel-on-run, deeper limits and confirm-entry were all tried, 256
   configs in all, and the result holds on real Tradovate OHLC as well
   as the archive.
2. **Wider stops cut the bleed but don't create an edge.** Fewer
   fill-minute stop-outs and fewer contracts mean less fee drag. The
   best configs land near PF 1.0.
3. **Confirm-entry is worse everywhere.** The touches that hold are the
   ones that already moved, and the market entry pays the open.
4. **The problem is the signal, not the execution.** At the real entry
   these detectors carry no directional edge. Execution changes move the
   loss rate around without turning it positive.

## What this falsifies and what it confirms

1. **The flip does not fix the losing limits. It makes every family
   worse.** That holds in pts, in $, in OOS, and at zero slip. Under the
   flip, no family improves and no family passes the account in the full
   sample.
2. **RTH is the only family with a limit edge in this model, and the
   flip destroys it.** Exp falls from +1.14 to +0.44 pts at zero slip
   and to +0.19 at 0.25 pt. The account goes from PASS (P=0.99) to
   BREACH (P=0.32).
3. **The momentum limit families (flush and expansion) are coin flips
   either way.** They are about 0 pts gross before the flip, and fees
   make them unfundable at the $100 budget. The flip only adds
   stop-entry slippage. With a symmetric 1R bracket, the mirrored trade
   is close to the inverse of the original, so it cannot create an edge
   that the original lacks.
4. **The flip pays slippage that the limit never pays.** Every 0.25 pt
   of stop-fill slip costs about 0.25 pts/trade. At 0.5 pt, every
   family is negative.
5. The live losses are more consistent with limit fill quality than with
   direction. This backtest fills a limit on a TOUCH. Live, a limit
   often doesn't fill on a plain touch, and the touch-and-reverse
   winners are exactly the ones missed. This study does not test that,
   so it remains a hypothesis to test next.

## Honest bounds

- Touch-fill for limits is optimistic. That flatters the baseline by an
  unknown amount, and it is also the likeliest reason the live limit P&L
  is worse than the backtest.
- The stop fill model is a gap-through plus a fixed slip. Real
  stop-market fills in flush tape can slip much further (the 2026-10-08
  stop slipped 34 pts), so the flip arms are, if anything, optimistic.
- Families are replayed independently. Live trading shares one flat gate
  and the account guards (giveback, tiers), so the `all` cohort is an
  upper bound on trade count and a rough figure in $.
- The live env knobs (`RTH_LIMIT_*`, `MOM_PROFILE`, `FEED_*`) are taken
  at their code defaults. If the Coolify values differ, the
  per-family figures shift; the direction of the result does not.
- Big-bar has n = 99 / 61 (thin), so its OOS PF figure cannot be relied
  on.
- No exit slippage is modelled for either arm.

## Regenerate

```bash
cd web && node --import ../scripts/ts-loader.mjs ./scripts/stopFlipStudy.ts
```
