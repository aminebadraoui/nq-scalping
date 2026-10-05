<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Live-execution policy (repo rule, do not skip)

Every push to `main` auto-deploys the VPS executor (`EXECUTE_LIVE=1`).
Before changing live-execution code (lib/{crossTrade,executor,execWatch,
profile,signalFeed,openDrive,momentum,softMomentum,guard/risk files}) or
ANY Coolify env var of `nq-dashboard` (feed toggles, profile knobs,
risk caps): read and follow `web/EXEC_CHANGE_POLICY.md` — backtest with
the named study first, tag the commit `[backtested: <script>]`, and
never change env without explicit user approval. Enforced by
`scripts/git-hooks/pre-push` (install: `bash scripts/install-hooks.sh`)
and `.github/workflows/validate.yml`.

