# Vol/structure SIZING study — stop × size knobs, zero vetoes (2026-10-04)

**Question:** never gate trades — instead sweep how STOP SIZE and CONTRACT
SIZE respond to the macro regime (realized vol, VIX, daily/weekly swing
structure). Do any of the knobs beat the baseline?

**Method:** `web/scripts/volSizingStudy.ts` — 649-session R2 replay of the
prod momentum detectors (flush + expansion), lookahead-free regime features
(prior-session realized vol percentile; prior-day VIX close from the CBOE
1990+ CSV joined strictly before the session; HH/HL/LH/LL/CHOP structure
from prior sessions via `lib/htfStructure`). Scoring = house rules: 0.5 pt
cost, 60-bar time exit, first-touch pessimistic, one-trade-at-a-time
sequential. Stop variants re-score the 1R box (stop × mult, target = 1R of
the new stop); size variants scale pnlPts (a sizeMult fill under the fixed
$170 risk budget — the `htfRegimeStudy` convention). Account impact via the
MFF Rapid EOD 50k sim. Baseline: **n=2,326 · WR 76.4% · PF 2.86 · 5,456 pts ·
$160,711 · maxDD −$1,379 · funded[test] $53,049**.

## Results

### A · Uniform grid (stopMult × sizeMult) — net pts / PF

| stop | ×0.5 | ×0.75 | ×1.0 | ×1.25 | ×1.5 | ×2.0 |
|---|---|---|---|---|---|---|
| s0.75 | 2.3k/3.53 | 3.4k/3.53 | 4.6k/3.53 | 5.7k/3.53 | 6.9k/3.53 | 9.2k/3.53 |
| s1.0 | 2.7k/2.86 | 4.1k/2.86 | 5.5k/2.86 | 6.8k/2.86 | 8.2k/2.86 | 10.9k/2.86 |
| s1.25 | 2.7k/2.22 | 4.1k/2.22 | 5.4k/2.22 | 6.8k/2.22 | 8.2k/2.22 | 10.9k/2.22 |
| s1.5 | 2.8k/1.95 | 4.2k/1.95 | 5.6k/1.95 | 7.0k/1.95 | 8.4k/1.95 | 11.2k/1.95 |

### B–D · conditional variants (no veto)

| Variant | PF | $ net | maxDD | verdict |
|---|---|---|---|---|
| base s1.0 ×1.0 | 2.86 | $160,711 | −$1,379 | — |
| **s0.75 ×1.0** | **3.53** | **$178,237** | **−$898** | **winner** |
| s1.25 / s1.5 | 2.22 / 1.95 | $128,795 / $110,582 | worse | wider stops lose monotonically |
| stop×1.25 in HIGH vol | 2.55 | $149,740 | −$1,379 | beats uniform s1.25, still loses to base |
| size by vol (L1.25/M1/H0.75) | 2.82 | $154,925 | −$1,723 | no |
| both vol (stop+size) | 2.58 | $146,696 | −$1,723 | no |
| size by daily structure | 2.80 | $153,760 | −$1,723 | no |
| size by daily+weekly structure | 2.82 | $174,663 | −$2,068 | **eval BREACH 2024-05-22** — no |
| stop×1.25 in HIGH vix | 2.62 | $152,517 | −$1,379 | no |
| size by vix (L1.25/M1/H0.75) | 2.85 | $166,280 | −$1,723 | +3.5% net, worse DD — marginal no |
| both vix (stop+size) | 2.67 | $160,133 | −$1,723 | no |

### Why the conditional knobs failed — the regime buckets are flat or inverted

Base trades by regime (PF / net pts): realized-vol terciles **2.65 / 2.76 /
3.06** — the HIGH-vol bucket is the BEST cell (953 trades, 2,668 pts = half
the total). VIX terciles: 2.81 / 2.82 / 3.13. Daily structure: agree 2.70 /
**counter 3.13** / neutral 2.87. Weekly: agree 2.73 / counter 2.78 / neutral
3.31.

So "vol targeting" (cut size in high vol) was backwards for THIS trigger:
high-vol sessions produce the huge bars the strategy feeds on. And
"structure agreement" up-weighted the WORSE bucket (counter-trend trades are
the better cell — consistent with `htf-short-pullback-2026-10-02.md`).

## Extension run 2 — COT + Treasury curve added (2026-10-04)

Historical data now wired in, all PIT-joined: **COT** (CFTC Socrata, 250
weekly reports, noncomm = spec, publish = report_date+3d) and the **daily
Treasury par curve** (home.treasury.gov CSVs 2023–2026 → 2s10s / 10y−3m / 10y
level + 3m change).

### New conditional variants (no veto)

| Variant | PF | $ net | maxDD | funded[test] |
|---|---|---|---|---|
| **size×1.25 when 2s10s positive** | 2.88 | **$192,859** | −$1,504 | **$66,312** |
| size×1.25 when positioning RISING | 2.87 | $181,594 | −$1,438 | $58,875 |
| size×1.25 when positioning FALLING | 2.86 | $180,008 | −$1,664 | $60,486 |
| size×0.75 when COT crowded (≥90th pct) | 2.88 | $152,830 | −$1,379 | $52,689 |
| stop×1.25 when 2s10s inverted | 2.71 | $154,990 | −$1,203 | $53,049 |
| crowd+rates combo | 2.73 | $147,619 | −$902 | $52,689 |
| (recap) base s1.0 | 2.86 | $160,711 | −$1,379 | $53,049 |
| (recap) s0.75 | **3.53** | $178,237 | **−$898** | $53,510 |

### New regime buckets (base trades)

- **COT percentile:** 0–33 pct PF 2.94 · **33–66 pct PF 3.46 (best)** ·
  66–100 pct PF 2.54 (crowded = worst, still profitable).
- **COT side:** net-long era (most of the window) 2.77 · net-short 3.21.
- **2s10s:** inverted PF 2.53 (489 sessions) vs positive PF 2.94 (1,837) —
  the curve regime genuinely separates the tape; the inversion era was the
  worse half.
- **10y 3m change:** rising-yield era 3.17 vs falling 2.84.

### Honest read

The 2s10s and COT-shift "winners" are mostly *size-up-in-the-better-bucket*
effects — both condition on ~half-to-79% of sessions, so they partly
recapitulate "just size up overall" (the strategy has positive expectancy in
every bucket; any large ×1.25 subset raises $ net while growing drawdown).
The one cleanly interpretable macro result is the **2s10s bucket split**
(inverted = worse tape) and the **COT middle-vs-crowded** ordering. None of
the conditional knobs beat s0.75 on risk-adjusted terms (maxDD). Next steps:
train/test the 2s10s split, and a finer stop grid (0.5–0.9) to confirm the
s0.75 plateau.

## Verdict

1. **Tighter stops win** — s0.75: PF 2.86→3.53, WR 76.4→80.7%, $ net +11%,
   maxDD −35%. Mechanism: the fixed $170 risk budget buys more contracts at
   a 25%-tighter stop AND the edge lives in quick 1R hits, not tail
   outcomes. Needs the plateau discipline: sweep 0.6/0.7/0.8/0.9 next.
2. **Macro-conditional sizing does not pay here** (vol/vix/structure all
   neutral-to-negative after drawdown), for a measurable reason: the
   trigger is regime-robust and the "scary" cells are the good ones.
3. Next experiments: finer stop grid around 0.75 (incl. 0.5), target
   multiples (0.75R/1R/1.25R) × the winner, the same grid on the RTH soft
   strategy, and a train/test split of the winning knob.
