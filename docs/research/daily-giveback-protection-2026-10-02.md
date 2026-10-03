# Daily give-back protection — analysis + replay study (2026-10-02)

## Today's fluctuation, decomposed

Session realized P&L: **peak +$642.8 at 13:44:45 → trough +$205.0 at 14:25:11
(−$437.8 give-back, 68% of the peak)** → closed +$250.4.

The give-back was three events in the 14:15–14:25 window:

1. **14:15 long −$98** — RTH long filled and stopped in 6 seconds into a falling
   afternoon tape (legitimate loss, but the tape had turned).
2. **14:19 long −$180** — stopped at 31021.5 (legitimate loss).
3. **14:21 stacked double-entry −$180 (bug)** — the verified re-send re-entered
   the SAME 14:19 card 105s later because its broker verification read
   "no working order, no position" (a stale/empty CrossTrade read) even though
   the original order had been ACCEPTED ("REST placed" at 14:20:11). Two 9-lots
   held the same signal; both stopped at 31021.5. The re-send feature was
   scoped too wide: it re-sent after SUCCESSFUL sends with no visible fill
   (a data-lag), not only after FAILED sends.

**Fix shipped**: the verified re-send now applies ONLY when the original place
attempt returned not-ok (`sendFailed`). A successful send with no visible fill
alerts ("SEND OK BUT NO FILL VISIBLE — do NOT re-send") and never re-enters.
Regression tests: `resendDecision` + the 14:21 stack scenario.

## Replay study — do protection rules pay? (648 sessions, Globex momentum, live sizing)

| Rule | Total profit | vs baseline | Worst day | Days halted |
|---|---|---|---|---|
| baseline | $60,316 | 100% | −$742 | — |
| give-back 30%/≥$150 | $45,627 | 76% | **−$249** | 330 |
| give-back 40%/≥$200 | $47,401 | 79% | −$449 | 299 |
| **give-back 50%/≥$250** | **$54,486** | **90%** | **−$496** | **105** |
| daily loss limit −$300 | $54,048 | 90% | −$523 | 74 |
| stop after 2 losses | $56,270 | 93% | −$496 | 72 |
| stop after 3 losses | $59,971 | 99% | −$741 | 12 |

Readings:

- **Consecutive-loss rules are nearly useless here** (99% of profit, no
  protection) — consistent with the research (a stop rule should not pretend
  the third loss predicts the fourth; [Trader's Second Brain: When to Stop
  Trading After Losses](https://traderssecondbrain.com/guides/when-to-stop-trading-after-losses)).
- **Give-back protection is a smoothing trade, not a free lunch**: it costs
  10–24% of total profit to cut the worst day by 33–66%. The 50%/$250 variant
  is the chosen balance: 90% of the edge, worst day −$496, halts only 105 of
  660 days.
- **Honest caveat**: today's give-back came mostly from OPEN positions stopping
  out — the rule halts NEW entries, so it would not have recovered the $437;
  it prevents the NEXT entries from deepening a bad day. The double-entry bug
  fix ($180) is the part of today that was recoverable — and is recovered.
- Further reading: [SMB — A Rule for Giving Back Profits](https://www.smbtraining.com/blog/a-4-the-trading-community-a-rule-for-giving-back-profits),
  [FTMO — risk management in practice](https://ftmo.com/en/blog/risk-management-and-psychology-in-practice-how-to-trade-without-stress/).

## Tiered sizing — smaller bets as the day's profit climbs

Replay (648 sessions, live sizing): tiered contracts by day P&L:

| Schedule | Total | vs base | >$900 breach days | Tiered trades |
|---|---|---|---|---|
| baseline (full size all day) | $60,316 | 100% | **4** | — |
| **2/3 @ +$300, 1/3 @ +$600** | **$58,573** | **97%** | **0** | 226 |
| 1/2 @ +$250, 1/4 @ +$500 | $56,849 | 94% | 0 | 309 |

The default schedule (2/3 @ $300, 1/3 @ $600) keeps 97% of total profit and
eliminates the days that would breach the $900 consistency cap — the cap makes
the day's payoff curve concave, so shrinking above +$300 costs almost nothing
while removing the eval-failing tail. This is cheaper than the give-back halt
(which costs 10-24%) because it fires on GREEN days, where the marginal dollar
has negative expected value anyway. `SIZE_TIERS` env overrides; `SIZE_TIERS=""`
disables.

## Integrated full-stack backtest (scripts/riskStackStudy.ts, 648 sessions)

All four live families (momentum rr1.0 + expansion + RTH + open drive),
globally sequenced one-position-at-a-time, ladder exits, LIVE sizing
($170-budget momentum, $200-capped fixed-9 RTH/open), commissions, then
the protection layers toggled, through the MFF account simulator:

| Variant | Trades | Total | Median day | Worst day | >$900 days | Sim |
|---|---|---|---|---|---|---|
| fixed 1R, no protections | 16,841 | +$640k | +$963 | −$1,387 | 342 | PASS |
| **ladder, no protections** | 15,745 | +$2.9M | +$4,160 | −$2,597 | 600 | **BREACH 2026-08-05** |
| ladder + day tiers | 15,745 | +$1.34M | +$2,004 | −$1,702 | 599 | PASS |
| ladder + give-back halt | 9,041 | +$1.70M | +$872 | −$1,128 | 322 | PASS |
| **full live stack** | 11,846 | +$1.0M | +$1,627 | −$1,128 | 434 | **PASS** |

Headline findings:

1. **The raw ladder breaches the account** — without protections it hits the
   trailing drawdown in Aug 2026 of the sim. The protection layers are what
   make the ladder survivable: every protected variant passes.
2. **Tiers are the cheapest protection** (ladder → +tiers keeps 46% of the raw
   total while turning BREACH into PASS); the give-back halt costs more total
   but produces the shallowest worst day (−$1,128) and the fewest big days.
3. **The full stack passes with the best risk profile**: worst day −$1,128 vs
   −$2,597 raw, and the eval completes.
4. Caveats: totals are optimistic vs live (no news gaps, 0.5-pt execution cost,
   every RTH signal taken, no execution misses) — read the RATIOS, not the
   absolute dollars. And note the "$900 breach days" column is our own
   conservative day-halt interpretation; MFF's actual rule is best-day ≤ 30%
   of end-of-eval total profit, which the simulator enforces in its
   consist ✓ flag.

## Implemented

- `accountGuard`: `dayPeak` tracked + persisted to Neon; new `halt-giveback`
  verdict — no new entries once the day gives back more than
  `max(GUARD_GIVEBACK_FLOOR, GUARD_GIVEBACK_PCT × dayPeak)` (defaults $250 /
  50%; env `GUARD_GIVEBACK_PCT=0` disables). Resets on the calendar rollover.
- `execWatch`: verified re-send scoped to failed sends only (see above).
- Tests: give-back trigger/floor/disable/rollover + resendDecision matrix.
