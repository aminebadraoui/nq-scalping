# A+ plan hardening — making a blow ~impossible without losing the month (2026-10-05)

## The question

*What can we change so blowing the eval becomes virtually impossible (needs an
abnormal streak), while keeping time-to-pass reasonable (≈1 month)?*

Method: the A+ plan's day engine (`web/lib/apPlan.ts`) swept over its own knobs
(risk cap, daily stop, profit arm, target R) plus two state-aware protection
layers (drawdown-aware and streak-aware half-sizing), replayed over all 650
sessions and pushed through the exact Rapid EOD 50k eval gates (10,000 random
day orderings per config). Re-run: `web/scripts/apPlanSweep.ts`.

The blow mechanism first: the MLL is **end-of-day trailing** — you blow when
cumulative P&L sits $2,000 below the running peak. So blow risk is about the
DEPTH OF RED STREAKS, not any single day. `streak2blow` below = how many
straight worst-case days it takes from any peak; `longestRed` = the longest
consecutive red-day streak that ever actually occurred in 2.5 years.

## Results (ranked by blow probability)

| Config | P(blow) | Med days | p25–p90 | ≤60d | Worst day | streak2blow | longestRed | Chrono |
|---|---|---|---|---|---|---|---|---|
| **100/-300/1R** | **0.0%** | 28 | 23–43 | 99% | −$410 | 5 | 4 | PASS day 30 |
| **100/-250/1R** | **0.0%** | 29 | 23–45 | 99% | −$361 | 6 | 4 | PASS day 30 |
| 100/-200/1R | 0.0% | 30 | 24–46 | 98% | −$325 | 7 | 4 | PASS day 30 |
| dd600→half /-250/1R | 0.0% | 30 | 24–48 | 97% | −$361 | 6 | 4 | PASS day 30 |
| **125/-250/1R** | **0.1%** | **24** | 18–38 | 100% | −$392 | 6 | 4 | PASS day 27 |
| 125/-200/1R | 0.1% | 24 | 19–39 | 100% | −$352 | 6 | 4 | PASS day 28 |
| dd600→quarter /-250/2R | 0.0% | 42 | 25–97 | 69% | −$374 | 6 | 6 | PASS day 109 |
| dd600→half /-250/2R | 0.2% | 37 | 24–78 | 79% | −$374 | 6 | 6 | PASS day 52 |
| dd800→half /-250/2R | 0.3% | 35 | 23–73 | 82% | −$374 | 6 | 6 | PASS day 52 |
| 100/-250/1.5R | 0.6% | 32 | 23–56 | 93% | −$374 | 6 | 6 | PASS day 50 |
| red2→half /-250/2R | 1.6% | 35 | 24–66 | 86% | −$374 | 6 | 6 | PASS day 51 |
| 100/-250/2R | 3.0% | 32 | 23–59 | 91% | −$374 | 6 | 6 | PASS day 52 |
| **current 100/-300/2R** | **~3–4%** | 31 | 22–58 | 92% | −$422 | 5 | 6 | PASS day 69 |
| 150/-250/2R (speed ref) | 15.2% | 28 | 19–52 | 95% | −$423 | 5 | 6 | PASS day 30 |

## Readings

1. **The 2R target is the root cause of the blow risk.** At 2R the A+ win
   rate collapses from ~75–80% (native targets) to ~50%, which is where the
   deep red streaks come from. At **1R the same setups win ~3 of 4**, the day
   series smooths out, and **0 of 10,000 orderings blow** — while the median
   time-to-pass IMPROVES (28–29 trading days vs 31–32) and the chronological
   path passes on day 30 instead of day 69. Lower target = less variance, not
   less edge: per-trade expectancy in R is ~0.55R at 1R vs ~0.51R at 2R.
2. **The streak proof of "virtually impossible"**: at 100/-250/1R, blowing
   needs **6 consecutive near-worst days** (−$361 each) from a peak; the
   longest red streak the archive ever produced is **4 days** — and those were
   not worst days. Even 4 straight worst days (−$1,444) stays $556 above the
   floor. To blow you need a streak that has never existed in the data.
3. **Bigger size is poison, not a shortcut.** 150/-250/2R passes a hair
   faster (28 days) but blows 15% of the time. The only safe way to buy speed
   is 100→125 at 1R: median drops 29→**24 trading days (~5.5 weeks)** at
   0.1% blow (1 in 1,000, still needing a 6-straight-worst-day streak vs a
   realized max of 4).
4. **If you insist on keeping 2R**: the drawdown-aware half-size rule
   (trade half size once the challenge drawdown from peak hits $600, resume
   full at $300) brings blow to ~0.2% — but pass slows to ~37 days / 8.5
   weeks (chrono day 52). Keeping 2R costs you the month.
5. **Why this matters right now**: the current plan's actual chronological
   path came within **$118 of the trailing floor on 2025-06-03** (the funded
   phase, the same date the no-rules variant breached). The eval would have
   passed (2024-04-15), but the 2R variance nearly killed the funded account
   a year later.

## The recommendation

**Trade the A+ pool at 1R with the −$250 daily stop and the $100 cap**
(same setups, same sizing math, tighter stop, 1R target):

- blow: 0 in 10,000 random orderings (needs a 6-day worst-case streak; max
  ever observed: 4)
- pass: median **29 trading days (~6.5 weeks)**, p75 37, p90 45, 99% within
  60 trading days; chronological path passes on day 30
- if you want the fastest safe variant: **$125 cap, −$200 stop, 1R** —
  median **24 trading days (~5.5 weeks)**, p90 39, 0.1% blow

Honest limit: with A+ setups ONLY, no config reaches a 1-month MEDIAN
(≈22 trading days) — the 1R space tops out around 24–29. The only levers that
get under a month are adding more daily edge (e.g. trading the regular RTH
card alongside A+) or accepting the 15% blow risk of bigger size — neither is
in this table by design; ask for the A+ + RTH-card variant if you want it
measured.

## Caveats (standing)

Mid-bar archive entries, pessimistic first-touch scoring, 0.5 pt cost +
commissions, no news gaps, every signal taken when flat; MC destroys serial
correlation (brackets any start date, not just Dec 2023). State-aware rules
switch at day boundaries — exact, since the floor itself only trails at
closes. The 0.0% figures are 0 in 10,000 samples, not mathematical zeros.

*Educational research only — not financial advice.*
