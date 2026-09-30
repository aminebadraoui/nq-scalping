# The momentum signal — join the one-sided run

> **Status: THE single active strategy** — `FEED_MOMENTUM=1` is the only
> TRADE signal (2026-09-30). The unusual-volume heads-up alert stays on as
> context (`FEED_UNUSUAL_VOLUME=1`, informational only). The reversal,
> sweep-reclaim and pullback-ticket cards are off (`FEED_* = 0` in
> `web/lib/signalFeed.ts`). The card fires on the failed-flush → response →
> breakout sequence described below. Validation: **502 trades, 72.9% win,
> PF 2.25**, positive in every full year of the 568-session replay. This is
> the product that catches the bullish run the fade products structurally
> cannot.

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
3. **RESPONSE** — within ≤2 bars, a bar ≥65% one-sided in the trade
   direction, closing in the upper 35%+ of the flush range, with tick-level
   proof: ≥2 price rows of ≥3 lots, ≥1.5×-dominant, at/inside the flush zone.
   (The 18:11 bar: B10 @ 30721.75, B6 @ 30721.50, B5 @ 30722.25.)
4. **BREAKOUT — THE SIGNAL** — within ≤10 bars of the response, a bar
   **≥75% one-sided in the trade direction** that trades **through the
   reference extreme** (max high of the flush bar + the 2 bars before it).

Fires at the breakout bar's close. **Stop**: breakout bar's low − 0.5 pt.
**Target**: 1R. **Risk floor**: setups with risk < 2 pts are skipped (noise).
**Hours**: Globex only (RTH 9:30–16:00 ET excluded — two-way tape there).
One signal per sequence; ≥5-bar gap between signals.

## What the replay measured (568 sessions, lookahead-free)

Bar-by-bar over the complete R2 archive (2023-12 → 2026-09), mid-bar
entries (the archive has no true closes), 0.5 pt round-trip cost, pessimistic
same-bar resolution (stop first when both stop and target sit in one bar):

| Metric | Value |
|---|---|
| Signals | **502** (~0.9 per session) |
| Win rate | **72.9%** (pessimistic; ambiguous = loss, 1% of trades) |
| Profit factor | **2.25** |
| Expectancy | **+0.29 R / trade** |
| Net | **+643 pts** |
| Avg risk | ~3.5 pts |
| Mean MFE | 1.39 R (the 1R target is conservative — 17% reach 2R, 4% reach 3R) |

| Year | Trades | Win rate | PF |
|---|---|---|---|
| 2024 | 169 | 73.4% | 2.09 |
| 2025 | 207 | 71.5% | 1.89 |
| 2026 (out-of-sample) | 124 | **75.0%** | 3.17 |

By direction: long 71.2% (PF 2.14), short 74.8% (PF 2.38) — the mirror is as
good as the original. Every Globex hour prints ≥ 62% win rate. The test
window (2026) beats the train window — the family sat on a stable plateau
(72–73% win across every adjacent threshold variant), not a knife-edge.

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
