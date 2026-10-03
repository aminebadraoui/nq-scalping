# Conviction-tier sizing — Pulcini "trade bigger on confirmation" (2026-10-03)

## The hypothesis

Pulcini: "if I see the stop-iceberg event with confirmation of my guess, NOW
I would trade bigger… rarely three times." Scaling on **independent evidence**,
not on P&L state. The P&L-state versions were already measured and rejected
here (`research/sizing-dynamics-2026-10-02.md`: win-scaling = leverage in
disguise, loss-shrinking buys ~0). Conviction scaling is a different mechanism:
the trade is sized up because MORE confirmations fired.

## Tier definitions (measured best-subsets)

- **A+ / overlap** — both triggers (failed-flush breakout AND huge-bar
  expansion) fire on the same bar. Measured 78.8% WR / PF 3.21 vs 77.5% / 2.98
  combined (`PLAYBOOK.md`). 1,344 of 4,925 trades (27%).
- **A+ | huge** — A+ OR breakout bar ≥1.6× ATR14. Rejected as a tier
  definition: it tags 4,856 of 4,925 trades (99%) — it is just global scaling
  with a different label.

Sizing: tier1 = the production $170 budget; tier2 = 170 × mult,
contracts = min(30, floor(budget ÷ (risk × $2))). Sequential replay,
one-trade-at-a-time, pessimistic same-bar stop-first, 0.5 pt cost, 60-bar
exit, MFF Rapid EOD 50k account sim, 649 sessions.

## The measured table (eval sim, full archive)

| Plan | $ total | vs base | day med | worst | best | >$900 days | eval | test |
|---|---|---|---|---|---|---|---|---|
| baseline 1.0 | $361,462 | — | $545 | −$691 | $2,437 | 134 | PASS 2024-01-12 | PASS 2026-01-12 |
| A+ 1.25× | $386,050 | +7% | $576 | −$783 | $2,513 | 166 | PASS 2024-01-12 | PASS 2026-01-12 |
| A+ 1.5× | $404,425 | +12% | $598 | −$874 | $2,699 | 179 | PASS 2024-01-12 | PASS 2026-01-12 |
| A+ 2.0× | $427,467 | +18% | $623 | −$958 | $2,852 | 201 | PASS 2024-01-18 | PASS 2026-01-12 |
| A+|huge 1.25× | $453,684 | +26% | $677 | −$872 | $3,052 | 218 | PASS 2024-01-12 | PASS 2026-01-12 |
| A+|huge 1.5× | $522,172 | +44% | $773 | −$963 | $3,605 | 265 | PASS 2024-01-12 | PASS 2026-01-12 |
| A+|huge 2.0× | $615,859 | +70% | $908 | −$1,198 | $4,456 | 319 | **BREACH 2025-06-17** | PASS 2026-01-09 |

A+ trades carry 27% of baseline profit at 27% of trade count — the tag is
not a concentration of the edge by itself. The A+-only plans pass everywhere
at every multiplier; the 30-micro cap silently truncates the 2× tier on the
tighter-risk trades (a 2× tier is really ~1.6–1.7× after the cap).

## Verdict

**The mechanism is legitimate — the sim says the juice is small.**

1. A+-only scaling is NOT the win-scaling fallacy: it keys on independent
   evidence and survives the full archive + test period at 1.25–2×. It buys
   +7–18% total at the cost of +24–50% more >$900 days and a deeper worst day
   (−$958 vs −$691 at 2×). The eval still passes because the floor trails EOD
   and the day-tiers already flatten the green tail.
2. The `A+|huge` tier is a trap: it tags 99% of trades, so it IS global
   scaling — and at 2× it breaches exactly the way the earlier scaling
   research predicted.
3. The honest read: **A+ 1.5× is the ceiling worth considering**, and even
   that is a +12% total for a fatter tail. It is the only scaling variant
   this project has measured that is not leverage-in-disguise — but the
   marginal benefit is small against the baseline, and the 2026-10-02 finding
   still dominates: the day-tier shrink is what keeps the account alive, not
   the trade-tier sizing.
4. **Recommendation:** do not change production sizing. Keep the A+ tag
   (already on the card) as an execution-priority marker — the A+ card is the
   one you do not skip — and revisit conviction sizing only if live A+
   journalling (50+ trades) shows the tag overperforming the replay numbers.
   If adopted later: A+-only, cap 1.5×, and only in combination with the
   existing day-tiers (that combination is untested and is the acceptance
   gate).

Runner: `scripts/convictionTierStudy.ts`.
