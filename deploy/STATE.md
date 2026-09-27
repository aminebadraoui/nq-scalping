# Deploy state (2026-09-27)

## Live resources

| Resource | Value |
|---|---|
| Dashboard | **https://nq-dashboard.31.97.138.30.sslip.io** (Let's Encrypt TLS, force-HTTPS) |
| Coolify project | `scalping` → uuid `9d49tnuvlot2wcj9fl7nqyjc`, env `production` → `ncllllz139rudqio3lmwbkzw` |
| Coolify app | `nq-dashboard` → uuid `vwtqdqezxw3lpmpzq76drgb1` (dockerfile build pack, base `/web`, port 3000, volume `/app/data`) |
| Coolify deploy key | `ncuaupdairh9oiahtidl89h0` (private key for GitHub nq-scalping, read-only deploy key id 164629302) |
| GitHub repo | `git@github.com:aminebadraoui/nq-scalping.git` (private) |
| Neon org | `nq-scalping` → `org-falling-cell-25919411` (free) |
| Neon project | `nq-store` → `weathered-breeze-08237037`, region aws-us-east-1, pg 18 |
| Neon database | `neondb` (branch `br-delicate-fire-b8n3d6q4`, endpoint `ep-floral-snow-b8etj0yj`) |
| DATABASE_URL | **secret** — `web/.env.local` (gitignored), Coolify app env, Mac launchd plist; the repo copy of the plist keeps a `__DATABASE_URL__` placeholder |

## Data in Neon (verified 2026-09-27)

8,850 candles_1m · 355,699 footprint_ticks · 2,892 events · 29 profile_sheets · 10/10 sessions ✓

## Auto-deploy

**Every push to `main` triggers a deploy** — `.github/workflows/deploy.yml` calls
`POST /api/v1/deploy?uuid=vwtqdqezxw3lpmpzq76drgb1&force=true` with the
`COOLIFY_BASE_URL` / `COOLIFY_TOKEN` GitHub secrets. Verified: the workflow ran
on the very push that added it, and the app stayed `running:healthy` throughout.

## Operate

```bash
# nightly ingest (launchd, 18:30 ET weekdays — bootstrap once):
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.scalping.ingest.plist

# manual:
cd web && DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d= -f2) \
  node --import ../scripts/ts-loader.mjs ./db/ingest.ts --all --profiles --events

# redeploy after a push:
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://31.97.138.30:8000/api/v1/deploy?uuid=vwtqdqezxw3lpmpzq76drgb1&force=true"
```

## Live verification — Sunday 2026-09-27 18:00 ET open

- Ticks flow: session `OVERNIGHT` / `2026-09-28`, real prints with `l_sz`
  sizes and string `side` fields; snapshot delta via `derived_values.delta`.
- **Seamless blend confirmed in production**: chart `1380 collected + live
  bars · 18:00 → 19:21 New York`, ladder's last bar is the live minute,
  checklist "as of 19:21 New York · live bars", zero console errors.
- **Cognito lockout incident**: the VPS container retried auth every 5s with a
  mangled password → GoCharting account locked ("Password attempts exceeded").
  Fixes: env re-set with correct plain values, **exponential reconnect backoff**
  (10s → 120s, auth failures 60s → 300s) in `lib/live.ts`, and `verify_ticks.py`
  now loads `gcdata/.env` (launchd runs with a minimal environment).
- **`l_sz` is the print-size field** — added to `lib/live.ts` (before the fix
  every live tick was sized 1 contract, corrupting live volume/delta).

## Deploy lessons (2026-09-27)

1. **"shown once" env vars** — PATCHing `DATABASE_URL` as `is_shown_once` again
   left the container without the variable after redeploys. Fix: store it as a
   PLAIN env var (`is_shown_once: false`) — the value is visible in the Coolify
   env list but injection works.
2. **`/api/gc?action=health`** reports what the running container sees
   (`buildId`, `hasDbUrl`, `sessions` row count) — always check it first.
3. **`listDatasets` needed the DB branch** too — the initial read-through patch
   missed it and the deployed app fell back to an empty file dir (0 datasets →
   the dashboard requested today's date → 404s + an empty-chart crash).

## Next steps

1. **Dashboard read-through from Neon**: when `DATABASE_URL` is set, serve `/api/gc`
   from `candles_1m`/`footprint_ticks` (fallback to files) so the deployed app
   shows the historical views without a data volume.
2. **Live tick capture → Neon**: batch-insert the live minutes into the DB.
3. **Backtest engine**: query the store directly — schema is written for it.
