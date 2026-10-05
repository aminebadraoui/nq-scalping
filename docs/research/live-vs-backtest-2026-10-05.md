# Live vs backtest divergence — why the account is down $1,405 (2026-10-05)

> Diagnosis of the live bleed against the backtests, from the reconciled
> data: CrossTrade account snapshot, Neon `trades`/`signals`/`manual_trades`,
> the archived session tape, and the live engine's bar-building code.
> Machinery: `web/scripts/liveRescore.ts` (live cards re-scored under three
> bracket sets), `web/scripts/stopMultCalibration.ts` (the owner's own
> sweep), plus inline comparisons of live-written bars vs the archive.
>
> **Account truth (CrossTrade snapshot, MFFUEVREOD706880006): realized P&L
> −$1,405.50 · netLiq $49,852.20.** The bot is the loss source — manual
> trades are net positive (+$1,417.5 across 10 imported trips).

## The four divergences, in order of size

### 1. The live tape is not the backtest tape (root cause)

The backtests replay the archived GoCharting footprint candles (complete,
server-side buy/sell attribution). The live engine builds its bars from the
**tick stream** (`lib/live.ts` `applyTickTo`): every print classified by its
`side` field, with the fallback `ltp >= lastLtp ? buy : sell` (up-tick = buy)
when side is missing, size defaulting to 1 when `l_sz` is absent. A lossy
websocket cannot reproduce the vendor's aggregated candles.

Measured on 2026-10-01 (the session the executor traded 28 cards):

- The live card at 21:18 fired on a "76% buy" breakout bar (card text,
  TRADE_REVIEW_2026-10-02). The archive bar for 21:18 is **41% buy**
  (30 buy / 43 sell). 22:50: live 82% sell vs archive 63%.
- Consequently the backtested detector (MOM_PROD/EXP_PROD on the archive)
  generates **1 momentum + 1 expansion signal** for the whole of 10-01;
  the live engine fired **7 + 4** that day. RTH: archive detector finds 7,
  live fired 17.
- The live cards, re-scored on the archive tape, go **2W/8L under every
  bracket set** (profile, structural 1R, structural + wide target). The
  backtested edge simply does not exist for signals that only the live
  tape qualifies.

Every WR/PF number in PLAYBOOK.md and docs/research applies to a strategy
the live executor never actually trades. This is the single biggest "wrong
thing from the backtests": **the backtest data-generating process ≠ the
live data-generating process.**

### 2. The backtests trade ~1/3 as often as live

Every study replays one-position-at-a-time and skips any signal within
60 bars of the previous entry — **even when the previous trade already
closed** (`openUntil = entryIdx + HOLD_BARS`). The live feed takes every
card past the ≥5-bar gap.

| Day | backtest plan (archive, taken) | live cards |
|---|---|---|
| 09-30 | EXP 4 / RTH 5 | — |
| 10-01 | MOM 1 + EXP 1 + RTH 3 | 7 mom + 4 exp + 17 rth = 28 |
| 10-02 | MOM 5 + EXP 6 + RTH 4 | 18 rth + … |

3× the trade rate ⇒ 3× the commissions ($325 on 10-01 alone, against $165
gross) and the marginal cards are the losers. The plan that was validated
was "~5 cards/day"; the plan that runs is "every card".

### 3. The live stop profile is WR-optimal, points-suboptimal, and friction-fragile

Live profiles (`lib/profile.ts` defaults): MOM stop 0.35× / target 2.25R;
RTH stop 0.45× / target 1.75R. The owner's own sweep
(`stopMultCalibration.ts`, same targets, 649 sessions):

| MOM flush (2.25R · 60-bar) | pts | RTH (1.75R · 45-bar) | pts |
|---|---|---|---|
| 0.35× (live) | 2,632 | 0.45× (live) | 11,477 |
| 0.8× | 3,661 | 0.9× | 15,013 |
| 1.0× | 3,456 | 1.0× | 14,422 |

The optimizer picked the tight stops for their win rate, but at the live
targets **wider stops make more points**, and the stop-run rate is **96–99%
at every multiple** — nearly every loss is a run-back that a wider stop
would have survived. The profile was validated at 0.5 pt cost and perfect
close-price fills; live pays ≈0.95 pt round-trip **plus** a median −1.75 pt
adverse entry drift on losers (max −6.5, from `trades.entry_adverse_pts`),
plus quote-anchored brackets (the 01:27 case alone swung ~$300). On a
1.2–3.5 pt stop those unmodeled frictions are a large fraction of the
trade — the exact fragility `sizing-optimizer-2026-10-04.md` flagged and
shipped anyway.

### 4. Validation shortcuts + sizing beyond the envelope

- RTH's pick was selected by a **full-history filter** because the
  train/test split failed on regime-dependent drawdown
  (`rth-optimizer-2026-10-05.md` admits this) — weaker than the momentum
  walk-forward, and live RTH is running 58.1% vs the modeled 70.7%.
- Live sizing exceeds the backtested $170/trade budget: the 10-04/05 fills
  include 26-micro trades (≈$312 risk). The ×2 size the optimizer chose is
  "the max the account can bear" **at perfect fills**.
- Live outcomes to date: mom flush 4W/14L (28.6% vs 66.8–76% modeled),
  RTH 18W/31L (58.1% vs 70.7% modeled), expansion 8W/9L.

## What the backtests did NOT get wrong

The account drawdown (−$1,405.50) is *inside* the modeled tail (momentum
×2 @ 0.95 pt: max dd −$1,589; RTH ×2: −$1,943). The models were honest
about the tail; they were wrong about the **mean** because the live plan
is not the modeled plan (divergences 1–3 above).

## Recommended sequence

1. **Halt live execution now** (`EXECUTE_LIVE=0` on the VPS Coolify env —
   needs the owner's explicit approval; the Mac is already 0).
2. **Fix the tape first.** Drive the live detectors off the same
   GoCharting candle feed the archive is built from, or add a
   bar-confirmation gate (fire only when the vendor's completed candle
   agrees with the tick-built bar). Until live bars == archive bars, no
   backtest transfers.
3. **Re-validate the live plan with honest semantics**: gap-only replay
   (every card, not one-position-at-a-time), 0.95 pt cost, modeled −1.75 pt
   adverse drift on losing entries, walk-forward + MFF account sim. Expect
   the current profile to fail; measure the structural-bracket variant
   before re-enabling anything.
4. **Stop multiples**: the sweep favors 0.75–1.0× at the live targets —
   re-validate with frictions, then flip `MOM_STOP_MULT`/`RTH_STOP_MULT`
   via the EXEC_CHANGE_POLICY path.
5. **Size at ×1** ($170/trade, 30-micro cap) until the friction fixes land.
6. **Shadow-trade first**: cards print with `EXECUTE_LIVE=0` for a week
   and the live-bar vs archive-bar diff is journaled nightly.

*Educational research only — not financial advice.*
