# ES cross-asset archive — GoCharting ES footprint (data/es)

Second instrument, same pipeline: 1-minute ES futures footprint data collected
from the same undocumented GoCharting socket as the NQ archive, one file per
(date, session), mirroring the NQ store date-for-date. Purpose: cross-asset
microstructure features for the NQ scalping backtests — NQ−ES delta divergence,
relative strength, RVOL ratio, lead-lag — per `docs/data/DATA_DIMENSIONS_RESEARCH.md` §4.2.

## Collection (`backfill_es.py`)

- **Symbols**: per-contract, same quarterly cycle as NQ (H/M/U/Z, 3rd-Friday
  expiry) — `ESH24`, `ESM25`, … from `contracts.py` with the `ES` prefix.
  The bare `ES` symbol returns nothing; `ES1!` works but only serves recent
  dates, so the tenure walk asks each date of the contract that was front
  month on that date (verified: asking ESU26 for a date after its expiry
  returns NO DATA — per-contract serving, exactly like NQ).
- **Retention**: starts **2023-12-18** (ESH24 tenure) — identical boundary to
  the NQ archive (ESZ23 → NO DATA). Same ~2.75-year rolling window applies.
- **Session windows**: the vendor serves ES with the same feed-clock windows
  as NQ — ETH 17:00 CT → 15:59 CT (1,380 min), RTH 08:30 → 14:59 CT (390 min).
  The shared `backfill.session_usable` rule applies unchanged.
- **Date list**: the NQ R2 manifest's usable ETH sessions (649 dates,
  2023-12-18 → 2026-10-02) — "as many dates as we have for NQ".
- **Roll-week fallback**: dates within ~10 days of a tenure end that come back
  sparse under the expiring contract are retried under the next contract
  (same behaviour NQ needed `refetch_rollover.py` for).
- **Storage**: `gcdata/data/es/<date>_<session>.json` — same JSON contract as
  the NQ files (prices in cents, `levels` dict, `_meta` stamped with the ES
  contract symbol and `underlying: "ES"`). ES tick size = 25 (0.25 pt), price
  scale in cents — same field formats as NQ.

## Archive state (built 2026-10-02)

- **R2 `manifest-es.json`: 1,298 objects — 649/649 ETH sessions usable, 649
  RTH files.** Local `gcdata/data/es` is the landing zone only; after upload
  the finish workflow prunes it (R2 is the record, same as the NQ flow).
- Two known vendor quirks (verified non-transient by re-fetch): the RTH
  sessions of **2024-03-27** (387/390 min) and **2026-03-03** (380/390 min)
  are served sparse under every contract — ETH for both dates is complete,
  and all studies load the ETH file, so nothing downstream is affected.

## Why a separate store

The NQ store, the dashboard (`web/lib/archive.ts`, `gcdata.ts`), and
`scripts/r2_sync.py` all key off `gcdata/data/*.json` and `manifest.json`.
ES files live under `data/es/` — invisible to all of them — and get their own
R2 prefix and their own `manifest-es.json` (`scripts/es_r2_sync.py`), so
nothing downstream changes until a study explicitly asks for ES.

## Operations

```sh
# full walk (idempotent — skips complete files, heals partials)
.venv/bin/python backfill_es.py

# recent window (nightly freshness — guarded in scripts/nightly.sh)
.venv/bin/python backfill_es.py --from $(date -v-8d +%F) --to today

# plan / inspect one date's raw spans / force re-fetch
.venv/bin/python backfill_es.py --plan
.venv/bin/python backfill_es.py --inspect 2026-10-01
.venv/bin/python backfill_es.py --force

# coverage parity vs the NQ archive
.venv/bin/python check_es_coverage.py

# archive: upload → data/es/* + manifest-es.json, then free the disk
python3 scripts/es_r2_sync.py upload
python3 scripts/es_r2_sync.py prune
```

Nightly (`scripts/nightly.sh`) runs the recent-window pass + upload + prune,
and skips itself when a long `backfill_es.py` is already running (single
socket, one collector at a time — gentleness rule).

## Consumption

For a study, load the pair with the existing archive machinery — the file
shape is identical to NQ:

```ts
// web/lib/archive.ts loads by key pattern; the ES twin lives at
// ${GC_REMOTE_URL}/data/es/<date>_<session>.json  (see manifest-es.json)
```

First planned joins (from `docs/data/DATA_DIMENSIONS_RESEARCH.md` §4.2): NQ−ES delta
divergence at the flush, NQ−ES spread z-score, relative RVOL, and lead-lag at
the breakout — each a split dimension over the existing momentum/RTH replays.

*Educational research only — not financial advice.*
