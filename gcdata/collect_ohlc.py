#!/usr/bin/env python3
"""Collect real 1-minute OHLC bars from the GoCharting realtime socket.

Why this exists
---------------
The FOOTPRINT/V2 response gives per-minute high/low plus per-price bid x ask
clusters, but *not* open/close. The TS/V2 OHLCV request does return real OHLC
(open/high/low/close/volume), so the dashboard can draw normal candles instead
of synthetic dojis.

Socket quirk that matters
-------------------------
`hint="max=true"` returns a sliding window of the LAST 3 trading days, and each
*subsequent* request on the SAME socket pages one window further back in
history. A fresh socket therefore always starts at "most recent". We exploit
that to walk backwards, one window per request.

Usage
-----
    python collect_ohlc.py --windows 20          # backfill ~60 trading days
    python collect_ohlc.py --windows 3 --dry-run # inspect only

Writes gcdata/data/ohlc/<YYYY-MM-DD>.json  (one file per trading date).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import ssl
import sys
import time
import urllib.request
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
OHLC_DIR = DATA / "ohlc"

sys.path.insert(0, str(HERE))
import ohlc_bars_pb2  # noqa: E402  (generated from ohlc_bars.proto)


def load_env() -> None:
    env = HERE / ".env"
    if not env.exists():
        return
    for line in env.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def cognito_token() -> str:
    body = {
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": os.environ["GOCHARTING_COGNITO_CLIENT"],
        "AuthParameters": {
            "USERNAME": os.environ["GOCHARTING_EMAIL"],
            "PASSWORD": os.environ["GOCHARTING_PASSWORD"],
        },
    }
    req = urllib.request.Request(
        "https://cognito-idp.ap-south-1.amazonaws.com/",
        data=json.dumps(body).encode(),
        headers={
            "Content-Type": "application/x-amz-json-1.1",
            "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
            "User-Agent": "Mozilla/5.0",
        },
    )
    return json.loads(urllib.request.urlopen(req, timeout=30).read())[
        "AuthenticationResult"
    ]["IdToken"]


def fetch_windows(windows: int, interval: str = "1m") -> dict[str, list[dict]]:
    """Return {date: [bar, ...]} covering `windows` x 3 trading days, newest first."""
    import websocket  # type: ignore

    dc = os.environ.get("GOCHARTING_DC", "nyc1")
    symbol = os.environ.get("GOCHARTING_SYMBOL", "NQZ26")
    exchange = os.environ.get("GOCHARTING_EXCHANGE", "CME")
    segment = os.environ.get("GOCHARTING_SEGMENT", "FUTURE")

    token = cognito_token()
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    ws.connect(
        f"wss://origin.ws.prodb.{dc}.gocharting.com/{dc}/ws?token={token}&tag={uuid.uuid4()}",
        timeout=60,
    )
    ws.recv()  # hello

    payload = {
        "msg_type": "OHLCV/V2",
        "symbol": f"{exchange}:{segment}:{symbol}",
        "interval": interval,
        "session": "RTH",
        "hint": "max=true",
        "idxs": [0],
    }

    out: dict[str, list[dict]] = {}
    for w in range(windows):
        ws.send(json.dumps({"request_id": w + 1, "command": "TS/V2", "action": "add", "payload": payload}))
        res = None
        deadline = time.time() + 25
        while time.time() < deadline:
            ws.settimeout(max(0.2, deadline - time.time()))
            try:
                msg = ws.recv()
            except Exception:
                continue
            if isinstance(msg, (bytes, bytearray)):
                b = bytes(msg)
                flen = b[4]
                text = b[5 : 5 + flen].decode("utf-8", "replace")
                if text.startswith("TS"):
                    res = ohlc_bars_pb2.OHLCBarResult()
                    res.ParseFromString(b[5 + flen :])
                    break
        if res is None:
            print(f"  window {w + 1}: no response (history exhausted?)", flush=True)
            break
        dates = sorted(res.intraday_candles.keys())
        if not dates:
            print(f"  window {w + 1}: empty", flush=True)
            break
        print(f"  window {w + 1}: {dates[0]} .. {dates[-1]}", flush=True)
        fresh = 0
        for date in dates:
            if date in out:
                continue
            ib = res.intraday_candles[date]
            start = dt.datetime.fromisoformat(ib.start)
            bars = []
            for c in ib.candles:
                t = start + dt.timedelta(minutes=int(c.offset))
                bars.append(
                    {
                        "t": t.isoformat(),
                        "o": c.open / 100.0,
                        "h": c.high / 100.0,
                        "l": c.low / 100.0,
                        "c": c.close / 100.0,
                        "v": int(c.volume),
                    }
                )
            bars.sort(key=lambda b: b["t"])
            out[date] = bars
            fresh += 1
        if fresh == 0:
            break
        time.sleep(0.4)

    ws.close()
    return out


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--windows", type=int, default=4, help="3 trading days per window")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    data = fetch_windows(args.windows)
    if not data:
        print("no bars returned")
        return 1

    total = sum(len(v) for v in data.values())
    print(f"collected {total} bars across {len(data)} dates")
    if args.dry_run:
        for d in sorted(data):
            b = data[d]
            print(f"  {d}: {len(b)} bars  first {b[0]}  last {b[-1]}")
        return 0

    OHLC_DIR.mkdir(parents=True, exist_ok=True)
    merged_dates = 0
    for date, bars in sorted(data.items()):
        path = OHLC_DIR / f"{date}.json"
        merged = {b["t"]: b for b in bars}
        if path.exists():
            # MERGE with what is on disk. The old code kept whichever set was
            # larger, so a partial file (the feed does not always serve a full
            # RTH day for older dates) stayed partial forever even though the
            # missing minutes were available in a later walk.
            try:
                for b in json.loads(path.read_text()).get("bars", []):
                    merged.setdefault(b["t"], b)
            except Exception:
                pass
        out = [merged[t] for t in sorted(merged)]
        if path.exists():
            before = len(json.loads(path.read_text()).get("bars", []))
            if len(out) > before:
                merged_dates += 1
        path.write_text(json.dumps({"date": date, "session": "RTH", "bars": out}))
    print(f"wrote {len(list(OHLC_DIR.glob('*.json')))} files to {OHLC_DIR} ({merged_dates} repaired/merged)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
