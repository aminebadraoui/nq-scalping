# 2026-10-12 — naked-stop recurrence: the protection stack engaged, the repair path had a broken leg

The 2026-10-08 naked-position shape repeated on the RTH family this
morning. Unlike 10-08, the protection stack **did** detect the naked fill
within ~1–2 s — but two defects meant the automatic repair never
completed, and the owner closed manually again. This document is the
record: what happened, what held, what broke, and what was fixed.

## Timeline (10:26–10:28 ET, from Neon exec_log + signals + candles_1m)

| Time (ET) | Event |
|---|---|
| 10:26 | RTH short card fires: entry 30870.63 · stop 30876.94 · target 30854.84 · 7 MNQ — prices correct for the tape |
| 10:27:37 | initial placement FAILED: `guard: account snapshot unreadable — halting` (CrossTrade snapshot API flaky all morning — same at 00:21, 00:26, 10:22:31) |
| ~10:28 | a placement goes out as a resting limit; the tape rallies through it (10:28 candle opens 30884.50 — above the stop) → marketable sell fill, buy-stop below market → Tradovate rejects the stop leg (`InvalidPrice`) → **naked position** |
| 10:28:09 | BURST verifier catches it: `stop_missing — stop leg Rejected after entry Filled` — detection ≈ 1–2 s after the fill |
| 10:28:10–12 | owner closes manually; watchdog logs the flat transition at 10:28:12 |

The crossed-stop/crossed-limit gates legitimately passed: the limit was
placed while the tape was below the stop, and the tape ran through it
after placement. That residual race is exactly what the burst verifier +
repair are the backstop for — and the backstop's preferred repair was
broken.

## What held

- The 10 s watchdog and the burst verifier both engaged on schedule.
- Fail-closed guard behavior (refuse placement when the account snapshot
  is unreadable) worked as designed.
- The owner's kill switch remained available throughout.

## What broke (and is fixed)

1. **Re-arm payload missing QTY** (`rearmCrossTradeBracketREST`). The
   `cancel_and_bracket` POST carried instrument/action/takeProfit/stopLoss
   but no `qty`, and CrossTrade rejects that: live 400 at 03:15:36 today —
   `"Missing required field(s) for cancelandbracket: QTY"`. The preferred
   repair (wrap the naked position in a fresh bracket) therefore always
   failed; only the account-wide flatten fallback remained. Fix: the
   payload now carries QTY sized from the LIVE position
   (`readMnqQtyREST`), via the pure `buildReArmBracketPayload` builder.
2. **Slippage classifier read stale fills.** The fills stream is not
   account-scoped and carries multi-day history; after the 2026-10-11
   account switch, "last fill ever" compared today's flat transition
   (tape ~30885) against Friday's 31185.25 fill → phantom
   `275.6 / 308.3 pts slipped` alarms on both manual closes. Fix:
   `pickExitFill` windows the exit fill to 15 minutes.
3. **Silent flat-abort.** When the repair found the book already flat
   (fast OCO or the owner's close), it returned without a trace — the
   10:28 repair left no exec_log row after `stop_missing`. Fix: the abort
   now logs `repair_aborted_flat`.

Unit tests added for all three (`web/tests/crossTrade.test.ts`,
`web/tests/execWatch.test.ts`); full suite 923 tests / 916 pass / 0 fail;
tsc clean. Deployed in the 16:00–18:00 ET halt window.

## Open

- The fills endpoint's cross-account mixing (pre-10-11 account rows) still
  feeds the ledger reconciliation — the window fix removes it from the
  alarm path, but a session filter in `lib/ctAccount.ts` would harden the
  fill-matching used by the re-send verifier too.
- The residual race (limit placed below the stop, tape rallies through
  before the fill) remains possible by design; the guarantee is
  detect→re-arm→flatten within seconds, which this fix restores.
