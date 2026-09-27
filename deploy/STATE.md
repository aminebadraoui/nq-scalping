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

## Next steps

1. **Dashboard read-through from Neon**: when `DATABASE_URL` is set, serve `/api/gc`
   from `candles_1m`/`footprint_ticks` (fallback to files) so the deployed app
   shows the historical views without a data volume.
2. **Live tick capture → Neon**: batch-insert the live minutes into the DB.
3. **Backtest engine**: query the store directly — schema is written for it.
