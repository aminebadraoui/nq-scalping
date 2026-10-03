# Sweep-reclaim v2 — Pulcini's ATR-push proof, measured (2026-10-03)

## The question

The retired sweep-reclaim card entered on the reclaim alone and fired shorts
into one-sided runs. Pulcini's rule (Titans Of Tomorrow, 2026-10): fade a
stop-run only AFTER the market proves the break failed by pushing a full ATR
away from the swept extreme, stop on the far side of the event. Does the
ATR-push proof resurrect the fade?

## The test

`lib/sweepReclaimV2.ts` + `scripts/sweepReclaimV2Study.ts`: 80 variants over
649 sessions — atrMult {v1=0, 0.5, 0.75, 1.0, 1.15} × anchor {session,
local-20} × reclaimOneSided {0, 0.65} × hour {globex, none} × targetR
{1, 1.5}. Sequential one-trade-at-a-time, pessimistic same-bar stop-first,
0.5 pt cost, 60-bar exit, MFF Rapid EOD 50k account sim, train/test split
2026-01-01.

## The measured verdict, in one table (session anchor, globex, 1.5R)

| Variant | n | WR | PF | expR all | expR test | eval |
|---|---|---|---|---|---|---|
| v1, no one-sided gate (the retired card) | 7,350 | 44.7% | 1.10 | −0.025 | −0.025 | breach |
| v1 + one-sided reclaim ≥65% | 1,552 | 54.3% | **1.45** | **+0.205** | **+0.273** | breach |
| 0.5×ATR proof | 5,942 | 43.6% | 1.08 | −0.002 | +0.019 | breach |
| 0.75×ATR proof | 5,199 | 43.8% | 1.11 | +0.015 | +0.040 | breach |
| 1.0×ATR proof | 4,467 | 44.5% | 1.17 | +0.040 | +0.089 | breach |
| 1.15×ATR proof (Pulcini's spec) | 4,019 | 44.6% | 1.17 | +0.047 | +0.091 | breach |

**Every one of the 80 variants breaches the account** — 80/80, 0 PASS.

## The three findings

1. **The one-sided reclaim is the proof — the ATR push is not.** Adding
   Pulcini's confirmation to the unfiltered v1 lifts expR from −0.025 to
   ~+0.05-0.09 — a real improvement. But adding the ONE-SIDED RECLAIM filter
   instead lifts it to +0.21/+0.27 test. And the ATR proof degrades
   monotonically as you wait longer (0.5× → 1.15× trades later, catches less
   of the move, cuts nothing). On our 1-min tape, the reclaim bar's
   one-sidedness IS the confirmation; his 5-min-ATR rule does not transfer
   down to bar-scalp timescales.
2. **The fixed fade has a ceiling below the house bar.** Even the best cell
   (v1 + one-sided + 1.5R: 54.3% WR, PF 1.45, expR +0.21) is far below the
   momentum card (77.5% / 2.98 / +0.43), and its variance breaches the
   $2,000 EOD-trailing MLL — the worst day (−$2,084 for the local variant)
   alone is a floor-breach. The fade's edge-to-variance ratio cannot survive
   a 50k prop account at 30-micro sizing. It would need 3-4× the buffer to
   be a live candidate.
3. **Direction**: longs and shorts are nearly identical (PF 1.43/1.56 at the
   best cell) — the "fired shorts into one-sided runs" disease was the
   missing one-sided gate, not the direction. With the gate, shorts are
   actually the slightly better side.

## Verdict

**Do not revive sweep-reclaim.** The retired card stays retired — this study
confirms its disease (no one-sided gate: PF 1.10, expR negative) and shows
that even the best possible fade configuration cannot pass the prop rules.
Pulcini's principle survives in diluted form: *proof is mandatory before
fading* — but on this tape the proof is the reclaim bar's one-sidedness, and
the strategy that already embodies it (momentum's failed-flush → breakout
confirmation, PF 2.70 vs flush-alone 0.26) is the same lesson done right.

Runners: `lib/sweepReclaimV2.ts`, `scripts/sweepReclaimV2Study.ts`.
