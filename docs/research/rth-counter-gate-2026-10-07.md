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

## Status 2026-10-08 — APPLIED (owner-approved)

The owner approved enabling the gate on 2026-10-08. It shipped as
`RTH_COUNTER_GATE_MIN=15` / `RTH_COUNTER_GATE_PTS=5` on `nq-dashboard`, with
the full implementation in `web/lib/rthExitLog.ts` (winner-exit ring buffer +
pure gate decision), the exit learning in `web/lib/execWatch.ts`
(open-position tracking at fill confirmation + a 30s flat-transition poll that
derives the exit price from the session fills), and the veto in
`web/lib/signalFeed.ts` (RTH section — skip + `recordSkip` journal).

Daybook documentation (the requirement): the two knobs are in the daybook
settings snapshot, so the boot record's `variationId` changes with them and
every deploy carrying them is fingerprint-visible; every vetoed card lands in
the daybook as a `signal` record with
`reason: "counter-gate (opposite <side> winner Nm ago within P pts)"` and
`rejectedBy` in its features; every winning RTH exit that arms the gate is
logged by execWatch as `[rth-exit] <side> winner logged — exit …`. To disable:
set both envs to `0` on the Coolify app (owner approval required to change).

### Full-archive validation (651 sessions, 9,009 cards — 2026-10-08)

> **Sequenced-replay nuance (2026-10-08, docs/research/full-gates-replay-2026-10-08.md):**
> under one-position-at-a-time sequencing the counter-gate is structurally
> inert (0 drops in every config — no card can land within 15/30 min of a
> winner's exit because winners never hold ≥45 bars and successors fire ≥60
> bars after a filled entry). LIVE has no one-at-a-time block in checkRth, so
> live sits in the no-block regime where the gate's measured effect lives.
> The gate-ON decision stands; its benefit is live-path only.

Live-style no-block replay (limit TTL 9m, 0.5× stop, 2.5R target, HORIZON 60,
no cap). TRAIN = 2023-12-18..2026-05-31 (565 sessions), OOS = 2026-06-01..10-06
(86 sessions).

| cell | TRAIN (n 7996) | OOS (n 1013) | ALL |
|------|----------------|--------------|-----|
| baseline PF (avg pts) | 1.51 (+1.07) | 1.36 (+0.99) | 1.49 |
| G1 MIN15/PTS5 (n 319/27) | 1.37 (+0.67) | 0.95 (−0.14) | 1.32 |
| G2 MIN30/PTS5 (n 491/45) | 1.44 (+0.78) | 0.89 (−0.31) | 1.37 |

- The gated cell underperforms baseline in BOTH periods at every cost level
  ($0.95/$1.90/$3.80 per-side) — the earlier "overfit" verdict from the
  truncated Jan–May 2026 train (n 60/77) is retracted.
- Account sim (eval, $1.90/RT, $100 budget): baseline $11,248 PASS →
  G1-gated $14,156 (+$2,908, dd −1480) · G2-gated $15,094 (+$3,846, dd −1632).
- Honest caveats: OOS n is thin (27/45) and its deficit (~−1.1 pts) is ~3×
  the train deficit (~−0.4); monthly scatter is extreme (n 0–28/month); the
  replay has no overrides/news/tape gates; freed slots were not re-simulated;
  the offline tape still does not reproduce trade 9 itself.
