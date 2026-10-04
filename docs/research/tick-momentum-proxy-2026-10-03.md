# Tick-momentum proxy study — do OHLC rejection shapes predict the next minute? (2026-10-03)

**Type:** empirical (negative result). **Sample:** the 12 most recent sessions
that still have vendor OHLC twins (GoCharting OHLC retention ≈ 12 trading
days; the footprint archive itself is 649 sessions but carries no
open/close). All-hours: **16,536 bars**; RTH-only: **4,680 bars**. Replay:
`web/scripts/tickMomentumProxyStudy.ts --recent 30 [--rth]`.

## Question

The tick-momentum engine (`web/lib/tickMomentum.ts`) decodes "the candle is
pushing more up than down" from the intra-minute path — velocity asymmetry,
rejection speed, impact asymmetry. That path data does not exist in the
archive (per-minute aggregates discard intra-minute time). Before investing
in tick history, this study asks the cheap question: **do the minute-granularity
proxies of a rejection — close position in the range and wick asymmetry —
carry any next-bar signal on the data we already have?**

Features per bar (true OHLC only): `closePos` = (close−low)/range;
`wickAsym` = (lowerWick − upperWick)/range (+ = big lower wick = down-poke
rejected, close near high); `bodyFrac` = |close−open|/range; `deltaFrac` =
footprint aggressor split (the control). Labels: next-close direction/move,
3-bar favorable/adverse excursion, MOM_PROD signal within 10 bars.

## Results (all hours, 16,536 bars)

Baseline: up1 = 50%, fwd1 = +0.11 pt, fav3/adv3 = +6.17/−5.86 pt, sig10 = 2.3%.

### closePos (close in the range) — flat

| bucket | n | up1 | fwd1 | fav3 | adv3 | sig10 |
|---|---|---|---|---|---|---|
| <0.3 (closed at the low) | 5,027 | 51% | −0.05 | +6.07 | −5.91 | 2.0% |
| 0.3–0.45 | 2,281 | 49% | +0.13 | +5.96 | −5.88 | 2.1% |
| 0.45–0.55 | 1,447 | 51% | +0.11 | +6.02 | −5.65 | 3.2% |
| 0.55–0.7 | 2,308 | 49% | +0.05 | +6.25 | −5.95 | 1.9% |
| >0.7 (closed at the high) | 5,473 | 50% | +0.27 | +6.35 | −5.83 | 2.5% |

### wickAsym (rejection shape) — flat, mildly inverted

| bucket | n | up1 | fwd1 | fav3 | adv3 | sig10 |
|---|---|---|---|---|---|---|
| <−0.4 (big UPPER wick) | 2,020 | 53% | +0.11 | +5.82 | −5.61 | 2.7% |
| −0.4…−0.15 | 3,132 | 50% | +0.30 | +6.24 | −5.78 | 2.1% |
| −0.15…0.15 | 5,974 | 50% | +0.14 | +6.28 | −6.01 | 2.0% |
| 0.15…0.4 | 3,182 | 49% | +0.01 | +6.27 | −5.92 | 2.3% |
| >0.4 (big LOWER wick — "down-poke rejected") | 2,228 | 48% | −0.08 | +5.90 | −5.73 | 2.9% |

The textbook rejection candle (long lower wick, close near the high) predicts
**nothing upward** at the next minute — if anything the sign leans the other
way. The textbook shooting star (upper wick) is equally uninformative.

### bodyFrac — flat

| bucket | n | up1 | fwd1 | fav3 | adv3 | sig10 |
|---|---|---|---|---|---|---|
| <0.3 (doji-ish) | 5,166 | 50% | 0.00 | +6.13 | −5.89 | 2.5% |
| 0.3–0.6 | 5,680 | 49% | +0.08 | +6.17 | −5.94 | 2.1% |
| >0.6 (full body) | 5,690 | 50% | +0.23 | +6.20 | −5.76 | 2.2% |

### deltaFrac (the control) — the known signature still holds

| bucket | n | up1 | fwd1 | fav3 | adv3 | sig10 |
|---|---|---|---|---|---|---|
| −0.2…0.2 (balanced) | 11,007 | 50% | +0.11 | +6.78 | −6.48 | 1.6% |
| −0.5…−0.2 / 0.2…0.5 | 2,591 / 2,473 | 50% / 50% | −0.07 / +0.29 | ~5.0 | ~−4.7 | 3.3% / 3.3% |
| <−0.5 / >0.5 (extreme one-sided) | 239 / 226 | 49% / 49% | −0.05 / +0.18 | ~3.8 | ~−3.9 | 7.9% / 5.8% |

One-sided footprint bars predict **momentum events** (sig10 3–5× the balanced
baseline) and compress the 3-bar excursion — the FOOTPRINT_CANDLE_RESEARCH
result — but they do not predict next-close direction on this sample. The
interaction tables (wick × delta, close × delta, close × rangeR, full output
in the script) show no cell where the shape adds a robust edge on top of delta.

### RTH-only (4,680 bars)

Same flatness: no closePos/wick/body bucket moves off ~50% up1; deltaFrac
behaves as above. sig10 = 0.0% everywhere — expected, MOM_PROD's hour filter
skips RTH (a wiring sanity check).

## Interpretation

1. **The feeling does not survive aggregation to one minute.** A fast V-shape
   rejection and a slow grind produce the identical OHLC bar; whatever
   information the eye extracts from the tick sequence is destroyed by
   minute bucketing. The negative result is evidence *for* the speed element,
   not against the feeling.
2. **Minute shape is noise at this horizon** — and per the candle study, what
   predicts at minute scale is **size × delta** (a big one-sided bar), not
   wick geometry.
3. **Consequence:** the honest measurement is the live tick-momentum engine
   (`docs/strategy/TICK_MOMENTUM.md`), and the honest backtest path is
   event-time data — forward-logging the live tape now, or CME MBO via
   Databento. Nothing further should be squeezed from minute OHLC shapes.

## Caveats

- 12 sessions / 16.5 k bars is a thin sample by this repo's standards (the
  candle study ran 649 sessions / 781 k bars); OHLC twin retention is the
  binding constraint, not the archive.
- 1-minute forward horizon only. The shape proxies were not tested at 5 s or
  tick horizons — where they cannot be computed from this archive anyway.
- `fwd1` uses true closes; minutes without twins are excluded (no mid-price
  fallback in the labels, so overnight bars with no twin never leak in).
