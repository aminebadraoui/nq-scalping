# Seasonal almanac — every calendar window, measured

> First measurement pass over the full NQ archive: **649 sessions** (2023-12-18
> → 2026-10-02), canonical split 2026-01-01 (471 train / 177 test days).
> Machinery: `web/scripts/seasonalAlmanac.ts` — day-level windows (Part A),
> hour-of-day drift (Part B), and the same windows sliced across the momentum
> card replay (Part C, esStudy discipline: MOM_PROD flush + EXP_PROD,
> sequential one-trade-at-a-time, pessimistic same-bar exit, 0.5 pt cost,
> 60-bar exit, Wilson CIs).
>
> Conventions: session date = RTH calendar date; day return = close-to-close
> of the session's last traded minute (weekend/halt gaps count); hours in ET;
> NQ points. FOMC = Fed decision days (official calendar), holidays = CME
> full-close days, early closes flagged separately.
>
> **Headline:** the card's edge is NOT uniform across the clock or the
> calendar. FOMC days are the best cell in the whole overlay (83.8% WR, train
> 81.7 / test 89.3), the day *before* FOMC is the worst (67.4%, test 53.1),
> entry hours 3–7 ET run 79–83% WR with train/test agreement, and 95% of all
> NQ drift lives in the overnight leg — the RTH leg is a coin flip. Everything
> below is lift-vs-baseline on cells, never a standalone signal.

---

## 1. Session legs — the overnight anomaly, measured on NQ

Close-to-close day return split into three legs (n = 648/649):

| Leg | n | up% | mean pts | Σ pts | train | test |
|---|---|---|---|---|---|---|
| preRTH (17:00 CT → 08:30 CT) | 648 | 57.7% | +20.9 | **+13,542** | +21.5 | +19.4 |
| RTH (08:30 → 14:59 CT) | 649 | 52.7% | +0.7 | +461 | −3.7 | +12.4 |
| tail (14:59 → 15:59 CT) | 649 | 46.4% | +0.3 | +206 | +0.5 | −0.1 |

**95% of the archive's total drift (+14,209 pts) sits in the overnight leg.**
The RTH leg is a coin flip (52.7% up, mean +0.7). This is the Lou–Polk–Skouras
overnight anomaly replicated on NQ futures with our own data — and it is the
single strongest *validation of the Globex-only execution window* in the whole
playbook. It also explains why the momentum card produces **zero RTH entries**
in Part C (all 3,266 trades are Globex): the card's tape conditions simply
don't form during the dead-leg hours.

**Adopted as evidence for the existing constraint — no change needed.**

## 2. Day-of-week (close-to-close drift)

| Day | n | up% | mean pts | train | test |
|---|---|---|---|---|---|
| Mon | 120 | **65.0%** | **+80.2** | 67% / +72.8 | 60% / +102.5 |
| Wed | 137 | 56.9% | +50.2 | 59% / +49.1 | 53% / +53.1 |
| Fri | 127 | 56.7% | −10.3 | 58% / −8.8 | 54% / −14.3 |
| Tue | 131 | 52.7% | +6.7 | 53% / −1.6 | 51% / +29.4 |
| Thu | 133 | **45.1%** | −14.5 | 45% / −20.5 | 46% / −0.1 |

Monday is the strongest day (lift 1.18, positive in both windows); Thursday is
the only consistently negative day (lift 0.82). The Monday effect is a known
Globex phenomenon — the Sunday-evening reopen gap lands in Monday's
close-to-close. n ≈ 120–137 per cell, Wilson CIs ±8.

**Day-level: informative only (long-only bias). For the card: see §6 — no
dow cell moves the card's WR meaningfully (all 74.7–77.6%).**

## 3. Month-of-year (close-to-close drift)

| Month | n | up% | mean pts | train | test |
|---|---|---|---|---|---|
| Jun | 52 | 65.4% | +57.5 | 72% / +90.0 | 55% / +5.5 |
| Sep | 57 | 61.4% | +55.9 | 62% / +53.6 | 60% / +60.2 |
| May | 58 | 60.3% | +92.9 | 57% / +65.0 | 67% / +154.9 |
| Apr | 63 | 60.3% | +50.4 | 55% / −12.4 | 71% / +176.1 |
| Jul | 61 | 45.9% | −35.1 | 55% / +1.9 | 29% / −105.6 |
| Mar | 57 | 47.4% | −37.9 | 53% / −27.6 | 35% / −62.1 |

n ≈ 46–63 per cell and the train/test columns disagree in both directions —
exactly the month-effect noise the S&P folklore predicts (and why the video's
out-of-sample warning matters). September's positive drift here is the
**opposite** of the classic "worst month" claim: do not import SPX calendar
folklore into NQ directly.

**Not adopted at day level.** The card-level month cells (§6) tell a cleaner
story: Jan strong, Jun weak — consistent across train/test.

## 4. Event windows (close-to-close drift)

| Window | n | up% | mean pts | train | test |
|---|---|---|---|---|---|
| FOMC day | 21 | 66.7% | +68.3 | 75% / +116.6 | 40% / −86.3 (n=5) |
| pre-FOMC day | 21 | **38.1%** | **−70.4** | 44% / −31.4 | 20% / −195.3 |
| **24h pre-FOMC** (13:00 CT → 13:00 CT) | 21 | **71.4%** | **+94.2** | 63% / +99.0 | 100% / +78.9 (n=5) |
| pre-holiday | 28 | 60.7% | +36.1 | 62% / +37.6 | 57% / +31.6 |
| OPEX day | 33 | 60.6% | +30.6 | 63% / +35.3 | 56% / +18.3 |
| quarter-turn | 57 | 52.6% | −31.3 | 55% / −11.6 | 47% / −86.4 |

The **24h window into the FOMC announcement is positive on NQ** (+94 pts,
71% up) — the Lucca–Moench pre-announcement drift replicates here. The full
pre-FOMC *day* is negative because the drift starts mid-session; the
close-to-close day includes the drag before it. Quarter-turn shows nothing.
The FOMC-day row itself flips in test (n=5) — too thin at day level; the
card-level FOMC cells (§6) are the real signal.

**Not adopted at day level (small n); the actionable FOMC findings are in §6.**

## 5. Hour-of-day drift (long 1h, open-to-open; the MatFinOg measurement on NQ)

n = 649 per hour; net = gross − 0.5 pt. Strongest hours:

| Hour ET | up% | gross | net | train | test |
|---|---|---|---|---|---|
| **13** | 53.8% | +6.35 | **+5.85** | +5.36 | +9.00 |
| 3 | 53.6% | +3.50 | +3.00 | +3.64 | +3.14 |
| 20 | 54.5% | +2.72 | +2.22 | +1.69 | +5.47 |
| 2 | 53.6% | +2.31 | +1.81 | +1.09 | +5.57 |
| 6 | 57.2% | +2.04 | +1.54 | +1.30 | +4.01 |
| 14 | 48.8% | −3.80 | **−4.30** | −1.57 | −9.75 |
| 10 | 51.9% | −2.33 | −2.83 | −3.96 | +2.04 |
| 9 | 51.9% | −2.11 | −2.61 | −2.51 | −1.04 |
| 0 | 50.7% | −1.43 | −1.93 | −1.47 | −1.34 |
| 22 | 49.0% | −2.06 | −2.56 | −0.07 | −7.35 |

Contrast with the video's ES 2018–2026 result: on NQ 2023–2026 the overnight
drift concentrates at 2–3 and 6 ET, the single best hour is **13 ET** (not in
the video's list), and hour 21 ET shows the classic fake-bias signature
(train +4.4 / test −5.1). Hours 9–10 ET (the video's "worst hour to be long")
are negative here too. Hour 14 ET is the most consistent short-drift hour.

**Adopted as context only.** Per-hour raw drift is not a trade; it is the
regime the card trades inside. The overlay in §6 turns it into card-level
facts.

## 6. The momentum-card overlay — where the money is

3,266 sequential trades, baseline **76.8% WR / PF 2.92 / avg +2.38 pts**
(train 75.6% / 2.59, test 79.6% / 3.67). Cells that beat baseline **and
agree across train/test**:

| Cell | n | WR | PF | train | test |
|---|---|---|---|---|---|
| **FOMC day** | 99 | **83.8%** | **5.16** | 81.7% / 4.05 | 89.3% / 9.90 |
| **entry hour 4 ET** | 122 | 82.8% | 4.35 | 80.9% / 3.43 | 87.9% / 7.86 |
| **entry hour 7 ET** | 183 | 81.4% | 3.57 | 79.4% / 2.98 | 88.1% / 5.86 |
| **January** | 317 | 82.3% | 4.20 | 82.1% / 3.76 | 82.6% / 4.70 |
| hour 5 ET | 219 | 79.9% | 3.36 | 79.6% / 2.88 | 80.6% / 4.54 |
| hour 3 ET | 168 | 79.8% | 3.17 | 78.0% / 2.77 | 84.4% / 4.08 |
| pre-holiday | 175 | 79.4% | 3.33 | 78.6% / 2.93 | 82.9% / 4.93 |
| month last-day | 173 | 80.9% | 4.18 | 77.1% / 2.94 | 92.9% / 15.21 (n=42) |
| month first-3 | 490 | 78.4% | 3.35 | 76.7% / 3.00 | 82.5% / 4.16 |

Cells that underperform **with agreement**:

| Cell | n | WR | PF | train | test |
|---|---|---|---|---|---|
| **pre-FOMC day** | 138 | **67.4%** | **1.64** | 71.7% / 1.90 | 53.1% / 1.17 |
| **June** | 274 | 71.9% | 2.27 | 71.9% / 1.99 | 71.8% / 2.57 |
| entry hour 16 ET | 78 | 66.7% | 1.92 | 62.3% / 1.56 | 82.4% / 6.33 (n=17) |
| post-holiday | 132 | 72.7% | 2.31 | 70.7% / 2.26 | 76.0% / 2.37 |
| OPEX week | 656 | 73.8% | 2.52 | 71.2% / 2.08 | 78.5% / 3.46 |

Day-of-week on the card: flat (Tue 74.7% ↔ Thu 77.6%) — the day-level Monday
drift does not translate into card edge, which is expected: the card already
selects its tape.

### Verdicts

- **FOMC-day tier-up: ADOPT as a journal chip** (`FOMC DAY` label on the
  card, like the ES chips — never a gate). Best cell in the study, 99 trades,
  train/test agree, and the day-level FOMC drift explains *why* it should hold.
- **Pre-FOMC stand-aside: ADOPT as a chip with caution** (`PRE-FOMC` label).
  The day before FOMC is the worst cell (PF 1.64 vs 2.92 baseline) and the
  day-level pre-FOMC day is negative — two independent measurements agree.
- **Entry hours 3–7 ET: ADOPT as the prime window label.** Four consecutive
  hours at 79–83% WR with train/test agreement, sitting exactly on the
  overnight-drift leg. Not a filter (the card is thin at other hours and the
  trade still pays), but the hours worth highest conviction.
- **January strong / June weak: journal-only seasonal chips.** The only two
  month cells stable across train/test; both are well-known NQ seasonality
  (tax-loss + rebalance vs. mid-year chop).
- **Month last-day (92.9% test, n=42) and hour 16 ET (66.7%): monitor, do not
  adopt.** Test cells are tiny; the honest read is "unstable".
- **OPEX week: no adoptable edge** (train below baseline, test above — split
  in the middle).

**Implemented 2026-10-05:** the three adopted chips live in
`web/lib/seasonal.ts` (`seasonalChips()`, 13 unit tests) and print on the
momentum card via `web/lib/signalFeed.ts` in the same chip line as the ES
chips — labels only, never gates. `PRE-FOMC` prints only when the day is not
itself a decision day (mutually exclusive by construction). PLAYBOOK.md
carries the chip inventory.

## 7. Method notes and limits

- **Multiple testing:** ~150 cells were measured. The adopted cells are the
  ones with train/test agreement and a mechanism (FOMC drift, overnight
  anomaly), which is the practical substitute for a formal FDR pass; run one
  before any cell becomes a *gate*.
- **Single split, one instrument, 2.8 years.** Month cells especially are
  n ≈ 46–63 — seasonality numbers always need the longest archive available.
  The ES twin can be added with the same script (`loadEsMinutes`).
- The video's lesson reproduced on our own tape: cells that look great
  in-sample and die out-of-sample are everywhere (hour 21 ET, day-level FOMC
  day, month last-day drift). Only train/test agreement survives.

## Regenerate

```bash
cd web
GC_REMOTE_URL=$(grep GC_REMOTE_URL .env.local | cut -d= -f2) \
  node --import ../scripts/ts-loader.mjs scripts/seasonalAlmanac.ts \
  --dump /tmp/almanac.json
```
