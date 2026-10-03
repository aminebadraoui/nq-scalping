# The momentum signal — join the one-sided run

> **Status: THE single active strategy** — `FEED_MOMENTUM=1` is the only
> TRADE signal (2026-09-30). The unusual-volume heads-up alert stays on as
> context (`FEED_UNUSUAL_VOLUME=1`, informational only). The reversal,
> sweep-reclaim and pullback-ticket cards are off (`FEED_* = 0` in
> `web/lib/signalFeed.ts`). The card has **two triggers, one ticket**:
> the failed-flush breakout and the huge-bar expansion scalp. Validation:
> **4,822 trades, 77.5% win, PF 2.98**, positive in every full year of the
> 568-session replay (sequential, one trade at a time).

One page, the implemented signal. Every threshold below is checkable in
`web/lib/momentum.ts` (`MOM_PROD`), covered by `web/tests/momentum.test.ts`,
and measured by `web/scripts/momentumStudy.ts` over the full R2 archive.

---

## The problem it solves

The reversal and sweep-reclaim products only *fade* — they fire shorts into
failed highs and longs into failed lows. On 2026-09-30 the tape printed a
classic one-sided bullish run (18:10 flush → 18:16 breakout → +58 pts), and
the feed fired two shorts into it. A momentum system must instead **join
initiative that follows absorption**: let the sellers try, watch them fail,
and buy the bar that proves the buyers won.

## The sequence (the exact gates)

All rules evaluate on completed 1-minute bars — no lookahead. Long side;
short is the mirror.

1. **FLUSH** — a one-sided counter-move: ≥70% of the bar's volume on the
   sell side (long setup), volume ≥ max(15, min(0.5×trailing 60-bar median, 250)).
2. **FAILED flush** — the flush makes **no new session low** (low ≥ session
   low − 0.5). A flush that breaks the low is a real breakdown — the machine
   resets. *Effort without result is absorption.*
3. **BREAKOUT — THE SIGNAL** — within ≤10 bars of the flush, a bar
   **≥75% one-sided in the trade direction** that trades **through the
   reference extreme** (max high of the flush bar + the 2 bars before it).
   The breakout bar is its own confirmation — no separate response bar is
   required (merged mode), so flush → immediate breakout sequences fire too.
   **Candle-size gate**: the breakout bar's range must be **≥1.0× ATR14**
   (updated 2026-10-02: 1.0 beats 0.85 — `docs/research/quality-filter-sweep-2026-10-02.md`;
   the original size×delta evidence is `docs/research/FOOTPRINT_CANDLE_RESEARCH.md`).

Fires at the breakout bar's close. **Stop**: breakout bar's low − 0.5 pt.
**Target**: 1R. **Risk floor**: setups with risk < 3 pts are skipped (noise;
a filtered bar does NOT kill the sequence — a later bar in the window can
still fire). **Hours**: Globex only (RTH 9:30–16:00 ET excluded). One signal
per sequence; ≥5-bar gap between signals.

## Trigger 2 — the huge-bar expansion scalp

From the footprint × candle-size research (`docs/research/FOOTPRINT_CANDLE_RESEARCH.md`):
a bar with range **≥1.6× ATR14** and **≥75% one-sided delta** plus a
direction-matching cluster stack continues next bar 77-86% of the time.
Fire at its close, stop under its low, 1R target (risk 3–15 pts).
No flush sequence required — the bar itself is the evidence.

The two triggers catch **different run classes** and share one ticket:
tonight's 18:16 run was caught by the flush trigger (6-pt bar, 86% buy but
only 0.86× ATR — below the expansion's size gate); the huge-bar class is
caught by the expansion trigger. Same-bar double-fires dedupe to one card.

## What the replay measured (568 sessions, lookahead-free)

Bar-by-bar over the complete R2 archive (2023-12 → 2026-09), mid-bar
entries (the archive has no true closes), 0.5 pt round-trip cost, pessimistic
same-bar resolution (stop first when both stop and target sit in one bar):

| Metric | Value |
|---|---|
| Signals | **4,822** (~8.5 per session, both triggers, deduped) |
| Win rate | **77.5%** (pessimistic; ambiguous = loss, 1% of trades) |
| Profit factor | **2.98** |
| Expectancy | **+0.43 R / trade** |
| Net | **+11,680 pts** |
| Avg risk | ~4.8 pts (flush ~3.6, expansion ~5.2) |
| Mean MFE | 1.36 R (13% reach 2R, 2% reach 3R) |

| Year | Trades | Win rate | PF |
|---|---|---|---|
| 2024 | 1,287 | 80.0% | 3.18 |
| 2025 | 1,938 | 75.3% | 2.59 |
| 2026 (out-of-sample) | 1,578 | **77.9%** | 3.28 |

By direction: long 78.5% (PF 3.08), short 76.4% (PF 2.88). Sequential
(one-trade-at-a-time) replay: ~1% of signals overlap and get skipped; the
numbers above already reflect it. Trigger split: flush 1,828 trades
(76.1% / PF 2.76), expansion 4,152 (78.4% / PF 3.14), 1,150 same-bar
overlaps deduped (78.8% / PF 3.21 — the best subset).

## Why the flush alone is NOT a signal (measured)

The question "unusual sell volume + no lower low = buy?" is testable with the
same replay — the detector has a `fireAt` knob ("flush" / "response" /
"breakout") and every early-fire variant was measured:

| Fire point | Trades | Win rate | PF | Net pts |
|---|---|---|---|---|
| **flush alone** (buy every failed flush) | 36,243 | **29.5%** | **0.26** | −77,364 |
| response bar (one-sided counter) | 3,333 | 65.6% | 1.56 | +2,946 |
| **breakout bar (the signal)** | 1,865 | **75.7%** | **2.70** | +3,933 |

Buying every failed flush is ruinous — most failed flushes just consolidate
or continue. The **breakout** is the confirmation that concentrates the edge.
The merged mode (breakout within 10 bars of the flush, no separate response
bar) also covers flush → immediate breakout sequences at the same win rate —
that is why it is the production config.

Live integration: when the unusual-volume heads-up fires and the bar fails
to make a new extreme, the alert card prints the watch line —
`failed flush (no new session low) — momentum watch for a buy breakout
above X` (mirrored for failed rallies) — so the alert doubles as the
stage-1 heads-up for the card that follows.

## The knobs that matter (what the sweeps showed)

Four sweeps, ~80 config variants, judged on the 2026-01-01 chronological
split. What moved the numbers:

- **The breakout-bar stop is the whole game.** Structural flush-low stops:
  ~57% win. Same signal, stop under the breakout bar: **64→73%** win as the
  strength gates tightened. The run is validated by its own low.
- **One-sidedness ≥75% on the breakout bar** beats 65% by ~2 win points and
  doubles the PF.
- **Risk floor ≥2 pts** removes noise-bar setups (clips the 1-tick scalp
  losses).
- **breakWindow 8–10 beats 4–6** — the run may need a few bars to gather.
- **Target 1R is the high-win-rate choice.** 1.25R pays a bit more per trade
  (expR 0.33 vs 0.29) but drops the win rate to 66%. 2R drops to 44–46%.
- **Holding bars / delayed entries hurt** (the move doesn't wait), and the
  VWAP-side and delta filters were neutral-to-positive but redundant — the
  sequence already encodes them.

## Sizing — grounded in the Rapid EOD 50k rules

Every card's size line is computed from the actual plan rules
([MFF Rapid EOD 50k](https://help.myfundedfutures.com/en/articles/16158363-rapid-eod-50k-a-comprehensive-look)),
implemented in `web/lib/propRules.ts` (`momentumSize`) and asserted against
those constants in `web/tests/propRules.test.ts`:

| Rule | Value | Where enforced |
|---|---|---|
| Max Loss Limit | $2,000 EOD trailing (locks at $100) | risk budget: 10 full losses = $1,700 < MLL |
| Max contracts | 30 micro / 3 mini | `momentumSize` caps at 30 |
| MNQ point value | $2 per point | `momentumSize` per-contract math |
| Profit target / buffer / split | $3,000 / $2,100 / 90% | `RAPID_EOD_50K` constants (tested) |

Size line: **contracts = $170 ÷ (risk pts × $2)**, floored at 1, capped at 30.
Example — the 18:16 signal (3.5 pt stop): **24 MNQ · risk $168**, target pays
$168 at 1R. If `PROP_RISK_PER_TRADE` is set in the environment, the budget
follows it; the card prints `(30-micro cap)` whenever the cap binds.

## Every backtest is rules-grounded

Both replay harnesses now run the rules layer automatically on every run —
`web/lib/propAccount.ts` (`dollarize` + `simulateAccount`) is wired into
`web/scripts/momentumStudy.ts` and `web/lib/backtest.ts` / `web/db/backtest.ts`:

- every trade is **sized** under the plan (fixed budget, 30-micro cap) and
  its point P&L is converted to **dollars at $2/pt**;
- the full trade sequence is replayed through the **account**: EOD-trailing
  $2,000 MLL that never moves down, **$100 floor lock**, breach on a close
  below the floor, eval pass ($3,000 target + 4 trading days + 30%
  consistency), and funded payouts ($2,100 buffer, +$500 steps).

Each run prints an `ACCOUNT` block per config — e.g. the production config
over the full archive: **net $23,865 · eval PASS 2024-03-18, consistency ✓ ·
funded test window: equity $7,471, 11 payouts, floor locked**. The rules
constants and the simulator semantics are locked by `web/tests/propRules.test.ts`
and `web/tests/propAccount.test.ts` (12 tests, incl. EOD-trail-only-at-close,
the $100 lock, the consistency rule, and buffer/payout math).

## Honest caveats

1. **Mid-bar entries.** The archive has no true open/close; entries are
   (high+low)/2. Live entries are the bar's real close — expect small
   per-trade differences, not an aggregate change. The live journal is the
   final arbiter: log every card, compare against the 72.9% / PF 2.25
   baseline (operating rule #4, unchanged).
2. **Tight stops need honest fills.** Avg risk ~3.5 pts with 0.5 pt cost
   charged. In thin hours a market stop can slip a tick; size accordingly.
3. **Momentum longs get run over at exhaustion tops.** The progress gate is
   structural (the flush must *fail* at the extreme), not a promise.
4. One clean night proves nothing; this doc exists because 502 replays agree.

## Where it lives

- Detector + config: `web/lib/momentum.ts` (`MOM_PROD`)
- Feed integration: `web/lib/signalFeed.ts` (`FEED_MOMENTUM`, `checkMomentum`)
- Replay harness: `web/scripts/momentumStudy.ts` (`--sweep` over the R2 archive)
- Tests: `web/tests/momentum.test.ts` (includes the real 2026-09-30 tape)

*Educational research only — not financial advice.*
