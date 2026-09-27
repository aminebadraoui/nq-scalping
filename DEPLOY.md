# Deploy: Coolify + Neon

Two moving parts:

1. **Neon Postgres** — the historical store (candles, per-tick footprint,
   profile sheets, events). Filled from this Mac by `web/db/ingest.ts`.
2. **Coolify** — runs the dashboard (Docker image of `web/`).

```
[this Mac] collect (gcdata) ──► gcdata/data/*.json
                                   │
                                   ▼  web/db/ingest.ts (nightly, launchd)
                              Neon Postgres ◄──── future backtest engine
                                   │
                                   ▼  DATABASE_URL
[Coolify VPS] dashboard container ──► serves / (live dashboard)
```

## Neon (org is console-only, project/db via API)

> Creating an **organization** has no API/CLI endpoint — do it once in the
> Neon console (console.neon.tech → New organization), or reuse an existing
> org. Everything below works with an org or account API key.

```bash
export NEON_API_KEY=napi_…
# or with neonctl
neonctl projects create --name nq-store --org-id org-… --region-id aws-us-east-1 --pg-version 17
# (auto-creates branch `main`, database `neondb`, role `neondb_owner`)
neonctl connection-string --project-id <id> --database-name neondb --role-name neondb_owner
```

Raw API alternative: `POST https://console.neon.tech/api/v2/projects`
`{"project":{"name":"nq-store","org_id":"…","region_id":"aws-us-east-1","pg_version":17}}`
(create database via `POST /projects/{id}/branches/{branch}/databases`).

Store the **unpooled** URL as `DATABASE_URL` in `web/.env.local` (gitignored);
the pooled (`-pooler`) host is for the live dashboard, direct is for ingestion.

## Backfill + nightly ingestion

```bash
cd web
node --import ../scripts/ts-loader.mjs ./db/ingest.ts --all --profiles --events   # one-off backfill
node --import ../scripts/ts-loader.mjs ./db/ingest.ts --verify                    # integrity check
```

The ingester applies `db/schema.sql` automatically on first run (idempotent
upserts throughout). Schedule it after collection via launchd
(`com.scalping.ingest`), e.g. 18:15 ET on weekdays.

## Coolify (deploy the dashboard)

- Prerequisites (dashboard-only, can't be scripted): a running Coolify
  instance with a registered Server, and an API token with `write` + `deploy`
  permissions (Keys & Tokens → API tokens).
- Push this repo to GitHub (it has no remote yet), then:

```bash
export CF=https://your-coolify.example.com CF_TOKEN=…
curl -H "Authorization: Bearer $CF_TOKEN" $CF/api/v1/servers          # → server_uuid
curl -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json"   $CF/api/v1/projects -d '{"name":"scalping"}'                        # → project_uuid
curl -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json"   $CF/api/v1/projects/<project_uuid>/environments -d '{"name":"production"}'
curl -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json"   $CF/api/v1/applications/public -d '{
    "project_uuid":"<project_uuid>","server_uuid":"<server_uuid>","environment_name":"production",
    "git_repository":"https://github.com/<you>/Scalping.git","git_branch":"main",
    "build_pack":"dockerfile","base_directory":"web","name":"nq-dashboard",
    "ports_exposes":"3000","health_check_port":"3000","health_check_enabled":true,
    "instant_deploy":true,"domains":"<your-domain or leave empty for IP:port>"
  }'
# env vars (bulk), then deploy
curl -X PATCH -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json"   $CF/api/v1/applications/<app_uuid>/envs/bulk   -d '{"data":[{"key":"DATABASE_URL","value":"…","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false}]}'
curl -X POST -H "Authorization: Bearer $CF_TOKEN" "$CF/api/v1/deploy?uuid=<app_uuid>"
```

- Environment:
    - `GOCHARTING_EMAIL`, `GOCHARTING_PASSWORD`, `GOCHARTING_COGNITO_CLIENT`,
      `GOCHARTING_DC`, `GOCHARTING_SYMBOL`, `GOCHARTING_EXCHANGE`, `GOCHARTING_SEGMENT`
    - `DATABASE_URL` (unpooled Neon URL)
    - `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (optional, alerts)
    - `GC_DATA_DIR=/app/data` if you mount historical data
  - Persistent storage (optional): mount a host dir with `gcdata/data` at
    `/app/data` so the historical views work on the server too.

## Next step: read-through

Once Neon holds the store, the dashboard's `/api/gc` can read from it when
`DATABASE_URL` is set (falling back to files), and the backtest engine can
query `candles_1m` + `footprint_ticks` directly — the schema is written for
that: absolute `ts`, date/session partition keys, raw clusters preserved.
