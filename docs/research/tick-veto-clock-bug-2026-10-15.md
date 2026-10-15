# Post-mortem: the tick-veto clock bug — a self-inflicted zero-signals morning (2026-10-15)

> What happened, why it happened, and what changes so it can't happen again.
> Written by the agent that introduced the bug, on the day it was found.

## Timeline

| time (ET) | event |
|---|---|
| 10-14 evening | momentum chase fixes deployed (`a39be78` flushLimit), account switched to `MFFUEVREOD706880009` (fresh eval) |
| 10-14 → 10-15 overnight | REAL vendor stall: ~801 card deferrals, 3 heal episodes (the tape gate held on unconfirmed bars — the pre-existing fail-closed design) |
| 10-15 ~08:03 | `c722acb` deployed: tick-fire fallback + stale-signal veto + paging |
| 10-15 08:03 → 10:35 | **zero signals despite a healthy feed** — the stale-signal veto read every footprint bar's Chicago-stamped time as UTC, inflated the tail age by ~5 h, and vetoed EVERY card from every family |
| 10-15 ~09:20 | agent misdiagnosed the state as "vendor frozen for 6.5 hours" (misread its own log clock) and deployed a frozen-bars watchdog on the wrong premise |
| 10-15 ~09:57 | tick probe proved the vendor stream live with current timestamps — the freeze diagnosis retracted |
| 10-15 ~10:30 | the "tail 18,060 s old" line next to a fresh candle (impossible) led to the real root cause: the clock mix in `barCloseMs` |
| 10-15 ~10:50 | `284b98b` deployed: `barCloseMs` understands both clocks (UTC for live minutes, America/Chicago for footprint bars); unit tests pin both conversions |

## The bug

`lib/signalFeed.ts` `barCloseMs` was extended to accept footprint bars
(which carry `d` = feed date, `t` = feed HH:mm). The footprint clock is
the vendor's **America/Chicago** stamp (see `times.ts utcToFeedStamp`),
but the helper parsed `d+t` as UTC. In October (CDT = UTC−5) every
footprint bar's computed close was 5 hours too early, so:

- `staleTailBar(fp, STALE_SIGNAL_VETO_MS)` saw a healthy 1-minute tail as
  ~5 h old → vetoed every momentum/RTH/open card (zero signals all morning).
- `tapeGateHoldsCore`'s tick-fire age check saw the same inflated age →
  constant fallback releases + TICK-BAR FIRE notice spam.

## Why it shipped

1. The change was made fast, under "FIX IT NOW" pressure, across three
   rapid deploys in one morning.
2. The unit tests written for the change encoded the SAME wrong clock
   assumption (they asserted the UTC interpretation of Chicago-stamped
   bars) — the tests passed and proved nothing.
3. The anomaly was visible for hours in the logs ("tail 18,060 s old"
   beside fresh candles) and was read as a vendor freeze instead of a
   local math error; the earlier misdiagnosis then directed a watchdog
   at the wrong layer.

## What this cost and what it didn't

- Cost: a morning of zero signals on a healthy feed + operator trust.
- Not at risk: money. Every failure mode was fail-closed — the account
  stayed flat at $50,000, no order was ever placed on bad data, the
  guard never saw a non-zero day P&L. The bugs killed signals, not trades.

## What changes

1. **Verification before claims** — a live-anomaly check is mandatory
   before any diagnosis is delivered: cross-validate computed values
   against wall-clock truth (the "18060s tail + fresh candle" cross-check
   that found this bug).
2. **Contract-level tests for shared helpers** — `barCloseMs`'s consumers
   had different clock assumptions; the tests now pin BOTH conversions
   (`du` UTC and `d` Chicago) so a future caller change fails loudly.
3. **Env kill-switches for every new veto/fallback knob** —
   `TAPE_GATE_TICK_FIRE_MS=0` and `STALE_SIGNAL_VETO_MS`-class knobs must
   be neutralizable in one Coolify edit, no deploy required.
4. **Slower live changes** — one behavior change per deploy, with an
   explicit risk-surface list (what else could silently break) and a
   post-deploy verification of exactly those paths.
5. **This file** — the record stays honest in the repo.

*Educational record — not financial advice.*
