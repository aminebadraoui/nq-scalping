# AI Macro Briefing Card — Research & Implementation Plan

> Goal: a card at the **top of the dashboard** where DeepSeek produces an
> analysis of "the situation" from ALL the macro-context data the system
> already collects. Research questions answered here: what data exists,
> how to feed it to the model, when to generate the briefing (scheduling),
> what it costs, and how it deploys.
>
> Researched 2026-10-04. Evidence-first; code paths win over docs where they
> disagree. Companion docs: `DASHBOARD_MACRO_PANELS.md` (the macro layer),
> `deploy/STATE.md` (ops), `web/README.md` (dashboard surfaces).

## 1. Boundary (non-negotiable)

The macro layer is **display-only by construction**: `web/lib/macroFeed.ts` is
imported only by `/api/macro`, and the signal engine never sees it
(`macroFeed.ts:1-5`). The AI card inherits this: its module must be imported
only by the briefing API route and the briefing CLI — never by
`lib/signalFeed.ts`, `lib/signalEngine.ts`, or the executor. The card is
context for the human, and its text must never imply the strategy engine
consumed these values.

## 2. What data exists (field-level inventory)

All types below are live in code. Everything is `null`-heavy: every source
degrades to `null` + an error note instead of failing (`macroWatch.ts:519-529`,
`macroFeed.ts`), so the snapshot builder maps null → `"n/a"` and always reads
the per-source `ok/stale/error` flags.

| Source | Key fields (type path) | Freshness | Upstream |
|---|---|---|---|
| **Treasury curve** | `bonds.data.latest.{m3,y2,y5,y10,y30}` (%) · `bonds.data.asOf` (curve date, lags a session) · `bonds.data.effr.{rate,targetFrom,targetTo}` · derived `spread210`/`spread103m` (bps), `breakeven10y`/`real10y` (%) (`lib/bonds.ts:49-74`) | TTL 1 h; official print ~15:30 ET once/day | home.treasury.gov CSVs, NY Fed EFFR |
| **Intraday curve** | `bonds.intraday.{y2,y10,asOf}` — ~20 min delayed CNBC | TTL 2 min | CNBC restQuote |
| **News calendar** | `news.data.{source,days[]}` · per item `{day(ET),timeET,title,impact,forecast,previous,released}` — `actual` always null on the FF mirror (`newsCalendar.ts:170`) | TTL 10 min | FF mirror → static Fed/BLS (`lib/newsGate.ts`, through 2027-01) |
| **Earnings** | `earnings.data.{provider,upcoming[],reported[]}` · `QuarterRow {symbol,name,nextDate,nextEstimated,nextTime,nextEpsEst}` · `ReportedRow {reportedDate,eps,consensus,surprisePct}` | TTL 6 h | Nasdaq → Finnhub fallback |
| **Cross-asset quotes** | `watch.quotes[] {symbol,value,change,changePct,asOf}` for .VIX .DXY .SPX .NDX .SOX SPY RSP SMH QQQ @GC.1 @CL.1 BTC.CB= US10Y US2Y @FF.1 | TTL 60 s; **~20 min delayed** (BTC price = Coinbase real-time, its Δ stays CNBC's) | CNBC pipe-batch + Coinbase |
| **VIX stats** | `watch.vix.{level,pct1y,rangePct,term9d,term3m,at}` — `rangePct = VIX/16` daily 1σ % | TTL 6 h; daily closes | CBOE history CSVs |
| **GEX** | `watch.gex.{regime,spot,flip,callWall,putWall,pin,netGex}` — **QQQ points, not NQ** (`options.ts:164`); no timestamp in payload | live singleton | CBOE QQQ options feed |
| **HTF structure** | `watch.htf.{daily,weekly}` = `"HH/HL"|"LH/LL"|"CHOP"` from own archive (~65 sessions) | TTL 6 h | own gcdata |
| **Liquidity/positioning** | `watch.fred.{hyOas,walcl,rrp,tga}` (raw values; WALCL ÷1e12 = $T, RRP ÷1e9 = $B) · `watch.cot.{net,netPctOi,pct52w,asOf}` (weekly, lagged) | TTL 6 h / 24 h | FRED keyless, CFTC Socrata |
| **Event calendar** | `watch.calendar.{opex{day,quad,days},auctions[],fomcMinutes{day,approx}}` — OPEX = 3rd-Friday rule; FOMC-minutes = decision+21d heuristic (always `approx:true`); auctions have a hardcoded Q4-2026 fallback (`macroWatch.ts:243`) | TTL 24 h | TreasuryDirect |
| **NQ price context** | `lastPrice`, `chg`, session H/L, `realizedBandPct` (live 1σ %, stdev of log returns × √390, `macroFmt.ts:98-107`) — **computed client-side in `app/page.tsx:210-235`, NOT in `/api/macro`** | second-by-second | live feed / Neon |

**Existing prose worth reusing:** `readOptionsFromSnapshot().note`
(`lib/options.ts:303-309`) already phrases the GEX regime as sentences
("dealers net LONG gamma … they dampen moves: mean-reversion/chop …").
Everything else in the macro layer is numeric; the model writes the prose.

**Serialization gotchas (the ones that bite):**
- `asOf` fields are five different types (CNBC display string "5:38 PM EDT",
  literal "coinbase · real-time", "YYYY-MM-DD", ISO-with-offset, ISO instant) —
  never merge/sort them; present each with its own label.
- All calendar `day` fields are **ET** dates; a UTC-dated pre-market snapshot
  mislabels "today" (`newsGate.ts:119`).
- News `forecast/previous` are free-text ("0.2%", "245K"), no units;
  `timeET===""` = all-day; `released` flips intraday; `source:"static"` means
  only the 4 Fed/BLS events are visible (weekend behavior: static resolves to
  next week).
- Units: yields %, spreads bps, VIX points, `pct1y`/`pct52w` percentiles,
  COT `netPctOi` % — the card chips divide raw FRED values for display; send
  the model raw values with explicit units, never the formatted strings.
- `watch` is never null; `bonds/news/earnings` can be `ok:false` with cached
  or null data while the route still returns 200 — the snapshot must carry
  `ok/stale/fetchedAt/error` per source and `news.source`/`earnings.provider`.

## 3. DeepSeek API facts (Oct 2026)

- Base URL `https://api.deepseek.com`, **OpenAI-compatible** — the repo already
  uses the exact shape in `web/scripts/strategyInsights.ts:181-259`
  (`POST {url}/chat/completions`, `Authorization: Bearer`, model +
  messages, 90 s `AbortSignal.timeout`, parse `choices[0].message.content`).
- Current model names: `deepseek-flash` and `deepseek-v4-pro`; the legacy
  name `deepseek-chat` (the repo's `ANALYSIS_LLM_MODEL`) is still accepted
  ([Quick start](https://api-docs.deepseek.com/)). Briefings use
  **`deepseek-v4-pro`** (chosen 2026-10-04; override with `BRIEFING_LLM_MODEL`).
- **JSON mode**: `response_format: {type:'json_object'}` + the word "json" in
  the prompt + an example of the exact schema + a sane `max_tokens`.
  ([JSON Output](https://api-docs.deepseek.com/guides/json_mode/)).
- **Thinking mode is ON by default (effort high)** — verified live: with
  `max_tokens=1200` the reasoning ate the budget and `content` came back
  EMPTY (the JSON-mode empty-content edge the docs warn about). Fixes in
  place: `thinking: {type:"disabled"}` + `max_tokens: 2000` (see
  `buildBriefingPayload`), and the parser warns + falls back on any
  unparseable/empty content ([Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode/)).
- **Example-copying pitfall** (verified live): with a realistic schema
  example the model reused the example's sentences verbatim. The example now
  carries placeholder words only + rule 11 ("shape only; every claim and
  number must come from the snapshot").
- **Multi-line JSON pitfall** (verified live): models emit literal newlines
  inside string values → invalid JSON. Schema now uses ARRAYS of short
  single-line strings (`read`/`watchFors`/`caveats`), and the grammar rule
  forbids literal newlines in strings; the parser also accepts the legacy
  `summary` string shape.
- Context caching is automatic (KV cache) — a stable system prompt is
  effectively free on repeat runs.
- Cost: ~$0.3/M input, ~$0.4/M output tokens
  ([Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)) → a
  3–5k-token briefing is **well under 1¢ per run**; 2–4 briefings/day is
  negligible. The real budgets to respect are Neon Free 512 MB and R2 transfer
  (5 GB/mo) — so briefings write one small row and prune.

## 4. Architecture options

| Option | Shape | Verdict |
|---|---|---|
| **A. Scheduled CLI → Neon → card reads API** | New `web/scripts/macroBriefing.ts` runs on cron (pre-open), builds the snapshot, calls DeepSeek, upserts a `macro_briefings` row; new `GET /api/briefing` serves it; card polls 60 s | **Chosen core** — briefings exist even when nobody is watching; survives restarts; matches the existing `insights` pattern exactly |
| **B. Pure on-demand route** | `POST /api/briefing?refresh` in the dashboard container calls DeepSeek with an in-process TTL | Simple, but no pre-open briefing unless someone opens the page, no history, and it dies on restart — **kept only as the "refresh now" button on top of A** |
| **C. Reuse the `insights` table** (`kind='briefing'`) | No new table; `/api/insights` already serves it | Works (subagent suggested it) but muddies the strategy self-improvement loop the journal renders; a dedicated table keeps the display-only boundary clean and lets the card keep its own history/prune policy |

**Recommendation: A + B.** Dedicated `macro_briefings` table (created by the
CLI itself, like `insights`/`strategy_overrides` in
`strategyInsights.ts:72-99`), scheduled generation at pre-open, and an
on-demand refresh button on the card that re-runs the same shared lib
function server-side with a cooldown.

## 5. Scheduling research ("when do we run it?")

Ground facts: crond in the `nq-jobs` container runs **two** entries today —
`reconcile.sh` 16:50 ET and `nightly.sh` 17:45 ET Mon–Fri, `TZ=America/New_York`
(`scripts/jobs_entry.sh:22-28`); the jobs container has `DATABASE_URL` (Neon),
full outbound HTTPS (proven by nightly.sh), and `ANALYSIS_LLM_*` plumbed
through `docker-compose.yml:36-38`; the dashboard container writes every
completed live minute to Neon `candles_1m`/`footprint_ticks`
(`web/lib/liveStore.ts:62-103`, `LIVE_WRITE=true` VPS-only) — so **a scheduled
job can read the full live overnight session from the DB**. `web/lib/macroFeed.ts`
is pure fetch + TTL cache with zero Next.js imports, so a CLI run via
`node --import ../scripts/ts-loader.mjs` can call `getMacroContext()` directly.

| Slot | Time (ET) | Data it can include | What it misses | Conflicts |
|---|---|---|---|---|
| **A. Pre-open** ⭐ | **09:15 Mon–Fri** (new `CRON_BRIEFING_PREOPEN="15 9 * * 1-5"` entry in `jobs_entry.sh`) | Full overnight ETH session from Neon (18:00→09:14, range/vol/delta), today's calendar + countdowns, earnings today, curve/regime/HTF/GEX, yesterday's reconciled trade record | How today's RTH actually opens; day's realized vol is ~0 | None — far from 16:50/17:45, read-only. **Must self-skip on CME holidays via `marketOpenAt()`** (`lib/marketHours.ts:86`) |
| **B. Post-close** | **17:50, inside `nightly.sh`** after `strategyInsights` (`nightly.sh:119-121`) | Full closed day (RTH+post, vendor-grade bars already ingested), day's realized vol, tomorrow's calendar | The 18:00+ evening session | Zero new cron; inherits the single-writer discipline and the 17:00–18:00 guard; guaranteed post-ingest ordering |
| **C. Mid-day** (optional) | 13:30 Mon–Fri | Live day through 13:30, intraday curve row, mid-day realized vol vs pre-open expectation | The 14:00–16:00 stretch, late-day news | None; needs the same holiday self-skip |
| **On-demand** | whenever the trader clicks **refresh** on the card | Everything, at click time (dashboard container fetches macro + Neon + calls DeepSeek; 10-min cooldown) | — | Needs `ANALYSIS_LLM_*` in the **nq-dashboard** Coolify env (verified present in Mac `web/.env.local`; not verifiable from the repo for the VPS — add it there) |

Why A is the star: a scalper decides their day before the open; the overnight
session is exactly the missing context the macro panels don't summarize, and
it's fully persisted in Neon by 09:14. Slot B is nearly free (one line in
nightly.sh). Slot C is a nice-to-have — defer until A+B prove useful.

## 6. Implementation plan (file by file)

1. **`web/lib/briefingText.ts`** (new, PURE — no feeds/DB, offline-testable):
   `BriefingContent` schema `{headline ≤15w (must say up/down/chop), bias:
   up|down|chop, vol, read ≤2 bullets, watchFors ≤3, caveats ≤2}` — the
   model's job is the BIAS + what changes it; key LEVELS are computed in
   code (snapshot.nq.levels, GEX walls/flip converted QQQ→NQ via the live
   spot ratio) and rendered directly by the card, so prices can never be
   hallucinated; `buildBriefingPayload` (JSON mode + thinking disabled +
   placeholder-only example), `parseBriefingContent`,
   `renderDeterministicBriefing` (rules-built bias/read/watch-fors).
2. **`web/lib/macroBriefing.ts`** (new, shared by CLI + route) — the only
   module allowed to import `macroFeed` besides the route:
   - `buildBriefingSnapshot()`: `getMacroContext()` + NQ price context from
     Neon (`candles_1m` latest rows for the overnight/session window: last
     close, H/L, cum delta, `realizedDailyBandPct` on the 1-min closes) +
     per-source `ok/stale/error` envelope + ET timestamps. Null→explicit.
   - `callDeepSeekBriefing()`: mirrors `llmNarrative` (URL/KEY gate, 90 s
     timeout, JSON mode, thinking disabled); `BRIEFING_LLM_MODEL` default
     `deepseek-v4-pro`.
   - `persistBriefing()`/`latestBriefing()`: `macro_briefings` table
     (created by the module, 30-day prune).
3. **`web/scripts/macroBriefing.ts`** (new CLI): arg `pre-open|post-close|on-demand`;
   holiday/session self-skip (`marketOpenAt` + 08:45–09:59 / 17:00–18:30 NY
   windows); runs the shared generation path; explicit `process.exit`
   (the options-feed singleton keeps a poll timer alive).
4. **`web/app/api/briefing/route.ts`** (new): `GET` latest row (default
   `kind='pre-open'`, fall back to any latest); `POST {action:'refresh'}` with
   a 10-min cooldown + in-flight dedup (rate-limit guard, ~1¢/call).
5. **`web/components/AiBriefingCard.tsx`** (new): `BentoCard hero` — thesis
   headline rendered in the BODY (BentoCard titles truncate), bias/vol/regime
   chips, ≤5 `read` bullets, ≤3 `watchFors`, ≤2 caveats, freshness badge
   (DeepSeek/deterministic · generated-at ET), refresh button with cooldown,
   60 s poll (5 s while a refresh is landing). Display-only footer.
6. **`web/app/page.tsx`**: card at the top — under the header, above the
   4-stat live strip (the strip itself stays untouched).
7. **`scripts/jobs_entry.sh` + `scripts/briefing.sh`**: third crontab line
   (`CRON_BRIEFING_PREOPEN`, default `15 9 * * 1-5`) + a wrapper cloned from
   `scripts/reconcile.sh`. **`scripts/nightly.sh`**: post-close step after
   `strategyInsights` (`macroBriefing.ts post-close`), rc in the exit cascade.
8. **Tests** (`web/tests/macroBriefing.test.ts`, offline): payload shape
   (thinking disabled, brevity rules), parser round-trips + legacy-shape
   compat + junk filtering, deterministic read/watch-fors/caveats invariants,
   no-NaN on degraded snapshots. `npm test` 488 pass / 7 skipped.
9. **Docs**: this file; `README.md` dashboard section; `deploy/STATE.md` when
   the cron is live (STATE is the ops record); `web/README.md` surfaces.

**Deploy flow**: push to `main` → Coolify webhook rebuilds `nq-dashboard` and
`nq-jobs` automatically (`deploy/STATE.md:287-291`). Add `ANALYSIS_LLM_*` to
the **nq-dashboard** Coolify env for the on-demand button (jobs app already
plumbs them, `docker-compose.yml:36-38`). Verify the new cron by reading
`/app/gcdata/data/briefing_cron.log` after the first 09:15 run; local dry-run:
`node --import ../scripts/ts-loader.mjs ./scripts/macroBriefing.ts pre-open`.

## 7. Risks & open decisions

- **Risks**: JSON-mode empty-content edge (→ deterministic fallback, always);
  LLM env missing on the VPS dashboard app (→ refresh button degrades to
  deterministic, badge says so); FF-mirror ToS-grayness (already accepted by
  the existing panels); hardcoded fallbacks expire (newsGate through 2027-01,
  auction fallback through 2026-12-23 — flag items derived from them);
  the model must be told every vintage explicitly or it will conflate the
  delayed CNBC quotes with live data.
- **Open**: card placement (recommend under the header, above the live strip —
  trivially movable); which slots to arm first (recommend A now, B now, C
  later); `BRIEFING_LLM_MODEL` override vs reusing `ANALYSIS_LLM_MODEL`
  (reuse, default `deepseek-chat`).
