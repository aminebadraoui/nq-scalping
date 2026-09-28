#!/usr/bin/env python3
"""Collect the free CBOE delayed option chain for dealer-positioning (GEX).

Why this exists
---------------
The options/gamma box needs one thing that is NOT available from the
GoCharting feed: per-strike option open interest + greeks. CBOE publishes a
free, undocumented delayed-quotes JSON endpoint that returns the WHOLE chain
for an underlying — every strike across every expiration — including
open_interest, implied volatility and the published delta/gamma/vega/theta/rho.

    GET https://cdn-api.cboe.com/api/global/delayed_quotes/options/QQQ.json

QQQ (and SPY, XNDX) return HTTP 200. The big cash-index options (NDX, SPX)
return 403 AccessDenied, so QQQ is the liquid, free proxy for NQ — the box
maps QQQ strikes to NQ points with the live NQ/QQQ ratio.

Usage
-----
    .venv/bin/python collect_options.py --symbol QQQ
    .venv/bin/python collect_options.py --symbols QQQ SPY

Writes gcdata/data/options/<SYMBOL>_<YYYY-MM-DD>.json  (compact fields only).

Warnings (same as the rest of gcdata)
-------------------------------------
- Undocumented endpoint: can break or be revoked at any deploy.
- Delayed ~15 min; open interest is EOD. One fetch per day is plenty — do not
  hammer it.
- Data is for personal research; do not redistribute (exchange licensing).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPTIONS_DIR = HERE / "data" / "options"

ENDPOINT = "https://cdn-api.cboe.com/api/global/delayed_quotes/options/{symbol}.json"

# fields we keep — everything the gamma box needs, nothing it doesn't.
KEEP = ("option", "bid", "ask", "iv", "open_interest", "volume", "delta", "gamma")


def fetch(symbol: str) -> dict:
    req = urllib.request.Request(
        ENDPOINT.format(symbol=symbol),
        headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        if r.status != 200:
            raise RuntimeError(f"HTTP {r.status} for {symbol}")
        return json.loads(r.read().decode("utf-8"))


def compact(payload: dict) -> dict:
    raw = payload.get("data", {}).get("options", [])
    out = []
    for o in raw:
        out.append({k: o.get(k) for k in KEEP})
    return {"symbol": payload.get("symbol"), "timestamp": payload.get("timestamp"), "options": out}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--symbols", nargs="*", default=[])
    args = ap.parse_args()

    symbols = args.symbols or [args.symbol]
    OPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    today = dt.date.today().isoformat()

    for sym in symbols:
        try:
            payload = fetch(sym)
            data = compact(payload)
            data["symbol"] = sym
            n = len(data["options"])
            path = OPTIONS_DIR / f"{sym}_{today}.json"
            path.write_text(json.dumps(data))
            print(f"{sym}: wrote {n} options to {path}")
        except Exception as e:  # noqa: BLE001
            print(f"{sym}: FAILED — {e}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
