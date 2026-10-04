# Bias Fit — does the tape predict the next 30–90 min? (2026-10-04)

> The question behind the AI briefing's bias chip: at each briefing
> timestamp, which lookahead-free tape features predicted the next
> ~60-minute NQ move — and with what weight? The fitted coefficients
> replaced the hand-tuned `systemVerdict` weights in `lib/briefingText.ts`.
> CLI: `web/scripts/biasFit.ts` (re-runnable; ~3 min on the warm archive).

## Method

- **Samples:** every archived session (649, 2023-12-18 → 2026-10-02) × six
  briefing timestamps (18:05 / 09:15 / 09:35 / 11:30 / 13:30 / 16:05 ET)
  → 3,864 samples.
- **Features (known through bar T only):** NQ change vs the session-open
  close (%), close position in the session range (%), cumulative delta
  (÷1000), realized 1σ from the last 30 closes (%), daily/weekly swing
  structure from the PRIOR 65 RTH sessions (−1/0/+1), slot dummies.
- **Label:** NQ direction over the next 60 minutes (to the 16:59 close
  for pre-close) — the user's chosen "move from this briefing to the
  next one (30–90 min)".
- **Fit:** logistic regression, gradient descent + L2; features
  standardized with train stats. **Strict temporal split** — train on the
  first 70% of sessions by date, evaluate on the last 30% (no shuffle).

## Result — the honest headline

Direction over the next ~60 minutes is **barely predictable** from these
features:

| Metric (out-of-sample) | Value |
|---|---|
| direction accuracy | **50.6%** |
| always-up baseline | 51.6% |
| mean fwd move when predicted up | +0.10 bp |
| mean fwd move when predicted down | −0.68 bp |

Threshold sweep (only calls where the model is confident, |p−0.5| > τ):

| τ | call rate | accuracy |
|---|---|---|
| 0.01 | 89% | 51.4% |
| 0.03 | 61% | 51.6% |
| 0.05 | 37% | 51.9% |
| **0.10** | **10%** | **56.3%** |

Only the extreme tail (≈10% of briefings) carried a small edge. Fitted
coefficients (standardized, slot dummies included):

```
chgPct +0.224   closePos −0.023   cumDelta +0.085   realized +0.146
htfD +0.017    htfW −0.097
evening-open +0.122  pre-open +0.058  post-open +0.036
mid-morning +0.189   midday +0.169     pre-close −0.057
```

Notable: momentum features are weak and mixed-sign at this horizon
(positive change barely predicts continuation; weekly HH/HL leans
slightly against the next hour — a pullback-from-strength tilt). The
per-slot numbers: pre-open and post-open carry the biggest forward moves
(±44 bp) yet are the hardest to call (46–56%).

## What this means for the card

`systemVerdict` now uses these fitted weights with **τ = 0.10**: the
bias is **CHOP by default** — the data says there is usually no
directional edge at this horizon — and up/down only when the fitted
score clears the band, with the historical confidence shown on the chip
(e.g. `UP 57%`). The model explains the verdict; it cannot change it.

## Known limits / honest bounds

- **ES relative strength** was in the first fit (coefficient unstable:
  +0.16 on 120 sessions, −0.24 on 649) and is NOT usable at briefing time
  (no live ES tape in the pipeline) — excluded from the wired model.
- **GEX/VIX** have no archive, so they stay out of the score (GEX feeds
  the level lines; VIX feeds the vol chip, which remains mechanical).
- Direction is a coin flip in-sample-of-noise; **do not over-trust an
  up/down call** — 56% historical accuracy at τ=0.10 is a tilt, not an edge
  to size against. The card's watch-fors (levels) are the actionable part.
- Label is 60-minute direction; other labels (magnitude, next-session)
  were not fitted.

Re-run: `node --env-file=.env.local --import ../scripts/ts-loader.mjs
scripts/biasFit.ts --no-es --dump /tmp/biasfit.json` from `web/`.
