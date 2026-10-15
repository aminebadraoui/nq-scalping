# Incident runbook — the five failure modes that have actually happened

> Every scenario below occurred live (dates cited). Diagnosis-first, then
> action; never change a knob mid-diagnosis. Health source of truth:
> `https://nq-dashboard.31.97.138.30.sslip.io/api/gc?action=health`.

## 0. First, in every incident

```bash
curl -s https://nq-dashboard.31.97.138.30.sslip.io/api/gc?action=health
```
Read: `execution.protections.status` (trading or halted) ·
`liveFeed.connected` / `lastTradeAgeSec` / `lastCandleRefreshAt` /
`barSource` / `tapeGate.{hold,veto}` · `liveFeed.heal.episodes` ·
`account` (equity/realized).

## 1. "No signals for N hours" (2026-10-15 — the clock-mix morning)

**Signature:** healthy feed (candles advancing, trades fresh) + zero
signals + `tapeGate.veto: true` while `lastCandleRefreshAt` is fresh.

1. Confirm the signature: `tapeGate.veto === true` AND the last candle is
   < 5 min old → the gate math disagrees with the feed → **internal bug,
   not the market**. (The system now self-pages `INTERNAL INCONSISTENCY`
   for exactly this.)
2. If `veto:false` and the feed is healthy → the detectors genuinely found
   no setups (check the market — a one-way trend can go hours without a
   RTH/momentum setup; 10-13's first card was 10:16, and the 19:00–01:45
   gap was 6.5 h).
3. Kill-switch while debugging if anything looks wrong: dashboard halt.

## 2. TICK-BAR FIRE notices (2026-10-15)

**Meaning:** the vendor's candle confirmation lagged past
`TAPE_GATE_TICK_FIRE_MS` (5 min) and cards released on tick-built bars.

1. Check `barSource` — many tick bars = the vendor candle channel is
   stalling (see scenario 3). Few tick bars = normal slow confirms.
2. The notice only pages at stall-grade lag (10 min); repeated notices =
   a real stall, treat as scenario 3.

## 3. VENDOR DATA FROZEN page / overnight candle stalls (10-05/06, 10-14, 10-15)

**Signature:** `lastCandleRefreshAt` stops advancing while the market is
open, `barSource` tick-share grows, `heal.episodes` climbs; the frozen
watchdog pages `VENDOR DATA FROZEN`.

1. The self-heal ladder is already force-fetching → reconnecting →
   reseeding. Don't fight it; watch `heal` in health.
2. Restart the container (fresh websockets + reseed): `docker restart
   <container>` on the VPS — if the vendor recovers on reconnect, bars
   resume within ~2 min.
3. If the vendor's own chart is ALSO frozen → vendor incident, nothing we
   can do; notify their support. If their chart is current but ours isn't
   → probe the FOOTPRINT/V2 channel (session/date keys) — that was the
   10-15 diagnostic path.
4. No money risk: everything is fail-closed. Signals wait; trades don't
   happen on bad data.

## 4. crossGuard "account snapshot unreadable — halting" / unknown_account (10-11, 10-12, 10-14, 10-15)

**Signature:** cards fail at placement with `guard: crossGuard: account
snapshot unreadable — halting`; protections show `HALTED · no-data`;
`/api/account` returns `account: null`.

1. Confirm from the VPS: the snapshot endpoint returns 200 but
   `accounts: []`, or 400 `unknown_account` → the CrossTrade key sees no
   account (account removed/rotated by the prop firm, or a vendor
   outage).
2. If the account still exists in CrossTrade: re-link the key or issue a
   new one → update the VPS override file (`/app/data/exec-overrides.json`)
   + Coolify env → **guard-state reset** (state file + Neon `guard_state`
   row) → restart. (This is the 10-14 account-switch procedure.)
3. The guard fails closed by design — nothing trades while the snapshot is
   unreadable. That's correct behavior, not the bug.

## 5. Protection stops/flattens on entry (stop_missing / repair_aborted_flat)

**Signature:** `protect` log lines right after a fill
(`stop leg Canceled … already flat`, `flattened`).

1. These are usually the AFTERMATH of a fast-OCO exit (the trade already
   closed before the 30s watchdog polled) — check the fill timestamps
   before acting.
2. If the bracket genuinely lost its stop with a position open, the
   watchdog re-arms and flattens by design — verify the position is flat.
3. Recurrence pattern → the entry mechanics studies (RTH:
   rth-limit-fill-drift; momentum: momentum-entry-mechanics) and the
   gateX2/flushLimit proposals.

## Deploy discipline (every push auto-deploys the VPS executor)

- Deploy window: the 16:00–18:00 ET halt, or weekends. Mid-window deploys
  only with the operator present and the book flat.
- After every deploy: `scripts/live-smoke.ts --expect-build <sha>` (CI
  does this automatically) — the deploy isn't done until it prints PASS.
- If a live change slips out anyway: revert first (env or a revert
  commit), explain after (EXEC_CHANGE_POLICY rule 6).
