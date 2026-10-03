# Sizing dynamics — Option A vs Option B (2026-10-02)

The question: keep the same size in drawdown and SHRINK as the day's profit
climbs (Option A — the live tiers), or shrink as we lose and GROW as we win,
never risking more than the day's P&L (Option B — house-money scaling)?

Method: the same trade stream as the risk-stack study (momentum + expansion
+ RTH + open drive, globally sequenced one-position-at-a-time, fixed 1R-style
exits, 0.5 pt cost + $0.95/side commissions), give-back halt ON for every
scheme so ONLY sizing differs. Runner: `scripts/sizingDynamicsStudy.ts`,
649 sessions, MFF Rapid EOD 50k sim (eval + funded).

## The table

| Scheme | Trades | Total | Med day | Worst | DayVol | P≥$500 | P≥$900 | >$900d | avgC | $/vol |
|---|---|---|---|---|---|---|---|---|---|---|
| flat (same size always) | 13,802 | +$533k | +$775 | −$1,372 | $738 | 61% | 43% | 277 | 12.2 | 723 |
| **tiers (OPTION A, live)** | 14,453 | +$378k | +$687 | −$1,372 | **$418** | 64% | **24%** | **156** | 9.4 | **905** |
| lossHalve (×0.5 per loss) | 14,052 | +$509k | +$733 | −$1,306 | $704 | 60% | 40% | 260 | 11.1 | 723 |
| lossQuarter (×0.75 per loss) | 13,836 | +$523k | +$753 | −$1,382 | $727 | 59% | 41% | 268 | 11.7 | 720 |
| winScaleRaw (×1.5 per win) | 11,659 | +$570k | +$566 | **−$1,678** | **$964** | 52% | 41% | 265 | 14.6 | 591 |
| winScale (×1.5 + day-P&L cap) | 5,368 | +$256k | −$20 | −$249 | $880 | 25% | 20% | 128 | 14.1 | 291 |
| greenBudget (day-P&L cap only) | 6,444 | +$250k | −$16 | −$249 | $743 | 31% | 23% | 147 | 11.9 | 336 |
| floorFractional (8.5% of equity−floor) | 12,765 | +$520k | +$563 | **−$1,125** | $847 | 52% | 38% | 247 | 12.6 | 614 |
| **b-full (OPTION B verbatim)** | 5,368 | +$253k | −$20 | −$249 | $869 | 25% | 20% | 127 | 13.9 | 291 |
| tiers+lossHalve (A + B's drawdown leg) | 14,843 | +$371k | +$669 | −$1,306 | $393 | 63% | 19% | 124 | 8.5 | **943** |

## Findings

1. **Option A wins.** Tiers have the best risk-adjusted return (total ÷ daily
   volatility: 905 vs 723 flat), the lowest dayVol (−43%), and cut >$900 days
   277 → 156 and P(≥$900) 43% → 24%. The cost is known and accepted: −29%
   of total vs flat, the price of the $900 consistency cap. Nothing in this
   study beats the adopted scheme on risk-adjusted terms.

2. **Option B breaches the funded account — invisibly.** winScale and b-full
   both breach 2026-04-28 (equity ≈ $203k) even though their worst single day
   is only −$249. The day-P&L ceiling protects each DAY; it does nothing
   against the rule that actually matters — the EOD **trailing** max loss,
   which breaches on a >$2,000 drawdown from the peak accumulated across any
   number of small capped-red days. The kill is invisible at the daily level.
   The eval "passes" only because the pass-stop ends the eval at +$3k; the
   funded stage trades on and dies. This is the trap in "never risk more than
   the day's P&L": per-day floors don't compose into a trailing-drawdown floor.

3. **Shrinking after losses buys ~nothing (IID confirmed).** lossHalve keeps
   95.5% of flat's total with a worst day of −$1,306 vs −$1,372 — a 4.5%
   donation of income for a 5% tail trim. lossQuarter keeps 98% with a
   WORSE worst day. Loss streaks don't predict losses, so loss-based sizing
   just scales edge down. Consistent with the stop-after-N-losses study.

4. **Growing after wins is leverage in disguise.** winScaleRaw makes +7%
   more total than flat — but avg contracts rise 12.2 → 14.6, worst day
   worsens −$1,372 → −$1,678 (22%), dayVol rises to the table's highest
   ($964), and $/vol falls to 591. Anything it "adds" is just more size on
   winning days, which the give-back halt then has to contain. If more money
   is wanted, raise the base budget — the same exposure with fewer moving parts.

5. **The house-money ceiling is the most expensive floor ever bought.**
   greenBudget caps the worst day at −$249 but keeps only 47% of flat's
   total and 46% of flat's $/vol. Compare the give-back halt: same day-floor
   intent at 10–24% cost. The ceiling costs ~53%.

6. **The one new idea that pays: floorFractional.** Risk = 8.5% ×
   (equity − EOD floor) per trade keeps 97.5% of flat's total while cutting
   the worst day to −$1,125 (−18%) — the best tail in the uncapped table.
   It shrinks exactly and only when the account approaches the MLL, which is
   where a shrink actually has value. $/vol (614) is below flat (723), so it
   is still a smoothing trade, not a free lunch — but it is the cheapest
   drawdown insurance measured so far. Candidate for the funded stage.

7. **tiers+lossHalve is a marginal upgrade of Option A**: $/vol 943 vs 905,
   >$900 days 124 vs 156, worst day −$1,306 vs −$1,372, at −2% total. Adding
   the loss-halving leg ON TOP of the tiers is the only place loss-shrinking
   shows any (small) value — the tiers already cap the upside, so the halving
   only touches the red tail.

## Recommendation

Keep Option A (tiers) as the live scheme. Do not adopt Option B — its day
cap cannot protect the trailing drawdown that is the actual account rule, and
the funded sim breaches. If deeper drawdown insurance is wanted, the measured
candidates are, in order of cost: tiers+lossHalve (−2% total), floorFractional
(−2.5% total, best tail), give-back halt (already live). Growing size into
wins is rejected: it adds variance faster than return.
