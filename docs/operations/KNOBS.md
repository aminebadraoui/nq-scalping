# Execution knobs — the kill-switch table (every live knob, one glance)

> The operator's control plane. Every knob below changes LIVE behavior.
> Changing any Coolify env var of `nq-dashboard` requires the owner's
> explicit approval (web/EXEC_CHANGE_POLICY.md rule 4) and a redeploy to
> take effect. The dashboard kill switch (`trading-halt.json`) needs no
> redeploy. Last verified: 2026-10-15.

## Instant kill switches (no deploy)

| Switch | Where | Effect |
|---|---|---|
| **Trading kill switch** | Dashboard status bar (halt/resume) | stops ALL entries immediately (protective exits still work). `trading-halt.json` survives redeploys. |
| **EXECUTE_LIVE=0** | Coolify env | dry-run: the whole pipeline runs, nothing is placed. One redeploy away. |

## The 2026-10-15 session's knobs (tape gate / stale veto / fallback)

| Knob | Default | Effect | Disable / restore old behavior |
|---|---|---|---|
| `TAPE_GATE_TICK_FIRE_MS` | `300000` (5 min) | when the unconfirmed tail bar is older than this, cards release on TICK-built bars (labeled TICK-BAR FIRE) instead of holding forever | `0` = the old infinite hold (fail-closed) |
| `STALE_SIGNAL_VETO_MS` (code const) | 10 min | a completed tail older than this can never emit a card (the 02:54-on-22:52 incident) | code const — raise in `lib/signalFeed.ts` |
| `TAPE_GATE_FIRE_NOTICE_MS` (code const) | 10 min | Telegram notice only at stall-grade lag | code const |
| `TAPE_GATE_TAIL_ALERT` (code const) | 8 bars | consecutive unconfirmed tail bars before the gap page | code const |
| `TAPE_GATE_REALERT_MS` (code const) | 30 min | re-page cadence | code const |

## Momentum entry mechanics (the 2026-10-14 studies)

| Knob | Default | Effect |
|---|---|---|
| `CROSSTRADE_LIMIT_ENTRIES` | unset (= limits ON) | Failed-Flush Breakout cards rest a limit AT the signal close (9 min TTL); expansion retrace rests 1 pt behind (5 min). The marketable chase is OFF. | `0` restores the chase (NOT recommended — momentum entry-mechanics study: chase PF 0.64 vs flushLimit 1.27/1.55) |
| `EXP_RETRACE` | unset (= ON) | expansion retrace limit entry | `0` = marketable expansion entry |
| `CROSSTRADE_SCALEOUT` | unset (= OFF) | scale-out pairs keep the market path | `1` = bank+runner ladder |

## Feed / protection

| Knob | Default | Effect |
|---|---|---|
| `FEED_MOMENTUM` / `FEED_RTH` / `FEED_OPEN` / `FEED_OPEN_DRIVE` | ON | family on/off toggles | `0` disables a family |
| `FEED_OPEN_PULLBACK` | ON since 2026-10-16 (was off) | Morning Pullback card (69.8% WR, +5.2 pts/trade, ~4 days in 5) | `0` = off |
| `FEED_BIGBAR` | ON since 2026-10-15 | first ≥100-pt bar continuation (57.0% WR limit arm, PF 1.42) | `0` = off |
| `SIGNAL_EVENT_TICK` | unset (OFF) | event-driven bar-advance tick (zero-latency detection) | `1` = enable |
| `RTH_LIMIT_ENTRIES` | unset (OFF) | Session Continuation resting-limit entries | `1` = enable (validated: rthLimitValidation) |
| `RTH_LIMIT_STOP_MULT` / `RTH_LIMIT_TARGET_R` / `RTH_LIMIT_TTL_MS` | 0.5 / 2.5 / 9 min | RTH limit bracket | with RTH_LIMIT_ENTRIES=1 |
| `RTH_LIMIT_APPROACH_GATE_PTS` | unset (OFF) | Session Continuation crossed-limit approach gate (rthLimitFillDriftStudy gateX2) | `2` = the validated setting |
| `FLATTEN_AT_LOSS` / `FLATTEN_AT_PROFIT` | set (loss arm active) | once-per-day flatten arm | `0` = off |
| `MOM_STOP_MULT` / `MOM_TARGET_R` / `MOM_SIZE_MULT` | profile defaults | momentum bracket/size | profile knobs |
| `KELLY_MODE` / `KELLY_LIVE_USE` | OFF | kelly sizing chip | `1` = on |

## Health / diagnostics

- `/api/gc?action=health` → `liveFeed.tapeGate` = the family checkers'
  exact gate view: a healthy feed must read `veto:false`, and
  `lastCandleRefreshAt` must advance while the market is open.
- `scripts/live-smoke.ts --expect-build <sha>` — the post-deploy PASS
  contract (runs in CI on every push).
- Vendor SLIs to watch: `barSource` (candle vs tick mix), `heal.episodes`
  (stall count), `ratio` (tick-sample volume share).

## What the account guard protects (never touch without the policy path)

`MFF_STAGE` · `MFF_START_BALANCE` · `MFF_MAX_LOSS` · `MFF_PROFIT_TARGET` ·
`MFF_CONSISTENCY_CAP` · `GUARD_GIVEBACK_*` · `DAILY_LOSS_FLOOR` ·
`PROFIT_ARM` · `DD_HALF_AT` / `DD_FULL_AT`.
