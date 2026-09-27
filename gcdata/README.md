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
- History depth observed: ~30 days (older dates return empty/partial).
- Credentials live in `.env` (gitignored). Rotate your password if this file
  ever leaves your machine.

Regenerate protobuf modules after schema changes:
`python -m grpc_tools.protoc -I. --python_out=. footprint.proto ohlc_bars.proto`
