# Fill-model integrity — what the backtest engine is, what broke, and the new discipline (2026-10-08)

The two 2026-10-08 incidents forced a reckoning with the RTH family's
validation. This document separates what is solid from what was wrong,
and sets the discipline going forward.

## The principle

**You trade your fill model, not your signal.** A backtest is only as
real as its assumptions about how orders actually fill: entry drift,
crossed-limit marketability, stop slippage, fees, partial fills. A
config whose profit lives inside an idealized part of the fill model is
not validated — it is a bet on the assumption.

## What is solid (the engine)

- **Archive replay** — 652 sessions of real footprint/OHLC data; the
  detectors reproduce live tape exactly (proven again by the open-drive
  live fix, 2026-10-05).
- **Account simulator** — eval rules, daily floor, drawdown halving,
  consistency cap, sizing math. Pure mechanics, unit-tested.
- **Fees** — $1.90/RT measured from real fills.
- **Methodology** — train/OOS splits, walk-forward, cost ladders, year
  stability.

## What was wrong (two fill assumptions, in the RTH studies)

1. **Entry side:** crossed-limit dispatches were scored as if the bracket
   worked at the signal price — a short filled above its own stop books
   an instant *win* in the model, while live the stop is rejected
   (`InvalidPrice`) or compressed. Phantom profit.
2. **Exit side:** stop-outs fill at the trigger, zero slippage. Live, a
   stop is a market order that fills at the next traded price — and in
   the flush tape this family trades, that is routinely 1–2 pts beyond.

Neither is an engine bug: the engine faithfully computed the
consequences of wrong assumptions. The RTH family was hit hardest
because its edge was *concentrated* in exactly those blind spots — its
best trades were crossed-dispatch moves, and its tight stops live inside
the tape that runs them.

## The numbers (same config, assumptions peeled)

RTH s0.5 stop / t2.5 target, resting-limit entries, 652 sessions,
$1.90/RT, $100 budget:

| Model | Result |
|---|---|
| Original validation (10-06, went live) | **+$13.8k PASS** (train +$8.1k / OOS +$5.7k) |
| + crossed cards gated (honest execution) | +$9.9k, dd −$2.5k **BREACH** |
| + stop slippage modeled | **−$26.2k BREACH** |
| + slippage capped at 2 / 5 / 10 pts | **−$26.2k at every cap** |

The slip-cap result falsifies the "black swan" story: capping the tail
changes nothing, because every slipped fill in the archive was already
≤2 pts past the stop. The bleed is thousands of routine small slips on
stop-outs of a 3-pt stop inside flush tape. It is structural, not tail.

## What remains trustworthy — audited per study (2026-10-08)

- **Guards, sizing, fees** — account-rule mechanics, independent of fill
  assumptions.
- **Entry-side realism:**
  - `retraceSlippageStudy` / `entryQualityStudy` — realistic entry fills
    (limit-or-better + gap-through, next-bar-open market fills,
    fill-anchored brackets, drift gates); the 10-04 tape-lag lesson
    applied.
  - `momentumStudy` / `sizingOptimizer` (the older momentum generation)
    — entries at the SIGNAL price with zero drift: an entry-side
    idealization (small impact: immediate dispatch), still an assumption
    to close.
- **Exit-side (stop slippage): modeled NOWHERE before this incident.**
  Every scorer in the codebase exits at the stop PRICE; the best
  available was a flat ~0.5 pt/RT cost. The RTH treatment in
  `rthDriftOptimizer.ts` is the FIRST stop-side slippage model. The
  blind spot is systemic; its impact scales with stop tightness — RTH's
  3-pt stops worst, momentum's wider structural stops less, but
  UNMEASURED, not absent. Pending: apply the slippage model to the
  momentum/open configs and calibrate the parameter with the live
  stop-fill journal (the slippage alarm's data).
- **Anything downstream that consumed RTH trades** (parts of the day-plan
  / risk-stack sweeps) inherits the RTH phantom edge and should be
  re-checked once RTH is re-validated.

## The new discipline (applies to every study from now on)

1. **Declare the fill model on BOTH sides** — entry drift/marketability
   AND stop-out slippage — in the study header. A config is only trusted
   within its declared model's validity.
2. **Sweep the assumptions** — every idealized parameter gets a
   sensitivity sweep (the crossed-gate / slip-cap / contract-cap grid in
   `scripts/rthDriftOptimizer.ts` is now the template).
3. **Calibrate from live data.** The slippage alarm + protection registry
   journal every stop's trigger vs actual fill from this point on. The
   routine-slip magnitude becomes a *measurement*, not a proxy — the
   model's bar-close assumption (fill at the close when the bar closes
   through the stop) is reasonable but unverified for routine stop-outs.
4. **Reconcile live vs model continuously** — if live diverges, the model
   is wrong, never the market.

## The fill-model audit — every live family, honest fills (2026-10-08)

`scripts/fillAudit.ts` replays all 652 sessions with each family's LIVE
mechanics (momentum: market entry, signal-anchored brackets, no time
exit; expansion: retrace limit 1 pt behind the close, fill-anchored 1R
brackets; open: market entry, signal brackets) × entry-lag brackets
(signal close ≈ live dispatch vs next-bar open ≈ 1-min lag) × stop
slippage off/on. $100 budget, $1.90/RT, eval sim:

| Family | Entry | Stop slip | Net $ | dd $ | Verdict |
|---|---|---|---|---|---|
| momentum | ≈live (close) | N | +29,752 | −986 | **PASS** |
| momentum | ≈live (close) | **Y** | **+21,282** | −1,382 | **PASS** |
| momentum | 1-min lag (open) | any | ≈ −66k | −23k | BREACH |
| open drive | ≈live (close) | Y | +6,067 | −291 | **PASS** |
| open drive | 1-min lag | any | ≈ −2.5k | −1.5k | PASS (negative) |
| expansion retrace | limit mechanics | N | −53,508 | −7,938 | BREACH |
| expansion retrace | limit mechanics | Y | −67,543 | −15,000 | BREACH |

Conclusions:
1. **Momentum and open survive honest fills** — momentum +$21k with stop
   slippage at live dispatch speed (PASS). Their edges are LAG-SENSITIVE:
   a ~1-minute entry lag flips momentum to −$66k. Live dispatch is
   immediate, so they sit in the healthy column — the crossed-limit gate
   keeps them there.
2. **Expansion retrace is negative in this audit** (−$53k) and contradicts
   the published redesign validation (+$58k). The prime suspect: the
   published number validated the scale-out LADDER (bank 2/3 + runner
   ladder), while live runs the single-leg 1R path (CROSSTRADE_SCALEOUT
   is off). This needs a dedicated reconciliation — the live expansion
   path is NOT validated until then.
3. The RTH result stands (−$26k, the only family with the tight 0.5× stop
   inside flush tape).

## The bounded live experiment (the owner's "keep the config" proposal, done properly)

Keep RTH's config, keep all execution protections, cap size
(`MAX_MICRO_CONTRACTS=8`), run N days / M cards, and use the journaled
stop-fill data to fit the REAL slippage distribution. Then re-run the
study with the measured parameter:

- If measured routine slip ≈ 1 tick → the model was too harsh; RTH is
  back on the table.
- If ≈ 1–2 pts → the model was right; the config is retired or
  re-studied with different mechanics (wider stop → smaller size →
  fewer runs).

That is the execution-layer countermeasure taken as far as physics
allows, plus the one assumption tested with evidence instead of a proxy.
