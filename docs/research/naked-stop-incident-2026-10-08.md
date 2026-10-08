# 2026-10-08 — two incidents, the protection stack, and the fill-model reckoning

Two separate execution failure classes hit the live RTH family in one
day, each costing ~$1k. This document is the complete record: what
happened, what was built, what the studies now say, and the decisions
left open.

## Incident 1 — naked position (09:48 ET)

The RTH short (7 MNQ, limit 31216.25, stop 31222.75, target 31200.00)
opened with **no stop loss**. The owner caught it and closed manually at
09:52:44 ET @ 31215.50 (+13.75 pts ≈ +$192 gross). Broker evidence
(CrossTrade/Tradovate order lifecycle, ids 688241970704-6):

| Time (ET) | Event |
|---|---|
| 09:49:44.417 | REST limit placed (`muzlfch0-uzi2yu-lmt`); market ≈ 31229.25 — 13 pts above the limit |
| 09:49:44.422 | entry filled instantly @ **31229.25** (a marketable sell limit) — already 6.5 pts past its own stop |
| 09:49:44.427 | **stop leg REJECTED: `InvalidPrice` — "current price is outside the price limits set for this product"** |
| 09:51:28 | watcher logs `limit_filled` — the system believed the trade was protected |
| 09:52:44 | owner closes manually (profit) |

Root causes: (1) ~100 s dispatch lag with no price re-check — the flush
ran the tape 13 pts through the limit, and a marketable limit fills at
the market, not at the limit; (2) the OSO stop is anchored at the SIGNAL
price, so a buy-stop below the market is rejected at placement — and the
entry still fills; (3) nothing verified the bracket legs after placement
(the place response's `oso1Id`/`oso2Id` child ids were discarded).

## Incident 2 — stop slippage (12:17 ET, −$1,027.50)

The RTH short (15 MNQ, limit 31187.375, stop 31190.56 — 3.19 pts, "risk
$96") filled instantly at 31189.75: the limit was marketable, the tape
had moved 2.4 pts through it, and the signal-anchored stop was
**0.81 pts from the actual fill**. The market flushed ~35 pts in 11
seconds; the stop triggered and the stop-market filled at **31224.00 —
134 ticks past the trigger** (15 × 34.25 × $2 = −$1,027.50). The stop
existed and worked; the loss was gap-through slippage on a compressed
stop. Day went +$724 → −$332, recovered to +$882.90 by the owner's
manual 25-lot trade (+$1,262.50 gross) — landing **$17 below the $900
eval consistency cap**.

## The protection architecture (deployed, commits below)

All dry-run-gated by EXECUTE_LIVE, all at the executor choke point —
every order path, current or future, is covered:

1. **Crossed-stop dispatch gate** — refuse a limit whose OSO stop sits on
   the marketable side of the tape (the incident-1 shape).
2. **Crossed-limit dispatch gate** (1-pt threshold) — refuse a limit the
   tape has already moved through (the incident-2 shape). Today's clean
   winners crossed by 0.1 pts; both disasters by 13.0 / 2.4 pts.
3. **BURST verifier** (`verifyBracketsAfterPlace`) — after every
   bracketed placement: one session-orders read at +0.5 s, then every
   1.5 s for up to 20 s (~13 calls/trade), acting on a rejected/cancelled
   stop leg (cancel the resting entry / repair the filled position) and
   running the fill-anchored re-bracket once the entry fills.
4. **Fill-anchored re-bracket** — a drifted fill that compressed the stop
   below 50% of plan re-anchors stop+target to the ACTUAL fill via
   `cancel_and_bracket`.
5. **CrossTrade WebSocket order stream** (`lib/ctStream.ts`,
   `wss://app.crosstrade.io/ws/stream`, origin=tradovate) — pushed
   `orderUpdate` frames make a Rejected stop leg react in **<1 s**, no
   polling. Mid-trade rejections act only when the evidence agrees (no
   working stop covers the tracked position). P&L stream = liveness
   heartbeat; exponential-backoff reconnects under the 5-upgrades/IP/60s
   server limit.
6. **10 s protection watchdog** (`checkProtection`, was 30 s) — while an
   MNQ position is open a working stop must cover it; missing for one
   poll (10 s) → re-arm via `cancel_and_bracket` (stop re-anchored 1 pt
   beyond the tape) or flatten. Untracked (manual) positions are
   alert-only, never touched.
7. **Stop-slippage alarm** (`checkExitSlippage` + `classifyExitFill`) —
   every flat transition compares the exit fill to the intended stop and
   alerts + journals when it lands >2 pts beyond the trigger. This is
   also the live-calibration feed for the fill model (below).
8. **Executor contract cap** (`MAX_MICRO_CONTRACTS`, default 30) — bounds
   slippage × size.
9. **Owner kill switch** (`lib/tradingHalt.ts` + `/api/trading` +
   `TradingToggle`) — a TRADING LIVE/STOP toggle in the dashboard status
   strip. STOP instant, no password; RESUME password-gated when
   ADMIN_PASSWORD is configured. State persists to
   `GC_DATA_DIR/trading-halt.json` and survives redeploys; every flip
   appends a daybook `exec` audit record (`trading_halted` /
   `trading_resumed`).

| Reaction | Before | After |
|---|---|---|
| stop-leg rejection detected | ~4 s | **<1 s** (WS) / **~2 s** (burst) |
| naked repair, worst case | ~30–60 s | **~10–20 s** |
| after the burst window | 30 s poll | 10 s watchdog |

## Study results — RTH s0.5/t2.5 across model generations

| Model | Result |
|---|---|
| Original validation (phantom crossed cards + zero stop slippage) | **+$13.8k PASS** |
| + crossed cards gated (honest execution) | +$9.9k, dd −$2.5k **BREACH** |
| + stop slippage modeled | **−$26.2k BREACH** |
| + slippage **capped at 2/5/10 pts** | −$26.2k — **identical at every cap** |

The slip-cap sweep falsifies the "black swan" explanation: capping the
134-tick tail changes nothing because every slipped fill in the archive
was already within ~2 pts of the stop. The bleed is thousands of routine
1–2 pt slips on stop-outs of a 3-pt stop inside flush tape — death by a
thousand papercuts, not a tail event. Full reckoning:
[docs/research/fill-model-integrity-2026-10-08.md](fill-model-integrity-2026-10-08.md).

## VPS outage (13:35–14:05 ET)

After the ADMIN_PASSWORD env change triggered a redeploy, the whole box
wedged (TCP accepted on 22/80/443/8000, no protocol completed — SSH,
HTTP, Coolify alike: a frozen guest). Recovered ~14:05 on its own; the
halt persisted through the outage and re-applied at boot, and the
deploy finished cleanly (`running:healthy`). Lesson: the kill switch's
persistence design is exactly what made the recovery safe.

## Deploy timeline (all pushed to main, auto-deployed)

- `c4884b0` fix(exec): OSO leg verification + naked-position repair
- `539b011` fix(exec): crossed-limit gate, fill-anchored re-bracket, contract cap, slippage alarm
- `9799e6e` feat(dashboard): trading kill switch (halt/resume + daybook audit)
- `31df712` fix(dashboard): kill-switch UX (password dialog, adaptive field, trimmed compare)
- `eba9813` fix(exec): sub-second protection — burst verifier + CrossTrade WebSocket order stream

## Open decisions (owner)

1. **FEED_RTH** — armed (`=1`) underneath the kill switch. Resuming
   re-arms RTH; the honest-fill studies say its config bleeds. Options:
   off, re-study, or a bounded live calibration experiment (see the
   fill-model doc).
2. **MAX_MICRO_CONTRACTS** — currently 30; 8 turns a 33-pt slip into
   ≈ −$528 instead of −$1,027.
3. **Consistency cap** — the day sits +$882.90 realized vs the $900
   30%-of-target rule; no more profit today.
4. **CrossTrade alert channels** — point their `order_rejected` alerts
   at the owner's Telegram (one-time UI action on their side).
