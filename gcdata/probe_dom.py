#!/usr/bin/env python3
"""Probe the DOM_V2 channel — L2 book over the dedicated wsdom socket.

Reverse-engineered 2026-10-02 from the terminal's trades.worker bundle:
- DOM_V2 lives on a SEPARATE socket: wss://origin.wsdom.<dc>.gocharting.com/<dc>/ws
  (the trade/quote socket is origin.ws.<dc>).
- SUBSCRIBE: {"command":"SUBSCRIBE","channel":"DOM_V2","payload":["CME:FUTURE:NQZ26"]}
- Frames are binary: [byte 0 = 109][4B length (LE)][header text][zlib-inflated JSON].
- Payload: {"channel":"DOM_V2","payload":{"t":"s"|"d","seq":N,"data":{...}}}
  snapshot data: {symbol,exchange,segment,bids:[{p,s}],asks:[{p,s}]}
  incremental data: {bids:[{a:"d"?,p,s}],asks:[...]}   (a="d" = level deleted)

Personal use only — one socket, short capture, be gentle.
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
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))


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


def inflate(body: bytes) -> str:
    """pako.inflate({to:'string'}) ≈ zlib decompress; fall back to raw deflate."""
    for wbits in (15, -15):
        try:
            return zlib.decompress(body, wbits).decode("utf-8", "replace")
        except zlib.error:
            continue
    raise ValueError("not zlib")


def decode_frame(b):
    """Return (label, text) for a wsdom binary frame.

    Two frame paths exist on this vendor's sockets (from the trades.worker):
    - first byte 109 ('m'): protobuf-response framing (FOOTPRINT/V2, TS/V2)
      — header length + header text + protobuf body. Not used by DOM_V2.
    - anything else: the WHOLE frame is zlib-deflated JSON — this is the
      DOM_V2 message path ({channel:"DOM_V2", payload:{t, seq, data}}).
    """
    if not b:
        return None
    if b[0] != 109:
        for wbits in (15, -15):
            try:
                j = json.loads(zlib.decompress(bytes(b), wbits).decode("utf-8", "replace"))
                return "INFLATED", j
            except (zlib.error, ValueError):
                continue
        return "INFLATED_RAW", bytes(b).hex()
    f = int.from_bytes(b[1:5], "little")
    header = b[5 : 5 + f].decode("utf-8", "replace")
    body = b[5 + f :]
    if not body:
        return "HEADER", header
    try:
        return "HDR+INFLATE", {"header": header, "json": json.loads(inflate(body))}
    except (ValueError, json.JSONDecodeError):
        return "HDR+RAW", {"header": header, "hex": body.hex()}


def main() -> int:
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=float, default=45, help="capture window")
    ap.add_argument("--out", default=None, help="log path (default: data/dom_probe_<ts>.log)")
    args = ap.parse_args()

    import websocket  # type: ignore

    token = cognito_token()
    dc = os.environ.get("GOCHARTING_DC", "nyc1")
    sym = f"{os.environ['GOCHARTING_EXCHANGE']}:{os.environ['GOCHARTING_SEGMENT']}:{os.environ['GOCHARTING_SYMBOL']}"
    out = Path(args.out) if args.out else HERE / "data" / f"dom_probe_{dt.datetime.now():%Y%m%d_%H%M%S}.log"

    # the DOM socket: origin.ws. -> origin.wsdom. (keeps the .prodb segment)
    url = f"wss://origin.wsdom.prodb.{dc}.gocharting.com/{dc}/ws?token={token}&tag={uuid.uuid4()}"
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    ws.connect(url, timeout=60)
    ws.recv()  # welcome frame

    with out.open("w") as f:
        f.write(f"# dom probe started {dt.datetime.now().isoformat()} url={url} seconds={args.seconds}\n")
        ws.send(json.dumps({"command": "SUBSCRIBE", "channel": "DOM_V2", "payload": [sym]}))
        f.write(f"# SUBSCRIBE DOM_V2 {sym}\n")

        end = time.time() + args.seconds
        n_txt = n_bin = n_dom = n_snap = n_incr = 0
        while time.time() < end:
            ws.settimeout(max(0.2, end - time.time()))
            try:
                m = ws.recv()
            except Exception:
                break
            if isinstance(m, (bytes, bytearray)):
                n_bin += 1
                dec = decode_frame(bytes(m))
                if dec is None:
                    f.write(f"BIN_RAW {bytes(m).hex()}\n")
                    continue
                label, content = dec
                if label in ("INFLATED",):
                    j = content
                    f.write(f"BIN {label}\n  {json.dumps(j)[:4000]}\n")
                    if isinstance(j, dict) and j.get("channel") == "DOM_V2":
                        n_dom += 1
                        p = j.get("payload") or {}
                        if p.get("t") == "s":
                            n_snap += 1
                        elif p.get("t") == "d":
                            n_incr += 1
                else:
                    f.write(f"BIN {label} {content if isinstance(content, str) else json.dumps(content)[:4000]}\n")
            else:
                n_txt += 1
                f.write(f"TXT {m}\n")
                if m.startswith("PING-"):
                    ws.send("PONG-" + m[5:])
            f.flush()
        f.write(f"# done: txt={n_txt} bin={n_bin} dom={n_dom} (snap={n_snap}, incr={n_incr})\n")

    ws.close()
    print(f"captured txt={n_txt} bin={n_bin} dom={n_dom} (snap={n_snap}, incr={n_incr}) -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
