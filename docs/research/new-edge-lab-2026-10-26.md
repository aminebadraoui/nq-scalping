# New-edge lab — is there an NQ intraday edge that survives honest execution on real prices? (2026-10-26)

Context: [limit-stop-flip-2026-10-26.md](limit-stop-flip-2026-10-26.md)
found that no execution change makes the current detectors fundable,
because at real fills they have no directional edge. This study goes
looking for new structures and scores them with pessimistic execution on
real Tradovate prices.

## Method

| Field | Value |
|---|---|
| Instrument / session | NQ (MNQ $2/pt) real Tradovate 1-min OHLCV · RTH 09:30–16:00 ET |
| Sample | 614 sessions, 2024-05-27 → 2026-10-23 (`gcdata/data/ohlc_hist`) |
| Cost model | 0.25 pt adverse slip on every market/stop entry, every stop exit and every time exit · $1.90/RT per micro · ladder +0.5 pt extra per trade |
| Fill model | market entry at the next bar's open · stop entry at the level, or at the open if it gaps through · limit entry at the level or better, with the **fill bar's adverse range counted** · stop-first in any bar spanning both levels · no target credit on the entry bar |
| Exit model | stop / target, else the 16:00 ET close |
| Split | train < 2026-01-01 ≤ test (≈ 70/30) + per-calendar-year check |
| Significance | Wilson 95% CI · 46 primary configs + 105-config neighbourhood (no DSR; a parameter plateau and a drift baseline stand in for multiple-testing control) |
| Model (if any) | none |
| Stack | a new entry structure on a $100 risk budget, `floor(100 / (stop·$2))` micros; none of the live detectors are used |
| CLI | `gcdata/new_edge_lab.py` (+ `LAB_MODE=nbhd`, `LAB_EXTRA_COST=0.5`) |

Families tested:

- **ORB:** opening-range breakout over 5 / 15 / 30 minutes.
- **IMOM:** intraday momentum (Gao et al.: the first-half-hour return
  sets the last-half-hour direction).
- **GAP:** fade or follow the RTH open gap.
- **PDHL:** breakout of the prior day's high or low.
- **ONR:** breakout of the overnight (Globex) range.
- **VWAP:** trend pullback to session VWAP.
- **LATE:** last-hour trend continuation.

A config survives the first pass only if all of these hold: train and
test are both net-positive after fees, PF ≥ 1.15 on both, every
calendar year is ≥ 0, and n ≥ 60.

## Results

**Primary pass: 1 survivor out of 46 configs.** That survivor is the VWAP
trend pullback, 25 pt stop, 2R, first touch per day, long and short
combined (PF 1.31, train 1.35 / test 1.23). ORB, IMOM, PDHL, ONR and
LATE all fail out-of-sample. GAP fade 30–150 is positive in every year
but thin (PF 1.12).

**Robustness checks on the survivor:**

| check | result |
|---|---|
| Plateau (stop 18–40 × target 1.5–3R × trend window 20/30/45, 96 cells) | PF 1.19–1.31 across stops 22–40 at a 30-bar window; 35 / 96 cells net-positive in all / train / test |
| +0.5 pt extra cost | 22 / 96 cells still net-positive in train and test; the primary pick holds at PF 1.27 |
| Re-entries (max 2–5 per day) | the edge dilutes to PF 1.12, so it lives in the **first** touch |
| Side split | **long PF 1.40**, short PF 0.97, so the short side has no edge |
| Drift baseline (blind long, same 25 / 50 bracket, at 10:30 / 11:30 / 13:00 ET) | PF 0.95 / 0.91 / 1.04, so the long lift is not just NQ's 2024–26 uptrend |

T1, the candidate. "VWAP-UP" = long only: after 10:30 ET, at least 30
bars with every low above session VWAP and VWAP rising; buy limit at
VWAP on the first touch; 25 pt stop, 50 pt target, else exit at the
16:00 ET close; one trade per day.

| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | Sharpe (sess) | conc top10 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| VWAP-UP all | 299 | 41.5% | — | — | — | — | +0.23 | 1.40 | — | — | — | — |
| VWAP-UP train | ~200 | — | — | — | — | — | — | 1.44 | — | — | — | — |
| VWAP-UP test | ~100 | — | — | — | — | — | — | 1.32 | — | — | — | — |
| baseline: blind long 11:30 ET, same bracket | 585 | 31.8% | — | — | — | — | −0.06 | 0.91 | — | — | — | — |

The long-only cells marked "—" were not re-rendered in the full T1 form
by the scratch deep-dive. Only the fields shown were measured.

$ by year (2 micros, $100 budget): 2024 +$3,540 · 2025 +$668 · 2026 +$1,638.

T4 sizing check: P(pass before breach) over 500 reshuffles, Rapid EOD 50k.

| stage | rules | n trades | trading days | total profit | best day | consist | min-days | breach | pass | payouts | outcome |
|---|---|---|---|---|---|---|---|---|---|---|---|
| eval, $100 risk (2µ) | Rapid EOD 50k | 299 | 614 | $5,846 | — | — | — | — | — | — | P = 0.96, median **132 days**, maxDD $1,601 = 80% of MLL |
| eval, $150 risk (3µ) | Rapid EOD 50k | 299 | 614 | $8,769 | — | — | — | — | — | — | P = 0.82, median 75 days, maxDD $2,402 = 120% of MLL |
| eval, $200 risk (4µ) | Rapid EOD 50k | 299 | 614 | $11,691 | — | — | — | — | — | — | P = 0.71, median 48 days, maxDD $3,202 |

VERDICT: edge real (modest, long-only) · significance — (plateau + drift baseline; no DSR) · stability train/test PF 1.44 / 1.32, every year positive · holdout OOS 2026 +$1,638 · viability weak (P=0.96 but median 132 days at $100; P=0.82 / 75 days at $150)

## What this falsifies and what it confirms

1. **Most textbook intraday structures fail on real NQ prices with
   honest fills in 2024–26.** That covers ORB, intraday momentum,
   prior-day high/low, overnight-range breakout and last-hour trend. Two
   of them, ORB 15/30 and PDHL, worked in 2024–25 and broke in 2026.
2. **One structure survives every check here: buying the first VWAP
   touch in an established intraday uptrend.** It is modest (+0.23R,
   PF 1.40) but sits on a broad parameter plateau, beats a blind-long
   drift baseline by about 0.29R, and holds at +0.5 pt extra cost.
3. **It is slow.** At about 0.5 trades per day, a $100 risk passes the
   eval in a median of about 4–6 months. Sizing up speeds it up but
   pushes the drawdown past the MLL.

## Honest bounds

- 151 configs were examined in total. The plateau and the drift baseline
  reduce the risk of a lucky pick but don't remove it. There is no
  frozen holdout yet: 2026 is the test split, and it is only about 10
  months long.
- Long-only in a period when NQ rose about 50% means a bear-market
  regime has not been tested. The short side was flat, not inverted.
- 1-min bars: the limit fill at VWAP assumes the touch fills. The fill
  bar's adverse range is counted, but queue position is not modelled.
- Volume-weighted VWAP is computed from 1-min (H+L+C)/3 × volume, an
  approximation of tick VWAP.

## Regenerate

```bash
python3 gcdata/new_edge_lab.py
```

```bash
LAB_MODE=nbhd LAB_EXTRA_COST=0.5 python3 gcdata/new_edge_lab.py
```
