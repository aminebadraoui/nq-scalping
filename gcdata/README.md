# gcdata — GoCharting NQ data pipeline (personal use)

Extracts NQ footprint data from the GoCharting web terminal's realtime socket and
computes the six volume profiles from `../NQ_ALERT_SYSTEM_DESIGN.md` (P0–P5) plus
LVN zones and a naked-POC check.

## How it works

1. Authenticates to AWS Cognito (`USER_PASSWORD_AUTH`) → IdToken.
2. Opens `wss://origin.ws.prodb.nyc1.gocharting.com/nyc1/ws?token=…&tag=…`.
3. Sends `{"command":"FOOTPRINT/V2","payload":{exchange,segment,symbol,interval,dates,session}}`.
4. Decodes the protobuf `fpgc.FootPrintForDateResponse`: per-minute, per-tick
   buy/sell volume and trade counts for RTH and ETH sessions.
5. `profiles.py` aggregates any window at any row size → POC/VAH/VAL/LVNs.

## Retention reality (measured, re-verified 2026-10-01)

FOOTPRINT/V2 serves data **per contract, scoped to that contract's front-month
tenure**, and the vendor retains a **rolling window of the last ~11 quarterly
contracts (~2.75 years)**. Verified three ways:

- `probe_tenures.py` — one mid-tenure date per quarterly contract 2017→now:
  everything before NQH24 (2023-12-18) returns NO DATA; H-contract samples on
  MLK Day look like NO DATA too (holiday, not a gap — `probe_boundary.py`
  re-checks on trading days).
- `probe_boundary.py` — the cutover is exact: NQZ23 (Dec 2023) purged, NQH24
  tenure served complete from 2023-12-18.
- `probe_symbols.py` — no alternate format reaches deeper: `NQZ2023` (4-digit
  year), `NQ1!`, `NQ`, and the current contract asked about old dates all
  return nothing.

So ~10 years is **not available from this vendor**; the archive's Dec-2023 start
is the vendor's window, captured in time by the contract walk. Older history
needs CME DataMine or a CME-authorized reseller (Databento) — the collector
scripts above accept whatever source builds the same JSON shape.

## Contract-aware backfill

`contracts.py` is the single source of truth for which symbol was the front
month on any date (NQ quarterly cycle, expiry = 3rd Friday of H/M/U/Z,
tenure = next trading day after the previous expiry through expiry day —
generated on the fly, verified against the original hardcoded table).

```bash
.venv/bin/python backfill_tenures.py --from 2017-03-01 --plan      # print calendar
.venv/bin/python backfill_tenures.py --from 2023-12-01 --only-gaps # heal sparse/missing only
scripts/backfill_contracts.sh --force                              # same, full walk
```

`--only-gaps` skips every date already flagged usable in the R2 manifest, so a
re-run repairs only the sparse/partial sessions instead of re-downloading the
archive.

## Storage layout (10-year ready)

- **R2** (`GC_REMOTE_URL`) = the record: gzipped per-session JSON +
  `manifest.json` (sha256 + candle counts + `usable` flags), uploaded by
  `../scripts/r2_sync.py`.
- **Local gzip cache** = the backtest working set: `~/.cache/nq-archive/`
  (`MOM_CACHE_DIR` overrides), populated on first read by
  `../web/lib/archive.ts`, sha256-verified when `MOM_VERIFY_SHA=1`, and
  preloaded in one shot by `momentumStudy.ts --warm` (parallel, resumable).
- 10 years ≈ 540 MB gzipped on disk — sweep after warm is pure disk I/O.

## Setup

```bash
python3 -m venv .venv && .venv/bin/pip install websocket-client protobuf
cp .env.example .env   # then edit with your GoCharting credentials
```

## Usage

```bash
.venv/bin/python collect.py --days 8            # pull last 8 days (RTH+ETH)
.venv/bin/python collect.py --level-sheet --today 2026-09-25
```

## Warnings

- **Undocumented transport.** It can break or be revoked at any deploy.
- **CME licensing.** Your GoCharting subscription covers personal display use;
  keep this data for personal research only — do not redistribute.
- **Be gentle.** One request per (date, session); don't hammer the socket or
  the account may get flagged.
- History depth observed: ~2.75 years (older dates return empty/partial).
- Credentials live in `.env` (gitignored). Rotate your password if this file
  ever leaves your machine.

Regenerate protobuf modules after schema changes:
`python -m grpc_tools.protoc -I. --python_out=. footprint.proto ohlc_bars.proto`
