# Flatten arm — instant flatten on the daily target / daily loss (2026-10-12)

**Status:** SHIPPED as code, **OFF by default** (`FLATTEN_AT_PROFIT` /
`FLATTEN_AT_LOSS` unset = no-op; every fire path honors the `EXECUTE_LIVE`
dry-run gate). No Coolify env has been changed and none may be without the
rule-4 approval.

---

## 1. What it is

The day-plan halts (daily loss floor, profit arm) stop NEW entries but let
the open position run to its bracket — so the realized worst day overshoots
the floor by one trade's loss (measured 2026-10-12: −$339 at a −$250 floor,
$489 best day at a +$400 arm). The flatten arm adds the closing side: once
the day's **live P&L (realized + open)** crosses `FLATTEN_AT_PROFIT` or
−`FLATTEN_AT_LOSS`, the linked account is **flattened at market** —
cancel-all-orders + `FLATTEN` through the CrossTrade webhook (or the REST
flatten per `FLATTEN_MODE`), verified flat after `FLATTEN_VERIFY_S`, one
REST retry, then the manual-flatten Telegram alert.

Division of labor (cycle-free static imports):

| Layer | File | Role |
|---|---|---|
| pure decision + payload builders | `web/lib/flattenArm.ts` | `flattenArmStep` (thresholds + once-per-day latch), `buildFlattenWebhookPayload`, `buildCancelAllWebhookPayload` |
| config knobs | `web/lib/risk/guardCore.ts` | `FLATTEN_AT_PROFIT` / `FLATTEN_AT_LOSS` (default 0 = off) |
| guard verdict | `web/lib/accountGuard.ts` | `"flatten"` verdict, persisted `flattenFiredDay` latch, live P&L = realized + `snap.openPnl` |
| I/O | `web/lib/crossTrade.ts` | `flattenViaWebhook`, `flattenArmFire` (mode/verify/retry/escalate) |
| trigger | `web/lib/crossGuard.ts` | snapshot now carries `openPnl`; the 25s poll + the entry gate call `actOnGuardDecision` (dynamic import — crossTrade imports crossGuard, so the reverse edge stays lazy) |

## 2. Env knobs (all default OFF)

| Key | Default | Meaning |
|---|---|---|
| `FLATTEN_AT_PROFIT` | unset (0) | flatten once live day P&L ≥ this (recommended: leave unset — keep the profit arm's one-more-trade) |
| `FLATTEN_AT_LOSS` | unset (0) | flatten once live day P&L ≤ −this (recommended: **250**) |
| `FLATTEN_MODE` | `webhook` | `webhook` (cancel-all + FLATTEN) · `rest` (REST flatten) · `both` |
| `FLATTEN_VERIFY_S` | 5 | seconds to wait before verifying the account is flat |

## 3. Evidence

- **Guards baseline (policy rule 1):** `scripts/riskStackStudy.ts --offline`
  — full live stack over 654 sessions: worst day −$1,128, maxDD $2,738 =
  137% of MLL on the all-family ladder stream. The floor/arm halts exist
  precisely because the loss tail is deep; the flatten arm converts those
  halts into closes on the day they fire.
- **Sizing context:** `scripts/sizeDownStudy.ts --floor-sweep` (2026-10-12):
  at the recommended $100/cap-8 profile the −$250 floor fires ~8 days/641
  and the worst day is −$339 (floor + one trade's overshoot); flattening at
  the crossing locks ≈ −$250 − slippage. The profit side locks ≈ +$400
  instead of drifting to +$489.
- **Expected live deltas (backtest numbers unchanged):** worst day −$339 →
  ≈ −$250 − ~0.5pt slippage; best day $489 → ≈ +$400. One extra market
  exit per trigger day; the skipped trade is the intraday recovery after a
  floor dip (the recovery-blocking cost already quantified in the floor
  sweep).

## 4. Behavior guarantees

- Off by default; `EXECUTE_LIVE` dry-run gate; protective exit fires even
  when the trading kill switch is on (the switch stops ENTRIES, never
  protective exits).
- Once-per-day latch persisted in the guard state — a redeploy mid-day
  cannot flatten a second time; a new trading day re-arms.
- Fail-closed verify: unreadable positions = NOT flat → retry once via
  REST → 🚨 manual-flatten Telegram alert. No silent "assumed flat".
- The guard's other rules are untouched when the knobs are unset — the old
  halt behavior is byte-for-byte preserved (pinned by the new off-by-default
  test).

## 5. Tests

`web/tests/flattenArm.test.ts` (decision, latch, re-arm, payload shape),
`accountGuard.test.ts` (+3: loss side, profit side, off-by-default),
`crossTrade.test.ts` (+2 dry-run paths), `guardReplay.test.ts` (config
shape). Full suite: 948 tests · 941 pass · 0 fail · `tsc --noEmit` clean.

## 6. Rollout (needs rule-4 approval for every env value)

1. Code ships inert (this commit). Journal shows `flatten_dry` lines when
   the arm would fire (poll verdicts log `[guard] poll: flatten — …`).
2. Demo/sim day first, then live: `FLATTEN_AT_LOSS=250` only (keep
   `FLATTEN_AT_PROFIT` unset — the profit arm's one-more-trade stays).
3. Deploy in the clean window (§3b: 16:00–18:00 ET or weekend), operator
   at the dashboard, book verified flat.
4. Rollback: unset the knob + redeploy in the same window — the code is
   additive and inert without env.

## 7. Follow-ups (declared, not silently dropped)

- WS `streamPnl` frames already arrive on `wss://app.crosstrade.io/ws/stream`
  (enabled as a liveness heartbeat) — parsing them for sub-second triggers
  needs one captured live frame's shape; the 25s poll + fill pushes are the
  trigger until then.
- The FLATTEN_* keys are not yet in `daybook` `SETTINGS_KEYS` (the file has
  uncommitted owner WIP; add them after it lands).
