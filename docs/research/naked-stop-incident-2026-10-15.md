# Naked-stop incident — 2026-10-15 (account blown)

The second naked-stop incident, and the first that actually blew an
account. The 2026-10-08 protections existed and were armed — this one
slipped through the remaining gaps between them. All three gaps are now
closed (commit `[backtested: scripts/rthDriftOptimizer.ts]`).

## Timeline (ET, from Neon exec_log / exec_trades / signals / guard_state)

| Time | Event |
|---|---|
| all day | CrossTrade account API degraded: `guard: crossGuard: account snapshot unreadable — halting` on nearly every card since 10-13 evening; vendor snapshot endpoint flaps between real numbers and HTTP 200 with `accounts: []` |
| 14:56:24 | Card `rth\|2026-10-15\|short\|13:55` (sell limit 30011.38, stop 30014.94, target 30002.47, 8 MNQ, "risk $57") — first dispatch attempt FAILED on the unreadable snapshot |
| 14:56:58.8 | Feed re-emitted the same card; the snapshot read succeeded momentarily; the resting limit was placed. The broker market was ~30016.75 (the GoCharting tape used by the crossed-stop gate lagged ~2+ pts) → the "limit" was marketable and filled instantly at **30016.75 — 1.81 pts beyond the stop** |
| 14:56:58.9 | Tradovate **rejected the OSO stop leg** (a short's buy-stop below the market is invalid) — 8 MNQ ran with NO stop |
| 14:56:59 | Burst verifier (`reactToBadStopLeg`) read positions and got "flat" (degraded/empty read 0.2 s after the fill), logged `repair_aborted_flat … no repair needed`, and went silent — no re-arm, no flatten, no alert |
| after | The 10s protection watchdog (`checkProtection`) also read "no position" and **cleared the protection registry on the first flat read** (`setOpenProtection(null)`) — the position stayed invisible to every protection layer while the account bled |
| 15:00:52 | `guard_state` shows the account switched to a fresh eval `MFFUEVREOD706880009` — after the blow-up |
| 15:24 | Executor still alive, still failing closed on the unreadable snapshot (correct behavior) |

`exec_trades` id 64 (`order_id 701340580159`) stayed `filled` with no
exit as of 15:06 ET — the system never saw the position's exit; the
16:50 ET reconcile owns the final P&L attribution.

## Root causes (stacked, all needed to close)

1. **The crossed-stop gate validates against the GoCharting TAPE, which
   lags the broker market by seconds.** Documented since 2026-10-04
   (tape 31141 vs broker 31155). At dispatch the tape was ≤30014.93
   while the broker was 30016.75 — the gate passed, the fill crossed the
   stop, the OSO stop was rejected. The 10-08 fix checked the right
   thing at the wrong source.
2. **`reactToBadStopLeg` treated ONE "flat" positions read as proof the
   trade closed.** Taken 0.2 s after the fill — vendor fill
   reconciliation lag, or the degraded `success:true + data:[]` shape —
   it read flat while the position was open, and the branch returned
   silently (`repair_aborted_flat`, no Telegram alert).
3. **`checkProtection` collapsed "unreadable" into "flat" and cleared
   the protection registry on a single flat read** — the watchdogs were
   blind for the rest of the position's life.
4. **One execution alert per card key per session** (`alerted` set):
   the first failed attempt paged once; the second, lethal dispatch
   placed and filled without raising anything.

## Fixes (all fail-safe; see the commit)

1. `confirmFlatREST()` — a filled entry + bad stop leg requires TWO
   consistent flat position reads ~4 s apart before "no repair needed".
   Open → repair (re-arm or flatten) immediately; unreadable → alert and
   KEEP WATCHING (the bracket stays registered, the burst keeps polling,
   the watchdog stays armed). Never silent.
2. `checkProtection` — discriminated flat/open/unreadable reads; the
   protection registry is only released when an opposite-side exit fill
   covers the entry or the flat claim persists across two polls;
   unreadable book while a tracked entry exists pages the operator.
3. Stale-tape limit refusal — resting-limit dispatch requires a tick
   within 30 s (`tapeFreshForDispatch`) at the executor choke point and
   at the RTH / momentum-retrace feed gates. A stale tape cannot prove
   the OSO stop is valid broker-side, so no limit is dispatched. Market
   entries are unaffected.

## Verification

- `npm test`: 1017 tests, 1010 pass, 0 fail, 7 skipped.
- `npx tsc --noEmit`: clean.
- `scripts/rthDriftOptimizer.ts` (run against the working tree): the
  crossed-gate treatments (`x-gate`, `x-gate-limit`) are modeled; the
  stale-tape refusal is the gate treatment at dispatch time, so the
  study's gate cells bound the skipped-card cost.

## Lessons (do not regress)

- A "flat" broker read is an assertion about a remote system's
  reconciliation state — never a proof, and never allowed to silence a
  protection layer. Confirmations must be repeated or corroborated by
  the fills stream.
- Unreadable and flat are different outcomes and must stay different in
  every protection path.
- A dispatch gate that validates broker-side order validity must use a
  broker-fresh input; when none exists, the correct answer for resting
  limits is refusal, not a best-effort guess.
