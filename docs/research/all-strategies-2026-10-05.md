# All strategies — unified results (2026-10-05)

One uniform treatment across every bar-based strategy family in the
codebase, so families are directly comparable: own signal stop (entry −
1×risk where the detector stores no stop) · 1R target · 60-bar time exit
· 0.5pt round trip · sequential one-trade-at-a-time per family · all 649
sessions (Dec 2023 → Oct 2026). `web/scripts/allStrategiesStudy.ts`.

| Family | Signals | Trades | WR | PF | Net pts | expR | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|
| momentum (failed-flush) | 2,121 | 1,559 | 75.4% | 2.71 | 3,394 | +0.44 | 76.6% | 72.1% | 78.8% |
| expansion (huge-bar) | 4,909 | 2,935 | 77.4% | 2.97 | 7,344 | +0.47 | 78.4% | 75.5% | 78.9% |
| mom+exp (time-ordered, live) | 7,030 | 3,171 | 76.7% | 2.86 | 7,565 | +0.46 | 77.4% | 75.0% | 78.2% |
| mom+exp (optimizer order) | 7,030 | 2,326 | 76.4% | 2.86 | 5,456 | +0.46 | 75.9% | 74.3% | 79.9% |
| rth soft-continuation | 10,860 | 2,794 | 76.9% | **3.22** | 12,250 | +0.51 | 76.0% | 77.9% | 77.4% |
| open drive | 554 | 554 | 69.5% | 2.21 | 7,116 | +0.37 | 65.2% | 68.2% | 76.7% |
| open pullback | 460 | 330 | 67.3% | 2.06 | 1,807 | +0.34 | 61.5% | 70.2% | 75.8% |
| open sniper | 167 | 167 | 81.4% | 4.17 | 1,964 | +0.60 | 77.6% | 75.0% | 97.6% |
| sweep-reclaim v2 | 17,358 | 7,064 | 54.8% | 1.10 | 3,596 | +0.05 | 54.9% | 53.7% | 55.8% |
| balance break | 4,140 | 3,207 | 52.0% | 1.05 | 1,464 | +0.02 | 51.3% | 51.7% | 53.8% |

## Which family is which

- **momentum (failed-flush)** — the flagship LVN-reversal scalp: a flush
  below a level that fails and reclaims with a one-sided bar. Live.
- **expansion (huge-bar)** — the huge-bar breakout trigger. Live.
- **mom+exp** — the pair the feed actually trades; the second row is the
  same pair in time order (what a real feed executes), the third is the
  mom-first order all the optimization studies used (reproduces the
  published baseline n=2,326 / 76.4% / 2.86 exactly).
- **rth soft-continuation** — 9:30+ continuation of the overnight trend.
  Live but tagged experimental; highest PF of the live families.
- **open drive / pullback / sniper** — first-hour open plays (sniper is a
  resting-limit variant). Gated by FEED_* env; sniper's 81.4%/4.17 sits on
  only 167 trades (2026 WR 97.6% — small-sample, treat with suspicion).
- **sweep-reclaim v2** — liquidity-sweep reversal. Research-only; at 1R
  it is a coin flip minus costs (PF 1.10, expR +0.05) — matches its own
  study's verdict.
- **balance break** — failed balance-area breakout. Research-only;
  PF 1.05, expR +0.02 — no edge at 1R (its own study found the edge only
  in narrow counter-side cells).
- **absorption / one-sided reclaim** (footprint-based, separate pipeline,
  not in this run) — published: aligned stack ~45% WR / PF ~2.2
  (docs/research/FOOTPRINT_REVERSAL_RESEARCH.md).
- **options/gamma and price-action location** — context boxes, not trade
  strategies.

## Cost reality check

All numbers above are at 0.5pt. At the measured live cost (0.95pt),
expR +0.02–0.05 families (sweep-reclaim, balance break) go NEGATIVE —
they sit below the cost floor entirely. The viable families at real
costs are momentum/expansion/RTH (expR +0.44–0.51 gross of sizing).

## Where the optimization fits

The entire sizing/stop/target campaign (sizing-optimizer doc) applies to
the **mom+exp pair only** — that is the live-traded family. Baseline
76.4% / PF 2.86 / $160,711 → new pick (0.35× stop · 2.25R · 60-bar) at
×2 under measured costs: 69.2% / PF 2.78 / $359,716 PASS.
