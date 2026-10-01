# Deploy state (last verified 2026-09-30)

## Live resources

| Resource | Value |
|---|---|
| Dashboard | **https://nq-dashboard.31.97.138.30.sslip.io** (Let's Encrypt TLS, force-HTTPS) |
| Coolify project | `scalping` → uuid `9d49tnuvlot2wcj9fl7nqyjc`, env `production` |
| Coolify app | `nq-dashboard` → uuid `vwtqdqezxw3lpmpzq76drgb1` (dockerfile build pack, base `/web`, port 3000, health check `/` on 3000, no volumes) |
| GitHub repo | `git@github.com:aminebadraoui/nq-scalping.git` (private) |
| Neon org | `nq-scalping` → `org-falling-cell-25919411` (free) |
| Neon project | `nq-store` → `summer-poetry-26619129`, region aws-us-east-1, pg 18 |
| Neon branch | `main` → `br-billowing-truth-b8uofwsa` (recreated 2026-09-28 to reset the 5 GB/mo transfer quota) |
| DATABASE_URL | **secret** — `web/.env.local` (gitignored) and Coolify app env (plain var, not "shown once") |
| R2 bucket | `nq-history` (Cloudflare account `437b14872d288fb1221f5492055c0b91`) — full 2.5y history, gzipped objects + `manifest.json` index |
| GC_REMOTE_URL | `https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev` (public r2.dev URL of `nq-history`); set in `web/.env.local` (localhost) and Coolify app env (deployed) |

## Data flow

```
[this Mac] gcdata collectors ──► gcdata/data/*.json   (nightly landing zone + test fixtures)
        │  nightly 17:15 local (Mon–Fri, com.scalping.collect → scripts/nightly.sh)
        │   1. collect  2. ingest → Neon  3. upload → R2 (r2_sync.py)  4. prune local
        ▼
   Neon Postgres (rolling ~21-day window; free tier 512 MB cap)  ◄── live GoCharting feed
        │                                                          (VPS container writes live
        │                                                           candles + ticks to Neon)
        ▼  readthrough: recent + live days
   [dashboard] /api/gc fallback chain:  Neon → R2 (GC_REMOTE_URL) → local files
        ▲
   R2 nq-history — the 2.5-year archive, served from Cloudflare (localhost + deployed)
```

- **Read-through from Neon: DONE** (dashboard serves historical views from the DB).
- **Live tick capture → Neon: DONE** (`web/lib/liveStore.ts` batches the live
  minutes; verified: candles/ticks max-ts track the current minute).
- **R2 is the sole data source** for history: `/api/gc` falls back Neon → R2
  (local files are a dev/test fallback only), and the lab's session inventory
  comes from the R2 manifest (`usable` flags, computed at upload).
- **Backtest storage (2026-10-01)**: R2 stays the record; `web/lib/archive.ts`
  caches sessions as gzip in `~/.cache/nq-archive` (`MOM_CACHE_DIR` overrides),
  sha256-verified when `MOM_VERIFY_SHA=1`; `momentumStudy --warm` prefetches
  the whole store in parallel, `--offline` lists sessions from the manifest
  (DB-free). 10 years ≈ 540 MB gzipped — sweeps after warm are disk-only.
- **Vendor retention ceiling (re-verified 2026-10-01)**: GoCharting serves a
  rolling window of the last ~11 quarterly contracts (~2.75y, currently from
  2023-12-18, NQH24 tenure). Contract-aware backfill: `gcdata/contracts.py`
  (generated calendar) + `gcdata/backfill_tenures.py --only-gaps` (heals
  sparse sessions only); `scripts/backfill_contracts.sh` delegates to it.
  Deeper history needs CME DataMine / Databento — the R2+gz-cache flow is
  source-agnostic.
- **The theory lab is LOCAL-ONLY**: the VPS runs `LAB_ENABLED=false` (no
  warm-up, `/api/lab` 404s); lab + backtesting happen on the Mac against the
  R2 archive. The lab sample set is cached to disk keyed by the session
  inventory, so re-opens are instant after the first build.
- Row counts 2026-09-30: candles_1m 25,394 · footprint_ticks 987,524 ·
  events 9,098 · profile_sheets 77 · sessions 26.

## Trade execution (2026-10-01)

- **CrossTrade webhook backend**: `web/lib/crossTrade.ts` places bracketed market
  orders on the MFF Tradovate account (eval, `MFFUEVREOD706880006`) via the
  CrossTrade cloud webhook — no Tradovate API key, no browser, no VPS. Wired
  inside `placeOrder()` (lib/executor.ts): when `CROSSTRADE_*` is set it takes
  priority over the Playwright path, which remains the fallback.
- **The VPS is the single live executor**: `EXECUTE_LIVE=1` lives ONLY in the
  Coolify app env. Local `web/.env.local` keeps `EXECUTE_LIVE=0` so the Mac
  never double-executes. Coolify env: `CROSSTRADE_URL`, `CROSSTRADE_KEY`,
  `CROSSTRADE_ACCOUNT`, `EXECUTE_LIVE=1` (plain vars, not shown-once).
- Feed defaults trade momentum + RTH + open-drive at normal sizing
  (`FIXED_CONTRACTS` unset, `$170` risk budget, 30-micro cap). The sweep-reclaim
  and pullback cards remain off (`FEED_*` defaults in lib/signalFeed.ts).
- Orders carry exchange-side brackets (stop/target computed by CrossTrade from
  the live quote), `require_market_position=flat`, and CrossTrade flags them
  `isAutomated` for Tradovate compliance. No auto-retry on network timeout —
  verify Alert History instead (exactly-once is not guaranteed).
- Account-guard parity is NOT yet wired for the CrossTrade path (the MFF floor/
  consistency guard reads the browser page). Sizing embeds the loss math
  (10×$170 < $2,000 MLL), but the guard is a known follow-up.

## Auto-deploy

**Coolify's native GitHub webhook** (no Actions workflow — the API-key workflow
was deleted in `7157520` "ci: deploy via Coolify's native GitHub webhook").
Verified: repo hook `…:8000/webhooks/source/github/events/manual` active, read-only
deploy key `164629302` ("Coolify nq-scalping"). Every push to `main` deploys.

Manual redeploy:
```bash
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://31.97.138.30:8000/api/v1/deploy?uuid=vwtqdqezxw3lpmpzq76drgb1&force=true"
```

## Operate

```bash
# nightly collection + ingestion (launchd, 17:15 local Mon–Fri):
#   com.scalping.collect → scripts/nightly.sh  (collect + ingest in one job)
#   (com.scalping.ingest and com.scalping.tickverify were removed — dead)

# manual:
cd web && DATABASE_URL=$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-) \
  node --import ../scripts/ts-loader.mjs ./db/ingest.ts --all --profiles --events

# data hygiene:
python3 scripts/repair_data.py            # audit the local JSON store
python3 scripts/repair_data.py --repair   # trim merged holiday files, drop partial OHLC twins
```

## Test suite

`npm test` — offline, ~90 tests. One network test (`parity.test.mjs`, python-vs-TS
level sheets) is opt-in: `PARITY_NET=1 npm test`. OHLC-twin assertions only cover
dates that have a vendor OHLC twin (recent `collect_ohlc` window).

## Lessons (do not regress)

1. **"shown once" env vars** — PATCHing `DATABASE_URL` as `is_shown_once` left the
   container without the variable after redeploys. Keep it a PLAIN env var.
2. **`/api/gc?action=health`** reports what the running container sees (`buildId`,
   `hasDbUrl`, `sessions`) — always check it first.
3. **Vendor quirk: holiday weeks return MERGED multi-day payloads** (~2520-minute
   ETH files, e.g. 2026-09-08). `scripts/repair_data.py --repair` trims them to the
   canonical 1380-minute window when it is intact; otherwise they stay partial and
   excluded from analysis. Completeness = `_meta.kind`, not candle count.
4. **OHLC twins collected mid-session are junk** (<390 bars, disagree with
   footprint). Repair deletes them; only closed-session twins are trusted.
5. **launchd schedule must be local-time-correct**: the collect plist was written
   for Pacific (14:15 PT) on an Eastern Mac → it fired mid-session and skipped
   for days. It now runs 17:15 local (Eastern = New York, DST moves together).
6. **Cognito lockout** (2026-09-27): exponential reconnect backoff in `lib/live.ts`
   (10s → 120s, auth failures 60s → 300s) — do not remove.
7. **`l_sz` is the print-size field** in the live feed — without it every tick is
   sized 1 contract and live volume/delta are wrong.

## Credentials policy (unchanged)

- Nothing secret is committed: Coolify/Neon tokens live in the gitignored skill
  `.agents/skills/coolify-deploy/SKILL.md`; `DATABASE_URL` in `web/.env.local`;
  GoCharting + Telegram creds in `gcdata/.env`.
- If anything secret ever lands in git again: rotate AND rewrite history.
