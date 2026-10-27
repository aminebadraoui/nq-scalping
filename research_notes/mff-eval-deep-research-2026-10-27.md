# MFF eval: deep research round 2 (2026-10-27, evening)

Educational research, not trading advice.

## T0 study card

| Field | Value |
|---|---|
| Question | Is there a strategy or sizing policy that passes the MFF Rapid EOD 50K ($3k target, $2k EOD trailing, 30% consistency) with low breach odds? |
| Data | NQ footprint archive, 663 ETH sessions, 2023-12-18 → 2026-10-23 (no true OHLC; 1-min high/low/buy/sell/levels); VIX daily (datasets/finance-vix) |
| Fills | Honest walker `grid.walk`: market entries = p50 next-open estimate + 0.25 slip (+0.35 adverse bias on flow-selected check bars); stops checked first on every bar; **a stop already through the market fills at the bar's estimated open, not at the stop**; targets need a one-tick trade-through and get no credit on the fill bar; MNQ fee 0.95 pt RT |
| Stack | One layer varied at a time against 1 MNQ per stream, no other gates |
| Split | 2024–2025 train / 2026 holdout (192 sessions) |
| Trials | ~60 variants this round (counted for the multiple-testing check below) |

## 1. Correction to the live plan's research (important)

The earlier noise-area backtest filled trailing-stop exits **at the stop price even when the stop had moved through the market** (VWAP jumping above a long's price). That happened on 70 of 707 exits and credited ~1,760 pts that could not have been captured (~2.7 pts/day).

| Stream (1 MNQ) | Earlier | Honest | t (all) |
|---|---|---|---|
| Noise area, checks from 10:30 (live) | +8.7 pts/day, t 2.45 | +5.3 pts/day | 1.49 |
| Gap fade, stop ≤150, entry 9:31 (live) | +16 pts/trade | +3.2 pts/day | 1.44 |
| Live plan (both) | ~90% pass / 9% breach | bootstrap 63% pass / 35% breach, median 113 days | 1.92 |

The live code had the mirror-image bug: it **skipped** the trailing update when the level was through the price and kept the older, looser stop. Fix: PR #1 (`fix/eval-trail-exit`), which exits at market. It is not merged. The push to main was blocked as a production deploy.

## 2. New edge families tested (honest fills)

| Family | Best variant | pts/day | t | 2026 |
|---|---|---|---|---|
| Noise area on Asia / London / 08:30 windows | Asia 20:00–02:00 | +1.7 | 0.9 | mixed; London **negative** (t −2.5) |
| Dalton 80% value-area rule | 1 bracket | −0.1 | 0.0 | neg |
| Failed auction at prior-day high/low | – | −3.1 | −2.3 | neg |
| **Failed auction at overnight high/low → prior POC**, stop-entry confirm | ttl 5 | +5.4 | 2.0 | +4.1 (t 0.7) |
| Same with a limit entry | – | +1 to +3 | <1.4 | **neg** (adverse selection) |
| Failed auction generalized (Asia→London, IB, lunch, pre-open) | London→NY | +1.5 | 1.0 | – |
| Narrow-IB breakout | – | −3.4 | −2.2 | neg |
| Last-half-hour momentum (Baltussen) | – | −5.0 | −2.2 | neg; the reversal is ~0 |
| VWAP reversion on balance days | – | ≤ +0.4 | – | neg |
| **Overnight long 18:01→09:29, stop 100** (overnight premium; legal: MFF trades 6 PM→4:10 PM ET) | – | +8.6 | 1.7 | +5.0 |
| Regime filters (variance ratio, prior vol, overnight range, VIX) | – | – | – | sign flips by year; none kept |
| Footprint conditions on the failed auction (trapped aggressors, poke volume, reclaim speed) | – | – | – | no lift |

Correlations between noise area, gap fade, failed auction and overnight long are all within ±0.11.

**Multiple testing.** With ~60 trials over 650 days, the best of 60 zero-edge strategies would show t ≈ 2.9 by chance. The four-stream portfolio is t = 3.26 in-sample, so its deflated Sharpe is roughly 0.65 (not significant at 95%). No single stream clears the bar.

## 3. The barrier math: why speed and safety trade off

For a stream with daily mean μ and variance σ² (in $), the chance of a $2,000 drawdown before the target is about **exp(−2·2000·μ/σ²)**. The ratio μ/σ² is the Kelly leverage.

- Adding independent streams does **not** change μ/σ². It only shortens the time to pass.
- The only levers are a smaller unit (not possible below 1 MNQ) or trades with more edge per unit of variance.
- Breach ≤ 5% needs μ/σ² ≥ 7.5e-4 per $.

| Stream (1 MNQ) | $/day | sd $/day | μ/σ² | ~breach | Bootstrap eval | 2026-start eval |
|---|---|---|---|---|---|---|
| Noise area | 9.7 | 181 | 3.0e-4 | 30% | 48% pass / 43% breach | none resolved within 2026 |
| Gap fade | 6.3 | 115 | 4.8e-4 | 15% | 57% / 16% (27% open) | none resolved |
| Live: NA+GF | 16.0 | 207 | 3.8e-4 | 22% | 63% / 35% | 2% / 0% (98% open) |
| Failed auction ON | 10.8 | 139 | 5.6e-4 | 11% | 77% / 19% | 18% / **67%** |
| Overnight long | 17.5 | 255 | 2.7e-4 | 34% | 51% / 49% | 20% / **65%** |
| All four | 44.4 | 347 | 3.7e-4 | 23% | 65% / 35% | 27% / **63%** |

Sizing and stopping policies tried, each within a few points of fixed 1-each:
- CPPI-style cushion sizing.
- Size-up after the drawdown locks at $50,100. This raises breach because bigger days trip the 30% consistency rule and force more trading.
- Daily stop $300 and daily profit lock $800.
- Vol-managed participation (Moreira–Muir).
- Phase policies (low-variance streams until the lock).

**VERDICT:** edge = thin / not significant after deflation · fills = honest · holdout 2026 = fails (breach-dominated) · deployable = no new stream · live plan = keep at 1 MNQ only if the owner accepts ~35% breach odds over ~4 months.

## 4. What could actually move μ/σ²

1. **Hedged spreads (NQ vs ES).** The intraday spread has a fraction of NQ's variance, so any mean-reversion edge in it has a much higher μ/σ². ES footprint is already in R2 (`manifest-es.json`, `gcdata/backfill_es.py`), but R2 is blocked from the cloud session. Linking the Mac lets the next round test it.
2. **Cost reduction on short trades.** Maker (limit) exits on targets save ~0.25 pt per trade. That matters only for short-horizon streams, which have had no edge so far.
3. **Accepting the economics.** The eval is a one-time $157 with no monthly fee, so time is cheap and a breach costs one fee. That is a business decision about cost per funded account, not a statistical edge.

## Regenerate

```bash
cd /home/claude/research   # scripts mirrored in scripts/research/eval_plan_v1/
python3 load.py && python3 features.py && python3 -c "import grid; grid.build()"
python3 na_generic.py; python3 chk_gap.py          # honest noise area + the stop-fill artifact
python3 lib3.py; python3 fa2.py; python3 fa3.py; python3 fa_gen.py
python3 overnight.py; python3 regime.py
python3 port3.py; python3 sizing2.py; python3 kelly.py; python3 phase.py; python3 volman.py
```

## 5. Round 3 (same evening): true prices, and everything else

**New data.** `gcdata/data/ohlc_hist/` on the owner's Mac holds true Tradovate 1-min OHLCV for 614 sessions (2024-05-27 → 2026-10-23). With it, market fills need no estimates: an order fills at the next bar's real open, a stop that the bar opens through fills at that open, and time exits use the real close (`ogrid.py`, `tlib.py`).

**Every candidate weakens with true prices** (May 2024 → Oct 2026, 1 MNQ):

| Stream | pts/day | t |
|---|---|---|
| Noise area 10:30+ (live) | +2.8 | 0.66 |
| Noise area 10:00+ | +3.0 | 0.70 |
| Gap fade ≤150, 9:31 entry (live) | +2.2 | 0.88 |
| Gap fade, no cap | +6.7 | 1.42 |
| Overnight long 18:01→09:29, stop 100 / 50 / none | +5.2 / +6.3 / +7.4 | 0.96 / 1.47 / 1.03 |
| Failed auction ON → prior POC, stop-entry | +5.3 | 1.69 |

None is distinguishable from zero. The estimate-based numbers were partly fill artifacts.

**Also tested, all no edge:**
- Heston–Korajczyk–Sadka same-half-hour persistence: gross ≈ 0, so every interval loses about 1.5 pts to costs.
- Pre-FOMC drift and options-expiry weeks: n = 20–30 events, t ≈ 1, not tradable at eval scale.
- Multi-day momentum and reversal: sign flips by year.
- Walk-forward GBM and logistic models (~30 features, 30/60/120-minute horizons): t ≤ 1.2 out of sample.
- 80-config true-fill search across Donchian, z-score reversion, RSI(2) and opening-range rules on 5- and 15-minute bars:
  - best train t = 1.5, with test t of about 0.3;
  - only 29% of configs positive on test.
- Account size:
  - Rapid 150K ($4.5k drawdown) cuts breach to about 4–10% on the same streams.
  - The cost is 6–8+ months to pass.
  - Standard Rapid funded accounts use an intraday trailing drawdown.

**VERDICT (round 3):** the live plan's edge is not significant on true prices; no rule found in NQ price/volume clears costs. The remaining structurally different test is the NQ/ES spread (needs the ES archive pulled to the Mac).
