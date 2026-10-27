#!/usr/bin/env python3
"""Probe whether GoCharting serves VIX data (spot index or futures) over
the same undocumented socket. One connection, one window request per
candidate symbol — same gentleness rules as the other probes."""
import json
import os
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


from envfile import load_env  # noqa: E402  (shared gcdata/.env loader)


# (exchange, segment, symbol, session) — CFDs trade 24/5, so session matters
CANDIDATES = [
    ("PEPPERSTONEUK", "INDEX", "VIX", "ETH"),
    ("PEPPERSTONEUK", "INDEX", "VIX", "RTH"),
    ("PEPPERSTONEUK", "CFD", "VIX", "ETH"),
    ("PEPPERSTONEUK", "CFD", "VIX", "RTH"),
    ("PEPPERSTONEUK", "INDEX", "VIX", "FULL"),
]


def probe_one(exchange, segment, symbol, session="RTH"):
    import ssl
    import websocket

    dc = os.environ.get("GOCHARTING_DC", "nyc1")
    token = os.environ.get("GOCHARTING_TOKEN", "")
    if not token:
        try:
            from client import cognito_id_token as cognito_token

            token = cognito_token()
        except Exception as e:
            print(f"  no token: {e}")
            return None
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    ws.connect(f"wss://origin.ws.prodb.{dc}.gocharting.com/{dc}/ws?token={token}&tag={uuid.uuid4()}", timeout=60)
    ws.recv()  # hello
    payload = {
        "msg_type": "OHLCV/V2",
        "symbol": f"{exchange}:{segment}:{symbol}",
        "interval": "1m",
        "session": session,
        "hint": "max=true",
        "idxs": [0],
    }
    ws.send(json.dumps({"request_id": 1, "command": "TS/V2", "action": "add", "payload": payload}))
    deadline = time.time() + 25
    found = None
    while time.time() < deadline:
        ws.settimeout(max(0.2, deadline - time.time()))
        try:
            msg = ws.recv()
        except Exception:
            break
        if isinstance(msg, str):
            try:
                j = json.loads(msg)
                txt = json.dumps(j)[:200]
            except Exception:
                txt = msg[:200]
            if "OHLC" in txt or "bar" in txt.lower() or "error" in txt.lower():
                print(f"    {txt}")
                if "error" in txt.lower() or "not found" in txt.lower():
                    found = None
                    break
        else:
            b = bytes(msg)
            f = b[4] if len(b) > 4 else 0
            body = b[5 + f :] if len(b) > 5 + f else b""
            print(f"    binary frame: header={b[5:5+f].decode('utf-8','replace')!r} body={len(body)} bytes")
            if len(body) > 100:
                found = f"binary payload {len(body)} bytes"
                break
    try:
        ws.close()
    except Exception:
        pass
    return found


def main():
    load_env()
    for exchange, segment, symbol, session in CANDIDATES:
        print(f"probe {exchange}:{segment}:{symbol} [{session}] …", flush=True)
        try:
            r = probe_one(exchange, segment, symbol, session)
            print(f"  → {r if r else 'no data'}")
        except Exception as e:
            print(f"  → error: {e}")
        time.sleep(2)


if __name__ == "__main__":
    main()
