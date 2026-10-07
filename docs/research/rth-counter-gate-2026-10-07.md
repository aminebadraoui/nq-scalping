# RTH counter-signal gate — research note (2026-10-07)

Follow-up to the post-mortem question "should a fresh opposite-side RTH card
close to a winning RTH exit be gated harder?" (trade 9: 12:54 short stopped in
6s, 13 min after the 12:44 long hit target in the same zone).

## Study

`web/scripts/counterGateScratch.ts` (untracked scratch, research input — NOT
validation per EXEC_CHANGE_POLICY): 86 sessions 2026-06-01..2026-10-06 from R2,
live-style replay (detectSoftMomentum SOFT_PROD, resting-limit entry TTL 9 min,
0.5× stop, 2.5R target, HORIZON 60, no one-at-a-time block — live `checkRth`
has none), n = 1013 filled cards. Cells = cards fired within N minutes of an
opposite-side RTH card's WINNING exit, within M points of that exit:

| cell | n | WR | avg pts | PF |
|------|---|----|---------|----|
| baseline | 1013 | 37.4% | +0.99 | 1.36 |
| 5×∞ | 28 | 39.3% | +2.26 | 1.91 |
| 10×∞ | 64 | 29.7% | +0.15 | 1.05 |
| 15×∞ | 99 | 33.3% | +0.60 | 1.21 |
| 30×∞ | 194 | 35.6% | +0.82 | 1.30 |
| 5×5 | 8 | 12.5% | −2.02 | 0.31 |
| 10×5 | 18 | 16.7% | −1.51 | 0.51 |
| 15×5 | 27 | 29.6% | −0.14 | 0.95 |
| 30×5 | 45 | 28.9% | −0.31 | 0.89 |

## Verdict

- **Time-only gating is NOT justified** — the ∞-distance cells are ≈ baseline
  or better.
- **Distance gating (≤5 pts from a winner's exit) is directionally consistent**
  (all four M≤5 cells negative, PF 0.31–0.95) but thin (n = 8–45). After an
  opposite-side **loss** the cards are positive (PF 1.04–1.58), so the WIN
  trigger is the right one.
- Caveats: the offline archive does not reproduce trade 9 itself (live fires
  ~3–4 RTH cards/day vs 13.7 offline; 1-min footprint cannot see 6-second
  intra-bar stops) — this validates a pattern, not the event. The
  rthLimitValidation harness's 60-bar one-at-a-time block makes the effect
  structurally unmeasurable in that harness (all cells empty).

## Proposal (flagged, NOT applied)

`RTH_COUNTER_GATE_MIN=15` / `RTH_COUNTER_GATE_PTS=5` — skip an RTH card whose
entry is within 5 pts of an opposite-side RTH card's winning exit in the last
15 min. Master off by default; enabling requires explicit owner approval and a
full `scripts/rthOptimizer.ts` campaign re-validation extended with a
live-style no-block replay variant (the current harness cannot see this
effect).
