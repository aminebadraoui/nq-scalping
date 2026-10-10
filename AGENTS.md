# Repo-level agent instructions

- **Every push to `main` auto-deploys the VPS executor (EXECUTE_LIVE=1).
  Treat pushes as live changes.**
- Before touching any live-execution code or any Coolify env of
  `nq-dashboard`: read and follow `web/EXEC_CHANGE_POLICY.md`
  (backtest → tag → tests → approval for env changes).
- Never change Coolify env vars, feed toggles, or profile knobs without
  explicit user approval, even when a backtest suggests it.
- Pts-only scratch sweeps are research input, not validations.
- Every study report follows `docs/BACKTEST-REPORT-STANDARD.md`: the fixed
  skeleton, the T0/T1/T2/T3/T4 tables with their exact column orders (T1
  core quality table always first in Results, then T4 prop-account
  viability — eval/funded rows with the pass-before-breach question), the
  threshold bands, and the five-slot VERDICT line including `viability`.
  No ad-hoc result tables.
- Revert an accidental live change immediately, then explain.
- Keep the user's uncommitted WIP out of commits (surgical commits:
  stage only the intended files/hunks).
- Conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `revert:`).
- Secrets never enter git (see README.md conventions).
