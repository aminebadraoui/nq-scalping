# Reversal price-action gate — keep it or remove it? (2026-10-16)

> Question: *"Should we remove the price-action box from the reversal card gate?"*
> CLI: `web/scripts/reversalGateStudy.ts`. Answer up front: **keep the gate.**
> The ~24% of trades it blocks test at ≈0 expectancy out-of-sample; the trades
> it keeps improve out-of-sample. Removing it adds volume, not edge. Follow-ups
> in the same harness: **hour-gated coverage** (dead overnight hours cut — test
> expR 1.10 → 1.29) and a **stop/slip sweep** (the 5-pt stop beats the 7-pt
> stop on per-trade R and PF at every slippage level tested).

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ 1-min · RTH (09:30–16:00 ET; bars 08:30–14:59 on the feed clock — the 390-bar session) |
| Sample | 656 sessions (Dec 2023 → Sep 2026) · replay from bar 15 · 1,432 scored trades (arm A) / 1,781 (arm B) |
| Cost model | 0.5 pt round-trip (no stop slippage in the base run — idealized 0, declared; swept below) |
| Fill model | market-entry replay (bar midpoint) · pessimistic same-bar exit · stop-first |
| Exit model | nearest POC target / 7-pt scalp stop / 60-bar time exit |
| Split | 70/30 by date (train < 2026-01-01 ≤ test) |
| Significance | Wilson 95% CI on WR |
| Stack | the shipped reversal pipeline: `readMechanism` + `readPriceAction` + `composeSignals`/`cardGateOpen` + the live maybeSend footprint filters (aligned stack + entry-bar delta) · one-trade-at-a-time overlay (60s flat-gate latch = minGapBars 1) · no gamma box (context-only, never votes; no historical data) |
| CLI | `web/scripts/reversalGateStudy.ts` |

The study replays the **live** signal pipeline bar by bar and compares two arms
that differ in exactly one line of the composer:

- **A (current)** — `composeSignals([boxFromMechanism, boxFromPriceAction])`:
  the PA box must vote the same side. A neutral PA blocks the card as
  *"long, but not every box has voted yet"*; an opposite PA blocks it as
  CONFLICT.
- **B (proposed)** — `composeSignals([boxFromMechanism])`: PA is removed from
  the gate entirely.

Everything else is identical for both arms: the 6-ingredient checklist gate
(all 3 required `yes` + present ≥ 4/6), the two footprint filters, the
dedupe-by-reclaim episode, the 7-pt stop / nearest-POC target ticket, the
sequential overlay, and the scorer. Each arm's trades are decomposed further:
`B∩neutral`/`B∩opposite` (B fires whose PA voted neutral/opposite at the fire
bar) and `B∖A` (episodes that fire under B and **never** fire under A — the
trades removing the gate genuinely adds).

## Results

### T1 — core quality (the two gate arms)

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A · all | 1,432 | 27.2% [24.9–29.5] | +44.80 | 7.48 | 5.99 | +6.72 | +0.96 | 2.23 | 8.1 | 211.2 | 0.36 | 23.9% |
| A · train | 1,015 | 28.0% [25.3–30.8] | +40.33 | 7.47 | 5.40 | +5.90 | +0.84 | 2.10 | 6.6 | 211.2 | 0.36 | 32.1% |
| A · test | 417 | 25.2% [21.3–29.6] | +56.88 | 7.50 | 7.58 | **+8.71** | **+1.24** | **2.55** | 4.8 | 178.2 | 0.37 | 52.1% |
| B · all | 1,781 | 28.0% [26.0–30.1] | +42.85 | 7.48 | 5.73 | +6.62 | +0.95 | 2.23 | 9.0 | 203.4 | 0.37 | 20.7% |
| B · train | 1,265 | 29.2% [26.8–31.8] | +39.53 | 7.48 | 5.29 | +6.27 | +0.90 | 2.19 | 7.7 | 203.4 | 0.39 | 27.4% |
| B · test | 516 | 25.0% [21.5–28.9] | +52.40 | 7.48 | 7.00 | +7.49 | +1.07 | 2.33 | 4.9 | 135.5 | 0.37 | 48.9% |

`VERDICT: edge real · significance — · stability stable (train/test WR 28.0/25.2, exp +5.90/+8.71) · holdout n/a · viability weak (P=0.86, maxDD 148% of MLL)`

`VERDICT (proposed arm B): edge real · significance — · stability gray (train/test WR 29.2/25.0) · holdout n/a · viability weak (P=0.85, maxDD 142% of MLL)`

The comparison is not subtle: **A dominates B out-of-sample** (test PF 2.55 vs
2.33, exp +8.71 vs +7.49, expR 1.24 vs 1.07). Both arms carry a real per-trade
edge; removing the PA gate adds ~350 trades (+24.4%) that dilute it.

### T2 — what the PA gate actually removes (the vetoed cohorts)

| # | rule / cell | n (test) | WR [CI95] | PF | exp (pts) | train/test WR | exp (pts) train → test |
|---|---|---|---|---|---|---|---|
| 1 | **A · PA gate (current)** | 417 | 25.2% [21.3–29.6] | **2.55** | **+8.71** | 28% / 25% | +5.90 → +8.71 |
| 2 | B · OF-only gate (proposed) | 516 | 25.0% [21.5–28.9] | 2.33 | +7.49 | 29% / 25% | +6.27 → +7.49 |
| 3 | B∩ · PA neutral (fires at a neutral PA) | 116 | 19.8% [13.6–28.0] | 1.14 | +0.82 | 32% / 20% | +7.42 → +0.82 |
| 4 | B∩ · PA opposite (CONFLICT veto) | 2 | — | — | — | — | — | n=9 all-time — the conflict path is ~1.4% of gate-open bars |
| 5 | B∖A · new episodes only (never fire under A) | 101 | 22.8% [15.7–31.9] | 1.35 | +2.04 | 33% / 23% | +6.87 → +2.04 |

The vetoed cohorts are the whole story. The trades the PA gate blocks looked
**good in-sample** (train +6.87/+7.42 pts, PF 2.38/2.46, WR 32-33%) and decay
to **≈0 out-of-sample** (test +0.82/+2.04 pts, PF 1.14/1.35, WR 20-23%) — the
classic signature of a filter that is earning its seat, not curve-fitting.
Meanwhile the trades the gate KEEPS improve out-of-sample (+5.90 → +8.71).

Gate anatomy (656 sessions): the OF-only gate opened on 15,124 bars; the PA
gate on 11,124 — PA blocked 26.4% of gate-open bars (25.1% neutral "hasn't
voted yet", 1.4% opposite). Episode-level: 1,481 fired under A vs 1,836 under
B (+24%); of the 1,480 shared episodes, B fires at the **same bar** in all but
a handful — the gate costs essentially **zero latency**. Its entire value is
selectivity: the 356 episodes it kills are exactly the OOS-dead cohort above.

### T4 — prop-account viability (both arms, identical sizing)

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A · eval | Rapid EOD 50k | 1,432 | 506 | $134,740 | $4,191 | ✓ | ✓ | 2024-04-08 ($6,153) | — | — | breach 2024-04-08 |
| A · eval (test-only) | Rapid EOD 50k | 417 | 146 | $50,855 | $4,191 | — | — | 2026-04-15 ($15,272) | — | — | breach 2026-04-15 |
| B · eval | Rapid EOD 50k | 1,781 | 545 | $165,141 | $4,445 | ✓ | ✓ | 2024-04-15 ($8,248) | — | — | breach 2024-04-15 |
| B · eval (test-only) | Rapid EOD 50k | 516 | 156 | $54,098 | $4,191 | — | — | — | 2026-02-24 | — | PASS 2026-02-24 · consist ✓ (funded: 104 payouts) |

P(pass before breach, 500 day-order reshuffles): A = 86%, B = 85% · median
days to pass 27/24 · maxDD: A $2,958 = 148% of MLL, B $2,847 = 142% of MLL.

Both arms fail the deployment bands (P < 0.90, maxDD ÷ MLL > 70%) — the
reversal card's viability problem is sizing/drawdown, **not** the PA gate, and
it predates this study (the family is retired for exactly this class of
reason). B's test-only actual-order pass is day-order luck, not a plan: the
bootstrap says the system vs luck split is ~85/15 for B and ~86/14 for A.

### Stability by year (arm A, exp pts)

- 2023 n=12 WR 50% +7.82 · 2024 n=468 WR 30% +5.96 · 2025 n=535 WR 26% +5.81 · 2026 n=417 WR 25% +8.71 — positive every full year.

`VERDICT (the gate): keep the PA gate · significance — · stability of the vetoed cohort: decay (train +7.42 → test +0.82) · holdout n/a · viability n/a (sizing problem, both arms)`

## Coverage extension — full session, then hour-gated (volume lever)

Same harness, `--session eth` (the full 18:00→17:00 ET day). The live card
runs the whole session; the RTH study above was the canonical sample only.

| cohort (arm A) | n | WR [CI95] | PF | exp (pts) | exp (R) | maxDD (pts) | P(pass) |
|---|---|---|---|---|---|---|---|
| RTH only (baseline) | 1,432 | 27.2% [24.9–29.5] | 2.23 | +6.72 | +0.96 | 211.2 | 86% |
| full session | 1,975 | 26.2% [24.3–28.2] | 2.07 | +5.88 | +0.84 | 208.4 | 78% |
| **hour-gated session** | **1,510** | 24.4% [22.3–26.6] | **2.23** | **+6.97** | **+1.00** | **172.5** | **80%** |

Full-session coverage adds +38% trades but almost all of the added volume sits
in hours with ≈0 or negative edge — the per-trade dilution (test expR 1.10 vs
1.24) is the dead hours' doing. **Hour gate** (selected on TRAIN only, rule:
include a feed-clock hour iff train n ≥ 30 and train exp > +2.0 pts → hours
07–15 = 08:00–16:00 ET, i.e. pre-open + RTH + the post-close hour):

| hour-gated (arm A) | n | WR [CI95] | PF | exp (pts) | exp (R) | maxDD (pts) |
|---|---|---|---|---|---|---|
| all | 1,510 | 24.4% [22.3–26.6] | 2.23 | +6.97 | +1.00 | 172.5 |
| test (OOS) | 370 | 20.8% [17.0–25.2] | 2.52 | **+9.05** | **+1.29** | 160.2 |

The hour gate survives out-of-sample: test expR **1.10 (full) → 1.29
(hour-gated)** — better than both the full session and the RTH baseline —
with maxDD 172.5 pts and maxDD$ 121% of MLL (vs 148% RTH, 146% full). Volume
is ~RTH +6%: coverage alone is a **quality** lever, not a volume lever. The
honest volume answer: coverage buys +39% volume, of which only ~1/6 survives
the hour gate.

## Stop / slip sweep — the per-trade economics lever

Identical signals, re-scored per cell (one-trade overlay re-run per cell).
`--slip-sweep` grid: 5-pt and 7-pt stops × 0 / 0.25 / 0.5 / 1.0 pt stop
slippage (the 2026-10-08 fill-model discipline: sweep, never idealize).

### RTH (arm A)

| stop | slip | ALL PF | TEST n | TEST WR | TEST PF | TEST exp (pts) | TEST exp (R) | P(pass) |
|---|---|---|---|---|---|---|---|---|
| 7 | 0 | 2.23 | 417 | 25% | 2.55 | +8.71 | +1.24 | 86% |
| 7 | 0.25 | 2.16 | 417 | 25% | 2.47 | +8.52 | +1.22 | 82% |
| 7 | 0.50 | 2.09 | 417 | 25% | 2.39 | +8.34 | +1.19 | 80% |
| **5** | 0 | 2.41 | 418 | 22% | **2.87** | +8.00 | **+1.60** | 76% |
| 5 | 0.25 | 2.31 | 418 | 22% | 2.75 | +7.81 | +1.56 | 69% |
| 5 | 0.50 | 2.21 | 418 | 22% | 2.63 | +7.61 | +1.52 | 63% |
| 5 | 1.00 | 2.04 | 418 | 22% | 2.43 | +7.22 | +1.44 | 51% |

### Hour-gated session (arm A)

| stop | slip | ALL PF | TEST n | TEST WR | TEST PF | TEST exp (pts) | TEST exp (R) | P(pass) |
|---|---|---|---|---|---|---|---|---|
| 7 | 0 | 2.23 | 370 | 21% | 2.52 | +9.05 | +1.29 | 80% |
| 7 | 0.25 | 2.16 | 370 | 21% | 2.44 | +8.85 | +1.26 | 76% |
| 7 | 0.50 | 2.09 | 370 | 21% | 2.37 | +8.65 | +1.24 | 73% |
| **5** | 0 | 2.44 | 372 | 17% | **2.73** | +7.95 | **+1.59** | 71% |
| 5 | 0.25 | 2.33 | 372 | 17% | 2.62 | +7.74 | +1.55 | 65% |
| 5 | 0.50 | 2.23 | 372 | 17% | 2.51 | +7.53 | +1.51 | 58% |
| 5 | 1.00 | 2.06 | 372 | 17% | 2.31 | +7.12 | +1.42 | 46% |

Reading: **the 5-pt stop improves per-trade R and PF at every slippage level
tested** (e.g. 5/0.5 still beats 7/0: +1.51R vs +1.24R, PF 2.51 vs 2.55 on
hour-gated... on RTH 5/0.5 = 2.63 vs 7/0 = 2.55). It also degrades faster per
0.25 pt of slippage (~0.08R vs ~0.01R) — exactly the tight-stop slippage
sensitivity the fill-model discipline predicts. P(pass) degrades with the
tight stop because the harness sizes at a 1-contract floor; at fixed dollar
risk (1.4× contracts for 5 pt) the per-trade dollar volume scales up. That
conversion — not the stop choice — is the viability question, and it still
fails the deployment bands either way.

## What this falsifies and what it confirms

1. **Falsifies: "the PA gate is just latency / a nuisance that delays cards."**
   It costs ~0 bars of timing (shared episodes fire on the same bar) and its
   24% episode kill is its entire function — a function the test window says
   is doing real work.
2. **Falsifies: "PA only ever agrees anyway, so removing it is free."** Genuine
   conflicts are ~1.4% of gate-open bars (n=9 trades in 656 sessions) — the
   veto is almost never a CONFLICT veto. But the *neutral* block ("not every
   box has voted yet") is 25.1% of gate-open bars and those are the trades
   that die out-of-sample.
3. **Confirms the PA box's design intent** (`docs/strategy/PRICE_ACTION_SIGNAL.md`:
   "a location filter, not a trigger"). A filter that adds ~0 in-sample
   (train +5.90 vs +6.27 without it) and protects the out-of-sample edge is
   exactly what a location filter is for.
4. **Coverage is a quality lever, not a volume lever.** Full-session replay
   adds +38% trades, but the hour gate (train-selected, OOS-verified) shows
   only ~1/6 of that volume has edge: the right card is the hour-gated full
   session (test +1.29R, maxDD$ 121% of MLL).
5. **The 5-pt stop is the per-trade economics win** (+1.60R vs +1.24R test on
   RTH at slip 0; better R and PF at every slip level) with the expected
   slippage-sensitivity gradient — the decision to switch is a slippage-model
   + sizing decision, not an edge question.
6. **The reversal family's viability problem is unchanged and unrelated to
   the gate**: every config sits at 121–148% of MLL drawdown and P(pass)
   46–86%. Re-enabling the reversal product needs a sizing/plan fix first.
7. **Harness cross-check**: arm A's +6.72 pts / PF 2.23 sits next to the
   original footprint-reversal study's +5.4 pts / PF 2.16 (STRATEGY.md,
   different per-bar vs per-episode conventions) — the replay machinery
   reproduces the known numbers.

## Honest bounds

- **~2–3-bar lookahead in event detection**, inherited from the production
  analyzers: a reclaim is confirmed by the next 2 bars, absorption progress by
  the next 3, divergence pivots are ±2-bar local extremes. Same caveat the
  original reversal harness carried; the ranking of the two arms shares it
  identically, so the *comparison* is unaffected.
- Event detection is precomputed once per session (HVN tagging and the
  absorption volume floor use the full-session profile); the per-bar
  readMechanism/readPriceAction/gate evaluation is rolling and windows events
  by bar index — only event *detection*, not event *usage*, sees the full day.
- **Stop slippage swept, not calibrated**: the grid above is a sensitivity
  map; the honest slip value comes from the live slippage-alarm journal
  (execWatch), not from this grid.
- Replay starts at bar 15 (enough for the ±2-bar divergence pivots and the
  6-bar stack age while keeping the 09:30 ET open inside the window).
- The hour gate was selected on TRAIN hours only (pre-registered rule: train
  n ≥ 30 and train exp > +2.0 pts) and verified on test — but it is one
  selection over 24 cells, so it carries selection risk; treat the test
  numbers as the first OOS confirmation, not a frozen holdout.
- No gamma/options box (context-only, never votes — cannot change the
  comparison) and no news-window veto (context ingredient = "yes" in replay).
- Location stack = prior-day RTH + prior-day ETH + 5-day RTH composite from
  the archive + the rolling developing P0 profile (lookahead-free), an
  approximation of the live Neon sheet (which adds opening-range/overnight
  profiles).
- Entry at the trigger bar's midpoint; trades whose POC target sat on the
  wrong side of entry are unscorable and dropped identically in both arms.
- Thin cells: B∩neutral test n=116, B∖A test n=101, hour cells n=16–307 —
  usable with caution; B∩opposite n=9 — never claimed.
- The vetoed cohorts' train→test decay (PF 2.38-2.46 → 1.14-1.35) is the
  strongest single line of evidence here; their train numbers are what the
  decision-maker would have seen in 2025, which is precisely why the OOS split
  matters.

## Regenerate

```bash
cd web
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/reversalGateStudy.ts --dump /tmp/reversal-gate-rth-final.json
# full-session coverage extension:
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/reversalGateStudy.ts --session eth --dump /tmp/reversal-gate-eth-final.json
# hour-gated full session + stop/slip sweep (the recommended config):
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/reversalGateStudy.ts --session eth --hours 7,8,9,10,11,12,13,14,15 \
  --slip-sweep --dump /tmp/reversal-gate-hourgated.json
# warm the archive first if the local cache is cold:
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/reversalGateStudy.ts --warm
```
