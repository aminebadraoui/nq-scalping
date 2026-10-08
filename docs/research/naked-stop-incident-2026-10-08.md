# Naked-position incident + stop-protection fix — 2026-10-08

## Second incident, same day — stop slippage (−$1,056)

At 12:17 ET the RTH short (15 MNQ, limit 31187.375, stop 31190.56 —
3.19 pts, "risk $96") filled instantly at 31189.75: the limit was
marketable, the tape had moved 2.4 pts through it. The signal-anchored
stop was then **0.81 pts from the actual fill**. The market flushed
~35 pts in 11 seconds; the stop triggered and the stop-market filled at
**31224.00 — 134 ticks past the trigger** (15 × 34.25 × $2 = −$1,027.50).
The stop existed and worked; the loss came from gap-through slippage on
a compressed stop. Day went +$724 → −$332.

Root causes (execution-level, family-agnostic):
1. **Crossed-limit dispatch**: the entry limit was already run through
   at dispatch → marketable → instant fill drifting past the signal.
2. **Signal-anchored brackets on drifted fills**: the planned 3.19-pt
   stop compressed to 0.81 pts. Momentum-retrace anchors to the fill;
   the RTH limit path anchored to the signal — the inconsistency.
3. **Fixed-$ sizing on a tight stop** → 15 contracts → slippage × size.
4. **Backtests score stop-outs at the trigger** (zero slippage) — the
   tight-stop configs' edge was partly this modeling assumption.

## Extra execution protections (shipped with the first fix)

5. **Crossed-limit dispatch gate** (`limitCrossedAtDispatch`, in
   `placeCrossTradeOrderREST`, 1-pt threshold): a limit the tape has
   already moved through at dispatch is refused — the entry premise is
   gone. Separates today's clean winners (0.1-pt crossings) from both
   disasters (13.0 / 2.4 pts).
6. **Fill-anchored re-bracket** (`reanchorBracketForFill` + the L2
   check at +4 s): when the fill drifted and compressed the stop
   (< 50% of the planned distance), the bracket is re-anchored to the
   actual fill via `cancel_and_bracket` so the planned risk holds.
7. **Executor contract cap** (`MAX_MICRO_CONTRACTS`, default 30): bounds
   slippage × size.
8. **Stop-slippage alarm** (`checkExitSlippage` + `classifyExitFill`):
   the watchdog compares the exit fill against the intended stop and
   alerts + journals when a stop fills far beyond its trigger.

Study: `scripts/rthDriftOptimizer.ts` extended with a stop-slippage
model (stop-market chases to the bar close), the crossed-limit gate
treatment, and a contract-cap sweep — see the focused safety grid in
its output.

## The incident

The 09:48 ET RTH short (7 MNQ, limit 31216.25, stop 31222.75, target
31200.00) opened with **no stop loss**. The user caught it and closed
manually at 09:52:44 ET @ 31215.50 (+13.75 pts ≈ +$192 gross). Broker
evidence (CrossTrade/Tradovate order lifecycle, ids 688241970704-6):

| Time (ET) | Event |
|---|---|
| 09:49:44.417 | REST limit placed (`muzlfch0-uzi2yu-lmt`); market ≈ 31229.25 — 13 pts above the limit |
| 09:49:44.422 | entry filled instantly @ **31229.25** (a marketable sell limit) — already 6.5 pts past its own stop |
| 09:49:44.427 | **stop leg REJECTED: `InvalidPrice` — "current price is outside the price limits set for this product"** |
| 09:51:28 | watcher logs `limit_filled` — the system believed the trade was protected |
| 09:52:44 | user closes manually (profit) |

## Root cause

1. **Dispatch lag with no price re-check.** The RTH card fires on the
   09:48 bar close but dispatches ~100 s later; the flush ran the tape
   13 pts past the limit in that window. A sell limit below the market is
   *marketable* — it fills instantly at the market, not at the limit.
2. **The OSO stop is anchored at the signal price, not the market.**
   Tradovate validates the stop leg against the CURRENT market at
   placement; a buy-stop below the market (the short's stop 31222.75 vs
   market 31229.25) is rejected ~10 ms after the place was accepted
   (`InvalidPrice`) — and the entry still fills. Position = naked.
3. **Nothing verified the bracket legs after placement.** The REST place
   response carries `oso1Id`/`oso2Id` (the OCO children) — the executor
   discarded them; the watcher only read *fills*, never the working
   orders. CrossTrade's docs explicitly warn that accepted ≠ resting and
   that REST integrations should re-read the order status seconds after
   placing.

## Why the backtest missed it

`rthDriftOptimizer.ts` / `rthLimitValidation.ts` modeled the crossed
case as a bounded stop-out **at the signal-anchored stop price** — for a
short filled above its stop that books an instant *win* (buy back below
fill). Live, the stop was rejected and the position ran naked: the
modeled profit was phantom. Re-running both studies with the crossed
cards treated honestly (see below) shows the live config's PASS
depended on it.

## The fix (three layers, all dry-run-gated by EXECUTE_LIVE)

**All three live at the executor choke point** (`lib/crossTrade.ts`), so
every REST placement — market or limit, any current or future feed
family (RTH, momentum/retrace, sweep-reclaim, open drive…) — gets them
automatically. No per-family wiring to forget.

1. **Crossed-stop dispatch gate** (`stopCrossedAtDispatch`, in
   `placeCrossTradeOrderREST`): a limit order whose OSO stop sits on the
   marketable side of the current tape at dispatch is REFUSED with a
   `crossed-stop gate` reason — Tradovate would reject that stop and the
   entry would fill naked. The feeds additionally skip such cards
   quietly at dispatch (journaled) so the refusal never reaches the
   re-send machinery; the executor backstop makes the invariant global.
   Market entries don't need it (dispatch is immediate; the tape can't
   be past the stop).
2. **Late-rejection check** (`verifyBracketsAfterPlace`, called by the
   executor ~4 s after every successful bracketed placement, using the
   `oso1Id`/`oso2Id` child ids now captured from the place response):
   stop leg rejected + entry still resting → the entry is **cancelled**
   before it can fill naked. Stop leg rejected + entry already filled →
   immediate repair (layer 3) — after confirming a position actually
   exists (a fast full OCO cycle also shows a cancelled stop).
3. **Protection watchdog + repair** (`checkProtection` in
   `lib/execWatch.ts`, 30 s broker poll + an immediate check at fill
   confirmation): the executor registers every placement's bracket
   (`registerOpenProtection`); while an MNQ position is open the
   watchdog verifies a working stop covers it. Missing (and the naked
   state persists across two polls — Tradovate activates a suspended
   stop a beat after the fill): **re-arm via `cancel_and_bracket`**
   (fresh TP/SL OCO around the live position, stop re-anchored 1 pt
   beyond the current tape so it cannot be rejected again), verified,
   else **flatten**. Untracked positions (manual trades) are alert-only,
   never touched. Scale-out positions flatten-only (the ladder owns the
   runner stop).

## Study results with the crossed-stop gate (652 sessions, drift-aware)

`scripts/rthDriftOptimizer.ts --offline` (x-gate/x-repair/x-reanchor
treatments) and `scripts/rthLimitValidation.ts --offline` (XGATE):

- Live config s0.5/t2.5 limit: ungated **$13.3k dd −$1.8k PASS** — of
  which the 52 crossed cards (2%) contributed ~$3.4k of *phantom* stop
  profits. With the gate: **$9.9k dd −$2.5k BREACH**; emergency-repair
  treatment: $1.1k dd −$2.6k BREACH; fill-reanchor: −$4.8k BREACH.
- Train/OOS with the gate: t2.5 OOS 2026 **BREACH** (dd −$2.5k);
  **s0.5/t2.0 passes** train/OOS/year/cost (≈ flat at $1.90/RT).
- Verdict: the RTH limit-entry edge that survived drift-aware fills was
  substantially the mis-anchored-stop artifact. The family is NOT
  validated in its current live form under honest crossed-stop
  handling; `FEED_RTH=0` until a passing safe config exists (or the
  owner consciously accepts the dd risk). The safety fix itself ships
  regardless — a naked position must never be possible.

## Files changed

The safety invariants live in the executor (`lib/crossTrade.ts`: gate +
child-id capture + registry + re-arm/flatten + post-place verification;
`lib/executor.ts` threads the ids + a label) and the account-level
watchdog (`lib/execWatch.ts`) — so every order path (current or future)
is covered. `lib/signalFeed.ts` only adds quiet dispatch skips for the
journal and passes alert labels. `lib/execLog.ts` gains the new
outcomes; tests + the two study scripts carry the gate and the crossed-
card treatments.
