# Missed beautiful trades — the 2026-10-08 → 10-15 week, replayed through the current strategies

> Question: *"What did the recent tape do, and which beautiful trades did our
> current strategies miss?"* — answered by replaying the CURRENT live strategy
> set over the last six sessions and diffing against what actually fired and
> filled live (Neon `signals` / `trades` / `exec_log` / the Mac daybook).
> Scratch audit — not a validation cohort. Written 2026-10-15.

## What this replay is (and isn't)

- **Detectors frozen at production configs:** `MOM_PROD` (failed-flush
  breakout, Globex), `EXP_PROD` (huge-bar expansion), `SOFT_PROD` (RTH
  continuation), `OPEN_PROD` (open drive).
- **Entry/exit = the current live mechanics:**
  - flush → resting limit **at the signal close, TTL 9 min** (the
    `flushLimit` arm, momentumEntryMechanics study), brackets from the fill,
    structural risk, 1R target, same-bar stop-first;
  - expansion → resting limit **1 pt behind the close, TTL 5 min**
    (`EXP_RETRACE`), brackets from the fill, 1R;
  - RTH → resting limit **at the signal price, TTL 9 min, 0.5× structural
    stop, 2.5R target**, 60-bar horizon, crossed-stop dispatch gate;
  - open drive → marketable at the close, fixed **+15 / −35**.
- **Tape sources:** R2 archive (10-08, 10-09, 10-12, 10-13) + fresh vendor
  pulls for 10-14 and 10-15 (the 10-15 file is the partial in-progress
  session, `is_complete=false`, through 11:13 ET) + Neon `candles_1m` for
  OHLC joins. CLI: `web/scripts/missedTradesReplay.ts` (scratch, uncommitted).
- **This is a trade-review narrative, not a T0–T4 study report.** Each
  mechanic's measured numbers live in its own study (PLAYBOOK, `momentum-
  entry-mechanics-2026-10-14`, `rth-limit-fill-drift-2026-10-13`). Gross
  points, no fees/slippage charged in the tables below.

---

## 1. The tape — six sessions, two macro days

| session (RTH date) | open → close | range | biggest bar | character |
|---|---|---|---|---|
| 2026-10-08 | 31,403 → 31,021 (**−382**) | 674 | 117.3 pts @11:17 CT | chop into a 12 ET dump; owner kill-switch afternoon |
| 2026-10-09 (Fri) | 31,020 → 31,123 (+103) | 314 | 48.3 pts @08:40 CT | quiet drift up; **eval target reached 10:39 ET → guard froze the day** |
| 2026-10-12 (Mon) | 31,145 → 30,877 (**−268**) | 445 | 68.0 pts @08:35 CT | one-way sell day; naked-stop slips (275 pt / 39 pt) |
| 2026-10-13 (Tue) | 30,876 → 30,782 (−94) | 315 | 60.3 pts @08:33 CT | grind-down; afternoon cards printed but never traded |
| 2026-10-14 (Wed, **PPI**) | 30,788 → 30,139 (**−650**) | 814 | **210.3 pts @07:30 CT** (= 08:30 ET, the PPI bar) | the crash day: five RTH shorts, zero fills, −450 pts of follow-through missed |
| 2026-10-15 (Thu, in progress) | 30,156 → 30,022 (−135 by 11:13 ET) | 536 | 139.0 pts @07:30 CT | **V-day**: 09:30 ET open flush (76-pt bar, 8,303 contracts) → low 29,622.50 @09:57 ET → +283-pt rip in the 10 ET hour — all inside the veto window |

The two violent days were macro days: **CPI 10-13, PPI 10-14** (both 8:30 ET),
and the 10-15 V-morning followed them. The strategies' detector cards printed
on exactly the right days — the money was lost *after* the signal, in the
execution stack.

---

## 2. Headline

**46 replay-winner cards were never live-executed: +530.5 pts gross
(≈ $5,654 at $100-budget sizing) plus 4 missed open-drive cards (+15 pts each).**

The misses cluster into five causes:

| cause | replay pts | what happened |
|---|---|---|
| never-fired (live stream never had the card) | 231.3 | detector/feed divergence + journaling gaps — the biggest bucket |
| occupancy / momentum-gap sequencer casualties | 238.4 | one-position-at-a-time drops (replay-modeled; see caveats) |
| **decided-no-fill** | 45.8 | live SIGNALED the card, the limit never filled (trend days) |
| **veto-bug window (10-15 08:03–10:35 ET)** | 15.0 | the clock bug zeroed the morning (see `tick-veto-clock-bug-2026-10-15`) |
| guard-halted / target-reached | — | the executor refused good cards (scored below in §4, not in the replay list) |

---

## 3. The flagship misses

### 3a. The PPI crash day (10-14) — five RTH shorts, zero fills

The system *saw the day perfectly*: five short cards down the cascade
(12:10 @30,301 → 15:00 @30,118). Live result: **nothing traded.**

- 12:10 / 13:26 / 13:50 — the executor **refused to place them**:
  `guard: crossGuard: account snapshot unreadable — halting` (exec_log).
- 14:40 / 15:00 — never attempted (no exec_log rows, no trades rows).
- Replayed on the settled vendor tape with the live bracket (limit at the
  signal price, TTL 9, 0.5× stop, 2.5R target):
  - 12:10 / 13:26 / 13:50: **honest no-fills** — a short resting limit can't
    fill on a one-way selloff (tape highs after the signal: 30,294 → 30,147,
    never back to the limit). The limit-entry design's known blind spot.
  - 14:40: fills at 14:41 ET, **stopped** (the closing bounce).
  - 15:00: fills at 15:01 ET, **hits the 2.5R target +16.9 pts**.
- The signal scorer (signal-anchored brackets) marked all five winners
  (MFE 9.9–39.4 pts). So: the detector was right, the guard + the entry
  mechanics together delivered zero.

### 3b. The veto-bug morning (10-15) — a 536-pt V-day with zero cards

08:03–10:35 ET today: every card from every family was vetoed by the
Chicago-stamped-as-UTC clock bug (post-mortem in
`tick-veto-clock-bug-2026-10-15.md`). The tape in that window:

- 09:30 ET open: 76-pt flush bar on 8,303 contracts (the cascade);
- 09:57 ET: session low 29,622.50;
- 10:00 ET hour: +283-pt rip back to 29,971.

Detector replay over the window finds **one** card: the open drive
09:39 long @29,810.75 → **+15.0** in one bar (tagged `veto-bug`). The rest of
the V-shape was a *real* breakdown-then-trend-reversal, not a failed-flush
pattern — the flush machine correctly reset at the new low, so the honest
headline for the morning is the missed drive plus a morning of RTH/open
continuation setups the RTH detector declined on ATR14 inflated by the
139-pt bar. The bug cost signal coverage on the week's best reversal, not a
stack of specific flush tickets.

### 3c. Tuesday afternoon (10-13) — six signal-winners, zero executions

Live printed RTH shorts all afternoon (11:08, 11:21, 12:47, 13:24, 13:46,
14:35, 15:35 — scorer: **7W/0L**, MFE 7–11 pts) and **none of them traded**:
no exec_log attempts, no trades rows. The morning's three fills (10:16,
10:25, 10:59 — all losses, incl. an 11.8-pt stop slip) were the last things
the executor did that day; the guard's account-snapshot failures that had
already hit Monday (below) quietly continued. The owner was trading manually
at 11:44 and 14:23 ET (daybook, qty 25 micros, exits outside the fill
window).

Replay (settled tape, live limit bracket) of the three biggest afternoon
cards: **13:24 short +11.6 (1 bar) · 14:35 short +10.0 (1 bar) · 15:35 short
+14.7 (8 bars)** — all fill and hit 2.5R in replay. The limit-entry design
did NOT explain these misses (the tape did return); the executor silence did.

---

## 4. The execution-stack ledger — why good cards died (exec_log, all week)

| when | event | consequence |
|---|---|---|
| Fri 10-09 10:39 ET | `guard: equity $53,012 ≥ target $53,000 — target reached, stop` | **16 cards refused 10:39–15:52 ET**, incl. replay-winners 11:58 short +16.9 and 15:28 short +15.0 |
| Mon 10-12 10:2x ET | `protection watchdog: stop_slipped — stop 30,909.63 filled at 31,185.25 (275.6 pts)` | the naked-stop recurrence (see `naked-stop-recurrence-2026-10-12.md`) |
| Mon 10-12 | `stop_missing — stop leg Rejected after entry Filled` | naked entries again |
| Mon 10-12 15:1x ET | `flatten_arm fired: live P&L −$283 ≤ −$250` | day over via loss floor |
| Tue 10-13 | `stop_slipped 11.8 pts` · `target leg Canceled — stop remains working` | brackets degrading on ordinary fills |
| Tue 10-13 18:20/18:36/19:00 | chase fills + `stop_missing`/`repair_aborted_flat` | the momentum-entry-mechanics exhibit live: instant ±0.5 exits on fills 6–12 pts past the signal |
| Wed 10-14 12:10–13:50 | `guard: crossGuard: account snapshot unreadable — halting` | crash-day cards never placed |
| Wed 10-14 19:42 | `crossed-limit gate — tape through limit at dispatch` | correct skip (the 10-08-incident fix working as designed) |
| Thu 10-15 08:03–10:35 | stale-signal veto (clock bug) | zero signals on a healthy feed — see the post-mortem |

Account state today: fresh eval `MFFUEVREOD706880009`, equity **$50,000**,
floor $48,000, dayPnl 0 — the week's damage sits in the prior account's
ledger, and today's fresh start has been spent fighting infrastructure.

---

## 5. Per-strategy read

- **Flush (MOM_PROD).** The chase destroyed Tuesday's 18:20/18:36 longs
  (signal-bracket MFE +120.9 / +95.9 pts; live −0.5 / −0.5). The now-live
  `flushLimit` arm replays those two as **expired (no trade)** — the honest
  cost of the fix — and 01:45 as **+11.5** (live got +3.5 gross on the chase).
  Replay-only winners the live stream never had: 10-08 23:52 short +13.3,
  10-14 19:19 short +13.8, 10-14 04:50 short +8.8.
- **RTH (limit entries, 2.5R).** The design buys drift-safety and pays in
  trend-day participation: the crash-day no-fills and Tuesday's silent
  afternoon are the same mechanism from two directions (tape never returns /
  executor never places). Tuesday's three big replay winners (13:24, 14:35,
  15:35) are the strongest "we had the card and got nothing" evidence.
- **Open drive (+15/−35).** Four clean one-bar +15s across the week (10-08,
  10-12, 10-13, 10-14) plus today's vetoed one; only Friday's card ever
  reached the executor, and **drive cards are missing from `signals` on
  several days** — journaling/feed-path gap worth verifying.
- **Expansion (EXP_RETRACE).** Evening cards: 10-12 18:27 +8.8, 19:52 +9.5,
  10-08 18:45 +7.0, 22:47 +10.5. The live 10-14 19:42 card was skipped by the
  crossed-limit gate (correct per the gate) — replay says it would have won
  +4.5 gross; a nuance, not a headline.

---

## 6. Honest caveats

1. **Detector divergence between the live stream and the settled archive is
   real.** Example: on 10-14 the settled vendor file fires RTH cards at
   13:53 / 15:17 (longs at the bottom), while live printed the 12:10–15:00
   shorts. Never-fired cards in this audit are *replay-only* — the live feed
   may genuinely not have printed them (mid-bar archive entries, PLAYBOOK
   caveat 1).
2. Occupancy / momentum-gap tags come from a one-position-at-a-time
   sequencer (60-bar window) and are a replay model, not the live queue.
3. Replay P&L is **gross points**; the $ column is $100-budget sizing
   arithmetic, not an account claim. Open-drive cards are excluded from the
   $ sum (separate $170 budget).
4. The 10-15 file is a partial in-progress session (through 11:13 ET).
5. n is small and this is a labeled exhibit week, not a validation cohort —
   no threshold claims should be built on these tables; the mechanics'
   statistics live in their named studies.
6. Replay inputs for 10-14/10-15 are vendor pulls taken at audit time
   (`gcdata/data/2026-10-14_ETH.json`, `2026-10-15_ETH.json`, scratch).

## 7. Regenerate

```bash
# replay (from web/):
node --env-file=.env.local --import ../scripts/ts-loader.mjs \
  scripts/missedTradesReplay.ts
# vendor pulls (from gcdata/):
venv/bin/python collect.py --dates 2026-10-14 2026-10-15   # settled days
venv/bin/python probe_today_scratch.py                     # in-progress day
```

## 8. Proposals (nothing applied — per EXEC_CHANGE_POLICY)

1. **Guard-health paging:** the `account snapshot unreadable` state cost the
   crash-day cards silently — surface it to the owner with the card it just
   refused.
2. **RTH trend-day fallback (research input only):** measure a re-arm /
   deeper-limit leg or an imbalance-gated market leg for one-way tapes — the
   crash-day no-fills and Tuesday's silent afternoon are the same blind spot.
3. **Open-drive journaling:** verify the drive cards reach `signals` every
   day they fire (missing on 10-08/10-12/10-13/10-14).
4. **Post-fix verification today:** the veto fix shipped ~10:50 ET — confirm
   this afternoon's cards actually place before the fresh eval loses another
   day to infrastructure.

*Educational research only — not financial advice.*
