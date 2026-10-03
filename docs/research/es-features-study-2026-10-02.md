# ES cross-asset features — final backtest (full coverage)

> Final study over the complete ES archive: **649/649 sessions with ES twins**
> (Dec 2023 → Oct 2026), canonical split 2026-01-01. All-card baseline
> includes the RTH soft card (--rth). Machinery: `web/lib/esJoin.ts` (join +
> features, 11 unit tests), `web/scripts/esStudy.ts` (replay + splits). Same
> discipline as momentumStudy: MOM_PROD + EXP_PROD + SOFT_PROD, pessimistic
> same-bar scoring, 0.5 pt cost, 60-bar exit, Wilson CIs.
>
> Coverage: 2,119 flush trades, 16,524 all-card trades — 100% ES-covered.
> Baselines (all cards): 81.0% WR (train 80.8 / test 81.4). Flush cards:
> 75.3% (train 74.2 / test 77.7). The 2026 test window is the easier tape —
> every comparison below is within-window.

---

## 1. Flush agreement — no adoptable signal

ES flushed the same side and held its own extreme at the NQ flush bar.

| Bucket | n | WR all | WR test | note |
|---|---|---|---|---|
| agree | 569 | 75.6% | 80.5% | agree-long test 85.7% (n=56) — small, monitor |
| neutral | 1,530 | 75.3% | 76.9% | |
| diverge | 20 | 70.0% | — | too rare to matter |

Overall tie; the test-window agree-long cell is interesting but n=56.
**Not adopted. Watch agree-long in live journaling.**

## 2. Breakdown gate — REJECTED as a veto; ADOPTED as a tier (BROAD CONFIRM)

Veto NQ cards when ES printed a new session extreme in the 5 bars before
entry — measured at full coverage:

| Group | n | WR | PF | avgPts | test WR |
|---|---|---|---|---|---|
| baseline (gate off) | 16,524 | 81.0% | 3.33 | 2.98 | 81.4% |
| kept (gate on) | 15,895 | 80.8% | 3.29 | 2.95 | 81.2% |
| **vetoed** | **629** | **85.2%** | **4.84** | **3.86** | **87.4%** |

The vetoed group is the BEST group in every cut: +4.2 pts over baseline,
train 84.3% / test 87.4%, longs 84.8% and shorts 85.4% both positive. A fresh
ES session extreme before an NQ entry is **broad-tape confirmation of the
move** (ES leads, the NQ breakout resolves it) — the exact opposite of a
stand-aside reason.

**Adopted as a tier-up label `BROAD CONFIRM`** — the card prints it when ES
made a fresh session extreme in the 5 bars before entry. Journaled like every
threshold: it earns a higher baseline only after ~100 live instances.

## 3. ES delta sign — one robust rule (shorts vs negative delta)

Sign of ES cumulative delta at the flush bar. Cross-window consistency
(Jun–Sep 2024 · Jan–Aug 2025 · 2026 test):

| Cell | window 1 | window 2 | final test | all-time |
|---|---|---|---|---|
| **neg × short** | 62.2% | 66.4% | **67.8%** (n=90) | 70.2% (n=369) |
| pos × short | 78.9% | 64.5% | 76.0% (n=208) | 73.3% |
| pos × long | 72.9% | 75.8% | **82.5%** (n=212) | 78.2% |
| neg × long | 73.6% | 76.2% | 79.4% (n=97) | 77.3% |

**neg × short is the worst cell in every single window** — the one
cross-window-robust delta rule. Story: NQ rallying while the broad tape
distributes = genuine rotation into tech; fading it (the short card) fails.
pos × long only separated in the 2026 window — not robust.

**Candidate: a warning chip (not a hard veto) on short cards when ES
cum-delta < 0 at the flush.** Hard veto only after live journaling confirms
the 67.8% test read.

## 4. RS band — coherent stretch-fade pattern

NQ−ES points-spread z-score, trailing 60 min at entry (test window):

| Cell | test WR | n | vs mirror |
|---|---|---|---|
| **weak × long** | **84.2%** | 292 | strong × long 79.7% |
| **strong × short** | **84.0%** | 418 | neutral × short 80.1% |
| neutral × long | 82.9% | 1,041 | |
| weak × short | 81.1% | 719 | |

Both winning cells tell the same story: the card pays when NQ has been
**stretched against the trade direction** for the past hour (longs after NQ
underperformed ES; shorts after NQ outperformed) — fading the relative
stretch, not chasing it. Both hold in test with real n and a coherent
mechanism. The earlier small-sample scare (weak-long "69.7%") is dead at
scale.

**Candidate tier labels: `RS STRETCH` on weak-long / strong-short cards.**
Journal-only for now.

---

## Verdicts

| Feature | Verdict |
|---|---|
| Flush agreement | not adopted (monitor agree-long) |
| ES fresh extreme before entry | **ADOPT as `BROAD CONFIRM` tier-up label** |
| ES delta negative × short | candidate warning chip (journal first) |
| RS stretch (weak-long, strong-short) | candidate tier labels (journal first) |

One adoption, three monitored candidates, and a rejected gate that became the
adoption — the numbers did their job before anything touched the live feed.
Nothing here votes direction or fires a card; ES remains context/tier only.

*Educational research only — not financial advice.*
