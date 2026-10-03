# Failed balance breakout — Pulcini's "best position trade", measured (2026-10-03)

## The hypothesis

Pulcini: a balance breakout that fails back through the balance's high-volume
node is "the best position trade in trading" — all the longs who bought the
breakout are trapped and puke, and the fade rides the unwind. "Tops and
bottoms of balance areas, high volume nodes of balance areas."

## The test

`lib/balanceBreak.ts` + `scripts/balanceBreakStudy.ts` + focus follow-up
`scripts/balanceBreakFocusStudy.ts`. 54 variants over 649 sessions:
balBars {30, 60, 120} × failMode {inside, mid, poc} × failOneSided
{0, 0.55, 0.65} × targetMode {1R, edge}. Balance = trailing window
high/low + most-traded price (POC) from the per-price levels, computed
lookahead-free BEFORE the breakout bar; entry = the bar that closes back
through the threshold; stop = far side of the breakout excursion; sequential
one-trade-at-a-time, pessimistic same-bar stop-first, 0.5 pt cost, 60-bar
exit, MFF account sim, split 2026-01-01.

## The measured verdict

The edge is **real but thin** — a genuine satellite, nothing near a primary:

| Config (best cells) | n/day | WR | PF | expR all | expR test | eval |
|---|---|---|---|---|---|---|
| bal60 · mid · 1s0.65 · 1R | 0.55 | 59.9% | 1.52 | +0.140 | +0.322 | PASS 2025-11-19 |
| bal60 · mid · 1s0.65 · 1.5R | 0.55 | 52.7% | 1.50 | +0.163 | +0.237 | PASS 2025-09-15 |
| bal30 · mid · 1s0.55 · edge | 5.2 | 71.3% | 1.35 | +0.073 | +0.099 | PASS 2024-04-30 |
| bal30 · mid · 1s0.55 · 1R | 5.2 | 56.5% | 1.30 | +0.098 | +0.117 | breach |
| bal60 · mid · 1s0.65 · SHORT 1R | 0.27 | 61.7% | 1.86 | +0.210 | +0.399 | breach |

Context numbers: the momentum card is 77.5% WR / PF 2.98 / expR +0.43.

## The findings

1. **The failure threshold matters more than anything.** Fading when price
   merely comes back INSIDE the balance edge ("inside") is 20-31% WR garbage
   with the edge-target; requiring the failure to trade back THROUGH the
   balance midpoint ("mid") or the POC concentrates the edge exactly as
   Pulcini says. The POC ("poc") is mid-tier — the midpoint of a 30-60 bar
   balance is the practical stand-in for the HVN on this data.
2. **The puke proof helps.** failOneSided 0.55-0.65 (the failure bar itself
   ≥55-65% counter-side) is what turns PF 1.1 into PF 1.5 in the strict
   cells. Same lesson as every other study in this repo: the one-sided bar
   is the confirmation.
3. **Shorts are the better side** (PF 1.86/3.03 test in the strict cell) —
   failed UP breakouts unwind harder than failed down-breakouts on this
   index. But short-only variants breach the eval on their own (0.27
   trades/day cannot smooth the drawdowns); the long side dilutes but
   stabilizes. Only the combined config passes.
4. **The passing configs pass slowly.** The strict bal60 cell needs 271
   trading days to clear the eval ($3,000 target at ~0.55 trades/day) —
   useless as a standalone; fine as a marginal add. The volume cell
   (bal30·mid·0.55·edge, 5.2/day) passes fast (2024-04-30) at +0.07R — a
   small, high-win-rate scalp, comparable to the open-family cards but
   below the bar for a production feed.
5. **Hour anatomy**: no clean time-of-day story (19:00-20:00 ET is the
   best bucket in the strict cell, but n is tiny; the lunch-window
   hypothesis is neither confirmed nor rejected here — the RTH card's hour
   segmentation remains the right test for that, and this card is not it).

## Verdict

**Do not enable.** The failed-balance-breakout is a real, Pulcini-shaped edge
— the right threshold (mid) + the puke proof (0.65) + the far-side stop
produce PF ~1.5 and a passing account — but its expectancy (+0.07-0.16R) is
3-6× below the momentum card's, and its passing configs are either too rare
(0.55/day) or too thin (5.2/day at +0.07R) to earn feed bandwidth. Keep the
detector (`lib/balanceBreak.ts`) and the studies as research artifacts; if
the system ever wants a low-frequency RTH fade satellite, `bal60 · mid ·
0.65 · 1R` (or 1.5R) is the config to start from, sized like the open
family and journaled separately.

Runners: `scripts/balanceBreakStudy.ts`, `scripts/balanceBreakFocusStudy.ts`.
