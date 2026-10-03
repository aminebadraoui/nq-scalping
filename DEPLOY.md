# Deploy: Coolify + Neon + R2

Three moving parts:

1. **Neon Postgres** — historical store (candles, footprint ticks, profiles,
   events) plus the live tables (signals, trades, trade_analysis, insights,
   strategy_overrides, guard_state).
2. **Coolify VPS** — runs the dashboard container (Docker image of `web/`).
3. **Cloudflare R2** — the 2.5-year session archive (NQ + ES), the dashboard's
   history source.

**Full live state (UUIDs, env vars, data flow, hardening history, lessons):
see `deploy/STATE.md`** — that file is the canonical ops record and is updated
as the system changes.

## Live resources

| Resource | Value |
|---|---|
| Coolify | `http://31.97.138.30:8000` (v4.3.23) · app `nq-dashboard` → uuid `vwtqdqezxw3lpmpzq76drgb1` |
| Dashboard | `https://nq-dashboard.31.97.138.30.sslip.io` (Let's Encrypt, force-HTTPS) |
| Neon | org `nq-scalping` → project `nq-store` (`summer-poetry-26619129`), aws-us-east-1, Postgres 18 |
| R2 | bucket `nq-history` → public `https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev` |

## Deploying

- Build: `web/Dockerfile` (node:22-alpine, Next standalone output, port 3000).
- Coolify app: base directory `/web`, Dockerfile build pack, health check
  `GET /` on port 3000, no volumes.
- **Auto-deploy on every push to `main`** (Coolify native GitHub webhook).
- Manual redeploy:

```bash
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://31.97.138.30:8000/api/v1/deploy?uuid=vwtqdqezxw3lpmpzq76drgb1&force=true"
```

## Env vars (Coolify app env)

`DATABASE_URL` · `GC_REMOTE_URL` · `GOCHARTING_EMAIL/PASSWORD/COGNITO_CLIENT/DC/
SYMBOL/EXCHANGE/SEGMENT` · `TELEGRAM_BOT_TOKEN` · `TELEGRAM_CHAT_ID` ·
`LAB_ENABLED=false` · `LIVE_WRITE` · `CROSSTRADE_URL/KEY/ACCOUNT` ·
`EXECUTE_LIVE=1`.

The Mac's `web/.env.local` keeps `EXECUTE_LIVE=0` — **the VPS is the single
live executor**, so local runs never double-execute.

## Local data pipeline (this Mac)

- `launchd com.scalping.collect` → `scripts/nightly.sh`, **Mon–Fri 17:45 US
  Eastern** (~45 min after the 16:59 close): collect from GoCharting → ingest
  Neon → reconcile trades → analyze → mine insights → upload/prune R2 → ES
  archive → Friday risk-stack backtest.
- `launchd com.scalping.domprobe` → weekly DOM_V2 sample, Sundays 18:05 ET.

## Credentials policy (do not regress this)

- **Nothing secret is ever committed.** Secrets live in: the gitignored skill
  `.agents/skills/coolify-deploy/` (Coolify token, Neon API key), Coolify app
  env vars, `web/.env.local` (DATABASE_URL, CrossTrade, LLM), and `gcdata/.env`
  (GoCharting, R2). `.gitignore` covers all of them plus collected data, venv,
  and caches.
- If anything secret ever lands in git again: rotate the credential AND rewrite
  the history (a force-push alone is not enough — GitHub keeps dangling objects).
