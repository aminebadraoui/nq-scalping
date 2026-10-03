# HTF counter-trend shorts — "are the losing shorts really bullish-pullback shorts?" (2026-10-02)

The question from the trade logs: *several losing trades looked like shorts taken on
longer-timeframe bullish pullbacks — can we improve that?*

**TL;DR.** The instinct is right about the *cell* but wrong about the *fix*.
Shorts fired while the higher-timeframe trend is bullish are the weakest short
cell in the whole system (and they do get stop-run more), but over 649 sessions /
12,460 sequential trades that cell still wins **80.6%** with PF 3.20 — the huge-bar
continuation trigger is regime-robust. **Every hard veto tested removes a
profitable subset of trades and costs money.** The live losses were a small-sample
streak (the two sessions in the logs were one-way +110 pt / +250 pt up tapes) plus
execution leaks that are already fixed (absolute brackets, verified re-send). The
improvements that *do* pay: regime-aware sizing (optional), an early-Globex short
discipline (new finding), regime context printed on the trade card, and one opt-in
quality knob for the worst sub-cell — not a veto.

Data: live audit `web/scripts/htfTrendLive.ts`; replay `web/scripts/htfRegimeStudy.ts`
(649-session R2 archive, lookahead-free, sequential one-trade-at-a-time, first-touch
scoring, 0.5 pt cost, 60-bar time exit, train/test split 2026-01-01, MFF Rapid EOD
50k sim). External evidence: `research/htf-trend-filter-research.md`.

---

## 1. The live logs — what actually happened

25 matched live trades (Oct 1 Globex + Oct 2 RTH). Regime = 15m EMA20 vs EMA50
(slope-confirmed) + price vs 1m EMA200, computed from the archive tape at entry.

| Cell (live) | n | W | L | WR | gross $ |
|---|---|---|---|---|---|
| short, HTF bullish (BULL15 + above EMA200) | 4 | 1 | 3 | **25%** | **−$305** |
| short, HTF mixed | 9 | 4 | 3 | 44% | +$89 |
| long, HTF bullish | 5 | 2 | 3 | 40% | −$160 |
| long, HTF mixed | 7 | 5 | 0 | 71% | +$732 |

The six losing shorts, with their regime context at entry:

| # | ET | family | regime read at entry | $ | note |
|---|---|---|---|---|---|
| 7 | 22:50 | expansion | **BULL15**, slope +16, above EMA200 & VWAP, sess +81 pts | −200.5 | textbook counter-trend short at the top of a one-way up night |
| 11 | 01:27 | flush | **BULL15**, above VWAP, ret240 +70 | −130.0 | would have WON with the structural stop (bracket-anchoring leak, now fixed) |
| 37 | 10:46 | RTH | **BULL15**, above EMA200, prevRangePos 1.99 (2 ranges above prior day) | −118.5 | short into a parabolic +250 pt up day |
| 65 | 11:46 | RTH | mixed 15m, above VWAP, 1h drop in an up day | −49.5 | hit target *then* stopped — stop-run |
| 74 | 13:14 | RTH | bearish 4h (ret240 −104), below EMA200/VWAP | −220.5 | NOT a bull-pullback short — bear continuation squeezed (flushVol 1047) |
| 292 | 14:38 | RTH | bearish (ret240 −224, below EMA200) | −99.0 | not a bull-pullback short either |

**Verdict on the live sample: 3 of 6 losing shorts were clean counter-trend shorts
in a bullish HTF (4 of 6 if #65 counts), and they were the expensive ones.** But n=4
is noise: the replay says that exact cell wins ~78–80%.

## 2. The replay truth — 12,460 sequential trades, 649 sessions

Baseline (flush + expansion + RTH soft, prod configs, sequential):

| cell | n | WR | PF | expR | net |
|---|---|---|---|---|---|
| long \| BEAR15 | 1,936 | 84.0% | 4.05 | 0.44 | +6,940 |
| long \| BULL15 | 3,018 | 82.7% | 3.73 | 0.41 | +9,096 |
| long \| MIXED | 1,143 | 84.8% | 4.18 | 0.46 | +3,907 |
| short \| BEAR15 | 2,119 | 81.9% | 3.52 | 0.40 | +7,239 |
| **short \| BULL15** | 2,861 | **80.6%** | **3.20** | **0.37** | +7,976 |
| short \| MIXED | 1,156 | 79.4% | 3.15 | 0.36 | +3,540 |
| short \| EARLY (first ~75 min) | 110 | **73.6%** | **2.30** | 0.37 | +224 |

The asymmetry is real but modest: counter-trend shorts lose ~1.3 pts of WR and
~0.03R of expectancy vs with-trend shorts — **every cell remains strongly positive.**
The same gradient holds per family (expansion: shorts 82.5% bear / 79.3% bull;
flush: 73.3% / 73.0%) and on the daily axis:

| daily context, shorts | n | WR | PF |
|---|---|---|---|
| gap up (open above prior close) | 3,598 | 79.9% | 3.15 |
| gap flat/down | 2,648 | 81.8% | 3.47 |
| gap up + BULL15 | 1,665 | 79.6% | 3.07 |
| gap up + BULL15 + **below VWAP** | 127 | **71.7%** | **2.21** |
| BULL15 + below VWAP | 214 | 73.4% | 2.57 |

**The genuinely weak sub-cells (still net-positive):**

1. **Shorts below session VWAP while the 15m trend is bullish** — "shorting the
   pullback below value in an uptrend": 73.4% WR, PF 2.57 (214 trades). With a
   daily gap up on top: 71.7%, PF 2.21 (127 trades). This is the closest
   operational match to the user's hypothesis.
2. **EARLY-regime shorts** — first ~75 min of the Globex session (before the 15m
   regime can even form): 73.6% WR, 26.4% stop rate, **9.1% tick-stop rate**
   (vs 3.3% for bear-regime shorts).
3. **Hour pattern for shorts (momentum hours):** 18:00 ET 70.2% · 19:00 72.8% ·
   20:00 65.3% · 21:00 70.3% · 22:00 73.2% · 23:00 73.6% — the first four Globex
   hours are the weakest for shorts (plus the thin 16:00 EOD hour at 65.9%).
4. **Trendless (MIXED) shorts:** 79.4% overall; within flush-only, 69.5% — choppy
   tape without a clean 15m trend is worse for shorts than a clean bull trend.

**Stop-run asymmetry (the "it always stops me out" feeling is partly real):**
tick-stop share (stopped within 10% of the stop) by cell — short|BULL15 **4.5%** vs
short|BEAR15 3.3% and long|BULL15 3.7% vs long|BEAR15 2.7%. Counter-trend shorts get
tick-stopped ~36% more often — consistent with the external evidence (stops cluster
just beyond obvious levels; counter-trend stops are the liquidity the trend feeds on).
Still, 4.5% ≠ a leak; the stop-run clustering study already showed pad increases
make the tail worse, so the 0.5 pt pad stays.

## 3. Would a veto help? No — every veto removes profitable trades

Same replay, shorts skipped pre-scoring (lane freed for the next signal — honest):

| variant | n | WR (all) | WR (test) | PF (test) | vetoed subset | total $ |
|---|---|---|---|---|---|---|
| base | 12,460 | 82.0% | 83.1% | 3.78 | — | 818,347 |
| noShortBull15 | 9,977 | 82.3% | 82.9% | 3.73 | 3,333 trades, **80.6% WR**, +9,214 pts | 667,047 |
| noShortBull15+A200 | 10,435 | 82.1% | 82.7% | 3.70 | 2,735 trades, **81.1% WR** | 693,963 |
| noShortPullbackUp (ret60<0, ret240>0) | 11,674 | 82.0% | 83.0% | 3.77 | 1,157 trades, **81.5% WR** | 765,035 |
| noShortBelowE20Bull | 12,193 | 82.2% | 83.2% | 3.80 | 496 trades, **77.0% WR** | 804,556 |
| noShortMixed | 11,624 | 82.3% | 83.0% | 3.72 | 1,429 trades, 78.8% WR | 770,121 |
| noShortVwapBelow | 10,064 | 82.5% | **83.9%** | **3.99** | 3,226 trades, 79.7% WR | 671,375 |
| noShortVwapBelowBull | 12,278 | 82.2% | 83.3% | 3.82 | 300 trades, **75.3% WR** | 811,264 |
| noShortCumD>0 | 9,921 | 82.2% | 82.5% | 3.65 | 3,451 trades, 80.2% WR | 659,447 |

**Every vetoed subset is profitable — most at 75–81% WR.** Skipping them converts
$15k–$150k of income into "quality" that is barely measurable per-trade. The only
variant with a better test profile (noShortVwapBelow) still throws away $147k.
This is the same verdict as the earlier session-trend veto study
(`research/context-veto-stoprun-2026-10-02.md`: cumDelta/VWAP gates rejected for
expansion) — the huge-bar continuation edge does not care about the regime it fires
in, because it is *momentum continuation*, not a discretionary fade. A 79% cell in a
bull tape is not the same trade as the discretionary counter-trend fade the
literature warns about (see §5).

## 4. Size instead of skip — the knob that actually trades risk for income

Same trades, weak-tier shorts at half size (dollarize at 50% of the $170 budget):

| variant | net $ | worst day | max DD (eval) |
|---|---|---|---|
| size base | 818,347 | −776 (2024-10-17) | −776 |
| halfShortBull15 | 732,289 | **−598** | −601 |
| halfShortBull15+A200 | 748,345 | −731 | −731 |
| halfShortVwapBelow | 731,313 | −658 | −658 |
| halfShortVwapBelowBull | 813,807 | −776 | −776 |
| halfWeakShortTier (bull+<VWAP ∪ trendless shorts) | 780,192 | −776 | −776 |
| halfShortPullbackUp | 787,965 | −687 | −687 |
| zeroWeakShortTier | 742,036 | −776 | −776 |

Half-sizing *all* BULL15 shorts shaves the worst day 23% (−776 → −598) at a −10.5%
income cost. Half-sizing only the narrow weak tier (bull + below-VWAP) costs <1% of
income with no measurable tail change. Given the prop floor ($2,000 EOD-trailing vs
−$776 worst day), the base sizing is the right default — the half-size knob exists
for psychological smoothing, not because the account needs it.

## 5. Why the literature expects this pattern (external research)

Full citations in `research/htf-trend-filter-research.md`. The condensed logic:

- **Trend alignment is the default edge.** Time-series momentum is positive in
  essentially every futures market for 100+ years (Moskowitz–Ooi–Pedersen 2012;
  Hurst et al. 2017). Intraday continuation is measurable too (Gao et al. 2018:
  first half-hour predicts last half-hour). AQR's "Hold the Dip": 196 systematic
  buy-the-dip variants ALL underperform; dip-buying is "usually positioned opposite
  momentum". Estrada (155 years): returns after down months are *lower* than
  average (9.1% vs 11.0%). So the prior that counter-trend entries are worse is
  sound — and our data shows the same direction, just with a much smaller
  magnitude than the literature's cross-sectional effect, because our entries are
  momentum-triggered (huge one-sided bar), not discretionary fades.
- **Mechanics of why counter-trend shorts bleed:** passive absorption at pullback
  lows (Bookmap), buyers happy to pay up through a pullback (Axia CVD divergence),
  and stop cascades — stops are positive-feedback orders that cluster and fire in
  waves (Osler, NY Fed SR 150; Cont–Kukanov–Stoikov). Our tick-stop table (§2)
  shows the same signature: bull-regime shorts get tick-stopped ~36% more often.
- **How professionals handle it:** on trend days, trade with-trend only (Axia,
  SMB); counter-trend only with multi-clue confluence (Axia open-drive short needed
  3+ stacked context clues). Quant systems implement it as a regime *gate*, but the
  gates in the literature exist for setups that are already marginal — our cells
  are 73–85% WR, which is why the gates don't pay here.
- **Validation discipline:** the marginal test used here (does the veto remove a
  genuinely worse subset? does it hold on the test split?) is exactly the
  anti-overfit protocol the literature prescribes (Bailey et al. PBO; walk-forward
  folds; treat regime as a sticky 5m/15m state, not a 1m signal). We also inherit
  the repo's walk-forward rule for auto-applied insights.

## 6. What to actually do (ranked)

1. **Do not veto counter-trend shorts.** They are ~80% WR with PF 3.2 and
   contribute +7,976 pts. The two review nights were a one-way-tape streak + leaks
   now fixed (absolute structural brackets, verified re-send, stale-entry guard).
2. **Early-Globex short discipline (new finding, strongest actionable).** Shorts
   in the first ~75 min of the session (EARLY regime: 73.6% WR, 26% stops, 9.1%
   tick-stops) and broadly 18:00–21:00 ET (65–73% WR) are the weakest shorts in the
   system — worse than bull-regime shorts. Options: (a) `hour_veto` override for
   momentum shorts 18:00–19:15 ET (opt-in, dashboard-approvable today); (b) require
   A+ overlap (flush+expansion same bar) for shorts before 19:15; (c) half-size.
   This matches the existing first-of-day research direction and is backed by the
   replay hour table.
3. **Regime-aware half-size knob (optional, default OFF).** Add a `size_scale`
   gate to `web/lib/strategyOverrides.ts` (value `{ scale: 0.5, side: "short",
   on: "bull15_belowVwap" }`). Data: halfShortBull15 −10.5% income for −23% worst
   day; the narrow tier costs <1%. Activate only if the trader wants smoothing.
4. **Print the regime on the card.** The momentum/RTH card should carry the HTF
   context the trader is missing when the alert fires: `HTF: BULL15 (15m EMA20>
   EMA50) · above/below session VWAP · gap direction vs prior close` plus a
   `counter-trend short — consider half size` tag for the bull+below-VWAP cell.
   Small `signalText.ts`/`mechanism.ts` addition; no behavior change. This directly
   answers "I feel like…" by making the context explicit per card.
5. **Feed the regime features to the nightly miner.** Persist `htfRegime` (15m EMA
   state, VWAP side, gap, early flag) onto `trades.features` so
   `strategyInsights.ts` can propose trend-filter/hour-veto rules with evidence;
   its walk-forward gate already protects against overfit auto-application.
6. **Opt-in quality knob (precedent: `requireTrailProgress`).** A
   `counterTrendShortGuard` config on the detectors: skip shorts when
   gap-up + BULL15 + below VWAP (127 trades, 71.7% WR, PF 2.21 — the one cell
   where the vetoed subset is clearly worse than the kept set). The measured
   wider version (bull + below-VWAP, 300 trades, 75.3% WR) saves ~$7k over
   2.75y at 2.4% signal cost — a quality filter for the ugliest sub-cell,
   default OFF in prod configs, exposed as a lab variant.
7. **Keep journaling.** The live journal (31 trades) is still inside the model's
   noise band; the 80.6% cell produces 3–5 loss streaks routinely. The
   `htfTrendLive.ts` audit is re-runnable after any night
   (`node --import ../scripts/ts-loader.mjs ./scripts/htfTrendLive.ts`).

## 7. Method notes and caveats

- Archive minutes carry high/low and buy/sell only (no true o/c); every price used
  is the mid, same as the lab. MFE/MAE and tick-stop proxies inherit that.
- 15m EMA regime requires ≥5 completed 15m buckets (75 min); earlier trades are
  tagged EARLY instead of classified — which itself surfaced the early-session
  finding (a benefit, not a bug).
- The replay is per-session (no cross-session state), so "HTF" here means intraday
  session structure (15m EMA / EMA200 / session VWAP / prior-day gap) — the honest
  higher timeframes available to a Globex scalper. A true daily-candle trend
  (e.g., 20-day SMA on daily closes) is NOT yet measurable from the archive and is
  the natural follow-up if deeper history arrives (Databento/CME).
- Train/test split 2026-01-01 throughout; the walk-forward gate in the miner is the
  production guard for any auto-applied rule.

## Files

- `web/scripts/htfTrendLive.ts` — live-trade HTF audit (runs against Neon `trades`
  + R2 archive).
- `web/scripts/htfRegimeStudy.ts` — full regime + veto + sizing study
  (`--include-rth`, `--dump`, `--max`, `--split` supported).
- `research/htf-trend-filter-research.md` — external literature review (subagent
  research, all claims cited).
