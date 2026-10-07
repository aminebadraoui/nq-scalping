# Full-gates replay — cap sweep + counter-gate under the whole live rule stack (2026-10-08)

Scratch: `web/scripts/fullGatesScratch.ts` (untracked). 651 sessions, 10,814
cards, live-style brackets (limit TTL 9m, 0.5× stop, 2.5R target, HORIZON 60).
Sequencing order per day: news blackout (newsGate 2026 calendar) → signal
window (marketHours + 2026 holidays) → one-position-at-a-time (blocked cards
DROPPED forever, not re-simulated) → RTH cap → counter-gate (winner memory
from the sequenced trades' real exits) → day-plan in $ (daily floor −250,
profit arm +400, give-back, consistency 900; exits always settle). Fees
$1.90/RT included. Account sim: eval RAPID_EOD_50K, chronological.

## A) Cap sweep (counter-gate ON, MIN15/PTS5)

| cap | n | WR | avg pts | PF | net $ (0.95/side) | net $ (1.90/side) | acct total | max dd | eval | day halts floor/arm/giveback/consist |
|-----|---|----|---------|----|-------------------|-------------------|------------|--------|------|-------------------------------------|
| 3 | 1,480 | 37.1% | +1.23 | 1.45 | $6,582 | −$24,534 | $6,582 | −$4,321 | **FAIL** (breach 2024-04-03) | 85 / 18 / 0 / 0 |
| 4 | 1,846 | 37.2% | +1.17 | 1.44 | $6,378 | −$34,800 | — | −$7,016 | FAIL | 130 / 33 / 1 / 1 |
| 5 | 2,103 | 37.6% | +1.17 | 1.46 | $8,498 | −$40,480 | — | −$8,715 | FAIL | 157 / 46 / 4 / 1 |
| 6 | 2,239 | 37.7% | +1.19 | 1.48 | $9,604 | −$43,542 | — | −$9,820 | FAIL | 174 / 55 / 7 / 2 |
| NOCAP | 2,312 | 37.9% | +1.19 | 1.49 | $10,194 | −$45,409 | — | −$9,818 | FAIL (2024-03-14) | 180 / 60 / 10 / 3 |

Every cap config fails the eval on the raw detector tape. Total $ rises with
the cap but max dd rises faster — **cap 3 is the least-worst** (smallest dd,
best PF-per-$, still FAIL).

## B) Counter-gate sensitivity (cap 3 fixed)

OFF, MIN15/PTS5, MIN30/PTS5 are **identical — gate drops = 0 in every run**.
With one-position-at-a-time, a card can only fire ≥60 bars after the prior
FILLED entry, and no winning card ever holds ≥45 bars (466 target-wins,
83 stop-wins, 0 time-exit wins) — so no successor can ever land within
15/30 min of an opposite winner's exit. **In the sequenced world the
counter-gate is structurally inert.** Live has no one-at-a-time block in
checkRth, so live sits in the no-block regime — where the gate skipped
~346 cards and the gated cells underperform baseline (−0.4…−1.1 pts/trade).
The gate-ON decision is therefore live-relevant, zero-effect in this mode.

## Sequencing vs the earlier no-block runs

- 10,814 cards → full-gates accepts only 17–26% (news drops 5 · window 2 ·
  one-at-a-time 4,189–6,704 · cap 0–4,729 · day-plan 68–1,285).
- NOCAP dd: −$16,911 (no-block) → **−$9,818** (full gates cut ~42%).
- cap3 dd: −$3,448 → −$4,321 (slightly worse — the daily floor cuts the
  recovery cards that would have followed a red open).

## Verdict + the real gap

No cap or gate config makes the raw detector tape pass the eval. The live
system DOES pass — because the layers this replay cannot reproduce are the
ones doing the heavy lifting: **strategy overrides** (live trims ~80% of
these cards), the tape gate (meaningless offline — archive bars are
candle-confirmed by definition), and family vetoes. Offline replay validates
the DETECTOR; the live JOURNAL (daybook, liveRescore, winnerLoserLive)
validates the live stack. Decisions kept: cap 3 stays; counter-gate stays ON
(owner-approved, no-block-relevant) — with this document as the honest record
of why each replay regime says what it says.
