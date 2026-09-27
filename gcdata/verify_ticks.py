#!/usr/bin/env python3
"""Sunday 18:00 ET tick-flow verification capture.

Connects to the GoCharting socket, subscribes to trade/DOM_V2/watchlist,
and logs EVERY frame for CAPTURE_MINUTES to
  data/tick_verify_log.txt        (raw frames, hex for binary)
  data/tick_verify_summary.json   (counts + decoded tick samples)

Personal use only.
"""
import json
import os
import ssl
import time
import uuid
import urllib.request

import websocket

CAPTURE_MINUTES = 5


def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        for line in open(env_path):
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env()
EMAIL = os.environ["GOCHARTING_EMAIL"]
PASSWORD = os.environ["GOCHARTING_PASSWORD"]
CLIENT = os.environ.get("GOCHARTING_COGNITO_CLIENT", "3fqhvm22ea8pjsr2spbnv484pr")
DC = os.environ.get("GOCHARTING_DC", "nyc1")
SYM = f"{os.environ.get('GOCHARTING_EXCHANGE','CME')}:{os.environ.get('GOCHARTING_SEGMENT','FUTURE')}:{os.environ.get('GOCHARTING_SYMBOL','NQZ26')}"


def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


def cognito():
    body = {"AuthFlow": "USER_PASSWORD_AUTH", "ClientId": CLIENT,
            "AuthParameters": {"USERNAME": EMAIL, "PASSWORD": PASSWORD}}
    req = urllib.request.Request(
        "https://cognito-idp.ap-south-1.amazonaws.com/",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/x-amz-json-1.1",
                 "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
                 "User-Agent": "Mozilla/5.0"})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())["AuthenticationResult"]["IdToken"]


def main():
    load_env()
    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(here, "data")
    os.makedirs(data_dir, exist_ok=True)
    log_path = os.path.join(data_dir, "tick_verify_log.txt")
    sum_path = os.path.join(data_dir, "tick_verify_summary.json")

    tok = cognito()
    url = f"wss://origin.ws.prodb.{DC}.gocharting.com/{DC}/ws?token={tok}&tag={uuid.uuid4()}"
    ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
    ws.connect(url, timeout=30)

    counts = {"text": 0, "binary": 0, "ticks": 0, "snapshots": 0, "others": 0}
    tick_samples = []
    binary_headers = []
    other_samples = []
    start = time.time()

    with open(log_path, "w") as f:
        f.write(f"# tick verification started {time.ctime()} url={url[:100]}...\n")
        f.write("# subscribing to trade/DOM_V2/watchlist for " + SYM + "\n")
        for ch in ("trade", "DOM_V2", "watchlist"):
            ws.send(json.dumps({"command": "SUBSCRIBE", "channel": ch, "payload": [SYM]}))
            f.write(f"# SUBSCRIBE {ch} {SYM}\n")
        f.flush()

        end = start + CAPTURE_MINUTES * 60
        while time.time() < end:
            try:
                ws.settimeout(max(0.2, end - time.time()))
                m = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            if isinstance(m, (bytes, bytearray)):
                counts["binary"] += 1
                b = bytes(m)
                hdr = b[:12].hex()
                if len(binary_headers) < 10:
                    binary_headers.append(hdr)
                f.write(f"BIN len={len(b)} hdr={hdr}\n")
            elif isinstance(m, str):
                counts["text"] += 1
                f.write("TXT " + m[:600] + "\n")
                try:
                    j = json.loads(m)
                    ch = j.get("channel")
                    if ch == "trade":
                        p = list((j.get("payload") or {}).values())
                        items = p[0] if p and isinstance(p[0], list) else []
                        counts["ticks"] += len(items)
                        for d in items[:5]:
                            tick_samples.append({k: d.get(k) for k in ("ltp", "price", "quantity", "qty", "size", "volume", "side", "buy", "date", "date_str") if d.get(k) is not None})
                    elif ch == "snapshot":
                        counts["snapshots"] += 1
                    else:
                        counts["others"] += 1
                        if len(other_samples) < 5:
                            other_samples.append(m[:200])
                except Exception:
                    pass
            f.flush()

    ws.close()
    summary = {
        "started": time.ctime(start),
        "duration_min": CAPTURE_MINUTES,
        "counts": counts,
        "tick_samples": tick_samples[:5],
        "binary_headers": binary_headers,
        "other_samples": other_samples,
        "verdict": "TICKS FLOWING" if counts["ticks"] > 0 else "NO TICKS — check market open / subscribe format",
    }
    with open(sum_path, "w") as f:
        json.dump(summary, f, indent=2)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
