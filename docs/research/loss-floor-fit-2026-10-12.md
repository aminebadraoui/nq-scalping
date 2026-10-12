# Loss-floor fit — the daily stop-after-loss rule on $100/cap-8/+$400 (2026-10-12)

> Question: *"How does the $100/cap-8/+$400 profile fit with the rule that
> stops trading after a certain amount of loss?"*
> CLI: `web/scripts/sizeDownStudy.ts --floor-sweep`.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · MNQ ($2/pt) · ETH (Globex) |
| Sample | 2023-12-18 → 2026-10-09 · 654 sessions (641 with ≥ 1 trade) · 5,606 trades |
| Cost model | 0.5 pt round-trip (commissions excluded from sims — engine convention) |
| Fill model | market-entry replay · pessimistic same-bar exit · stop-first · no-bars dropped |
| Exit model | 1R target / breakout stop (3.5-pt floor) / 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01 ≤ test) |
| Significance | per-floor P(pass/breach) over 1,000 seeded day-order reshuffles · 10,000-iter different-seed verification on the live default floor |
| Model (if any) | none |
| Stack | varies the RISK layer only: signals `MOM_PROD`+`EXP_PROD` · gates default set · fill 0.5 pt |
| CLI | `web/scripts/sizeDownStudy.ts --floor-sweep` |

The profile is fixed at **$100 risk · cap 8 · +$400 profit arm**, and the
loss-side daily halt is swept over {off, $100, $150, $200, $250, $300,
$400}: once a day's P&L reaches −$L, no new trades that day (the trade that
crosses it counts). The live guard's `DAILY_LOSS_FLOOR` default is $250,
plus give-back protection (halt once the day gives back 0.5 × dayPeak,
$250 floor) — modeled here as the pure loss floor; give-back is noted, not
simulated (that is `guardReplay`'s stack).

## Results

### T1 — core quality (points; unchanged by the loss floor — the floor only removes trades)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prod stream all | 5606 | 76.9% [75.8%–78.0%] | +4.73 | 5.45 | 0.87 | +2.38 | +0.43 | 2.89 | 38.1 | 64.5 | 1.14 | 6.8% |
| train | 3897 | 76.5% [75.1%–77.8%] | +4.19 | 5.05 | 0.83 | +2.02 | +0.41 | 2.70 | 30.4 | 64.5 | 1.08 | 8.6% |
| test | 1709 | 77.8% [75.8%–79.7%] | +5.95 | 6.42 | 0.93 | +3.21 | +0.47 | 3.25 | 23.1 | 32.9 | 1.32 | 16.2% |

### T4 — prop-account viability (the floor dimension; the direct answer)

| loss floor | n trades | worst day | mean day | best day | P(eval breach) | P(fund breach) | pass med [p10–p90] | payout med | maxDD ÷ MLL | loss-halts | profit-halts | chrono pass |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| off | 4826 | $−332 | $241 | $489 | 0.0% | 0.0% | 13 [10–17] | 9 | $574 (29%) | 0 | 153 | 2024-01-31 |
| $100 | 4257 | $−200 | $213 | $489 | 0.0% | 0.0% | 14 [11–20] | 10 | $536 (27%) | 92 | 144 | 2024-02-01 |
| $150 | 4575 | $−242 | $228 | $489 | 0.0% | 0.0% | 13 [10–18] | 10 | $650 (33%) | 41 | 150 | 2024-02-01 |
| $200 | 4727 | $−297 | $236 | $489 | 0.0% | 0.0% | 13 [10–17] | 9 | $559 (28%) | 16 | 151 | 2024-02-01 |
| **$250 (live)** | 4768 | $−339 | $237 | 489 | 0.0% | 0.0% | 13 [10–17] | 9 | $574 (29%) | 8 | 152 | 2024-01-31 |
| $300 | 4810 | $−372 | $240 | $489 | 0.0% | 0.0% | 13 [10–17] | 9 | $636 (32%) | 3 | 153 | 2024-01-31 |
| $400 | 4826 | $−332 | $241 | $489 | 0.0% | 0.0% | 13 [10–17] | 9 | $574 (29%) | 0 | 153 | 2024-01-31 |

Verification (floor $250, 10,000 iters, different seed): P(eval pass) =
100.00% · P(eval breach) = 0.00% · P(fund breach) = 0.00% · P(1st payout)
= 100.00% · days→pass med 13 [10–17].

`VERDICT: edge real · significance — · stability stable (train/test 76.5/77.8) · holdout n/a (validation pipeline) · viability PASS (P=1.00 · med 13d)`

## What this confirms

1. **The live $250 floor is nearly invisible on this profile.** It triggers
   on 8 of 641 days and changes nothing measurable: same 13-day median
   pass, same 29% maxDD/MLL, zero breaches either way. At this sizing the
   daily loss tail (−$105 mean losing day, −$332 worst) lives far below
   $250, so the floor is an emergency brake that almost never engages —
   which is exactly what a floor should be.
2. **The floor does not make breach "more impossible" — breach was already
   0% without it.** Its only measurable effects are on worst-day and
   mean-day, and they are non-monotonic:
   - **$100 floor**: worst day −$332 → −$200, but mean day $241 → $213
     (+1 pass day) and 92 halt days — it cuts the tail by also cutting
     recoveries.
   - **$150–200 floor**: worst day −$242 to −$297 at ~zero time cost
     (13 days) — the useful "tail insurance" zone if the floor is wanted
     to actively bind.
   - **$250+**: worst day is unchanged or *worse* than off (−$339 at $250)
     because the floor stops the intraday recovery of days that dip below
     it; the crossing trade still counts, but the rebound trades are gone.
3. **The floor fits, it just doesn't add anything to this profile.** The
   profile's protection comes from the $100 budget and cap 8 (29% maxDD
   headroom); the loss floor is a behavioral/psychological backstop, not a
   viability contributor. Keep it at the live default $250 (or $200 if you
   want it to actually trigger ~16 times/641 days) and it costs nothing.
4. **The live stack adds give-back on top** (halt once the day gives back
   0.5 × its peak, $250 floor) — that rule protects *green* days that
   reverse and is not in this sweep; it can only make days better than the
   pure floor, never worse. The live profit arm is also slightly looser
   than modeled: one-more-trade after +$400, ending on the first losing
   close (here: hard stop at +$400).

## Honest bounds

- **Worst days can exceed the floor — the floor halts NEW trades, it does
  not stop-loss the day.** The trade that crosses −$L still counts, so the
  realized worst day is bounded by `floor + one trade's loss` (~$100 at
  this sizing: −$200 at a $100 floor, −$339 at a $250 floor). And the halt
  freezes the day at its trough: days that historically recovered from
  below the floor book the dipped amount instead, which is why floors
  $250–300 can show worst days *worse* than no floor at all (−$339/−$372
  vs −$332). The floor's real job is stopping a bad day from bleeding
  further, not capping it at exactly −$L. Live `accountGuard` behaves the
  same way (guardCheck runs between trades).
- The floor model is the pure daily-loss halt; the live give-back rule and
  the dd600→half sizing are not in this sweep (`guardReplay` models the
  full stack — a guarded run would sit between "off" and the tightest
  floor on the loss-side metrics).
- Floor effects are path-dependent and non-monotonic (see worst day at
  $150 vs $200 vs $250): the exact floor choice should be sanity-checked
  against the live daybook, not tuned off this table alone.
- Same stream/conventions as the prior studies: shuffled day-order
  bootstrap, no commissions, one instrument, one sample.
- T3 n/a: floors are a pre-chosen sweep on a fixed profile, not a signal
  grid.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs scripts/sizeDownStudy.ts --offline --budget 100 --cap 8 --target 400 --floor-sweep
```
