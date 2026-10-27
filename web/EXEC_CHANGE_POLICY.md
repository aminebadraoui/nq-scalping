# Execution-change policy — read before touching live-execution code

> Every push to `main` auto-deploys the VPS executor (`EXECUTE_LIVE=1`).
> Treat every push as a live change. This policy is the contract for
> anything that can change how real orders are placed, sized, gated, or
> exited.

## 1. What counts as LIVE-EXEC

- Code: `web/lib/{crossTrade,executor,execWatch,execLog,crossGuard,
  accountGuard,propRules,propAccount,profile,timeExit,runner,
  runnerTracker,newsGate,openDrive,momentum,softMomentum,
  signalFeed,unusualVolume}.ts` (and anything they newly import), plus
  (2026-10-26) `ctAccount.ts` (broker pacing + the guard's account
  snapshot), `execOverrides.ts` (credential switch + guard reset),
  `tradingHalt.ts` (the kill switch), `risk/guardCore.ts` +
  `risk/challengeRules.ts` (the guard's rule core) and the live
  detectors `bigBar.ts` + `vwapUp.ts`. The authoritative list is
  `PROTECTED` in `scripts/exec-gate.sh`.
- Config on the VPS: any Coolify env var of `nq-dashboard`
  (feed toggles `FEED_*`, profile knobs `*_STOP_MULT`/`*_TARGET_R`,
  risk caps, `EXECUTE_LIVE`, `AUTO_RETRY_VERIFIED`,
  `CROSSTRADE_LIMIT_ENTRIES`, …) — env changes are NOT in git, so only
  this policy guards them.
- Detector PROD configs in the detectors above.

## 2. The rules (hard)

1. **Backtest before push.** A LIVE-EXEC change needs an offline
   study/backtest run against the 649-session archive BEFORE the commit
   exists, using the study that matches the area:
   - retrace entries / fill model → `scripts/retraceSlippageStudy.ts`
   - RTH family config → `scripts/rthOptimizer.ts` (full campaign:
     train grid + constrained selection + OOS + account sim)
   - momentum/expansion config → `scripts/sizingOptimizer.ts` +
     `scripts/entryQualityStudy.ts`
   - open family / full stack / guards → `scripts/riskStackStudy.ts`
   - pure bugfixes with no behavior change (e.g. a latch off-by-one) →
     full `npm test` + `npx tsc --noEmit` + explain the fix in the
     commit body; if the fix changes outcomes, the matching study is
     still required.
2. **Tag the commit.** The commit message must contain
   `[backtested: <script> <flags>]` — enforced by the pre-push hook and
   the CI gate. `<script>` must be the study's path under `scripts/`,
   `web/scripts/` or `gcdata/` (`.ts`/`.mjs`/`.py`/`.sh`); a tag without a
   path does not pass. Example:
   `[backtested: scripts/rthOptimizer.ts --offline]`.
3. **Tests + types must pass.** `npm test` and `npx tsc --noEmit`
   (the hook and CI run them for you on LIVE-EXEC pushes).
4. **Coolify env changes: NEVER without explicit user approval.**
   Show the study results first, propose the exact key/value, and wait
   for a yes. This includes feed toggles and profile knobs. (The
   2026-10-05 `RTH_STOP_MULT` incident: an unapproved env change from a
   pts-only scratch sweep — reverted the same day. Do not repeat.)
5. **Sweeps are not validations.** A points-only sweep (any scratch
   `web/scripts/*.ts` without account sim + sizing + drawdown bounds)
   is research input, not a backtest. The gate in rule 2 must cite one
   of the named studies.
6. **If a live change slips out anyway:** revert first (env or push a
   revert commit), explain after. Never leave an unapproved knob live.

## 3. Mechanics (how it's enforced)

- `scripts/git-hooks/pre-push` — blocks a push when LIVE-EXEC files
  change and the range has no `[backtested:` tag, or when tests/types
  fail. Install: `bash scripts/install-hooks.sh`.
  Escape hatch (explicit, deliberate): `ALLOW_UNVALIDATED_EXEC=1`.
- `.github/workflows/validate.yml` — CI re-runs tests, types, and the
  same gate on every push to `main` (post-hoc alarm today; becomes a
  hard blocker if `main` is ever protected with required checks).
- `scripts/exec-gate.sh <base> <head>` — the shared gate logic used by
  both the hook and CI.

## 3b. Deploy window (2026-10-12)

Every push to `main` redeploys the executor. A redeploy restarts the
Node process and resets IN-MEMORY execution state: pending fill
expectations, registered time exits, the 60s flat-entry latch, the
sent-dedupe sets, the event-tick monotonic state — and the live buffer
re-seeds, so no card can fire for several minutes. The backtest has no
such gaps.

- **Deploy outside the signal window by default**: during the daily
  16:00–18:00 ET halt (the cleanest slot — window closed, sessions
  reset) or on weekends. A mid-RTH deploy is an execution-knob change
  in everything but name: only when necessary, with the operator at the
  dashboard, and with the book verified flat first.
- A redeploy does NOT reset the guard floor/day counters (Neon
  `guard_state` + the state file restore them) or the kill switch
  (`trading-halt.json` survives).
- Env changes need a redeploy to take effect (Coolify re-bakes the env
  into the container) — the same window discipline applies to them.

## 4. Scratch studies

`web/scripts/*.ts` files marked SCRATCH (e.g. `openStrategyLab.ts`,
`stopMultCalibration.ts`, `scanPlanSweep.ts`, `challengeTiming.ts`,
`sessionPostmortem.ts`) are research, not validation, and stay
uncommitted unless explicitly promoted with a docs note.
