"""GoCharting market-data client (undocumented socket, personal use only).

Reverse-engineered 2026-09-26 from the web terminal's trades worker:
- Auth: AWS Cognito USER_PASSWORD_AUTH -> IdToken
- Socket: wss://origin.ws.prodb.<dc>.gocharting.com/<dc>/ws?token=<idtoken>&tag=<uuid>
- Requests: JSON text frames {"command": "FOOTPRINT/V2" | "TS/V2", ...}
- Responses: binary [4B][1B textlen][text "CMD~fields"][protobuf fpgc.FootPrintForDateResponse]

CME data is licensed for personal use only. Do not redistribute.
This transport is undocumented: it can change or be revoked at any deploy.
"""
import json
import os
import ssl
import uuid
import urllib.request

import websocket

import footprint_pb2  # compiled from /terminal/assets/proto/1.1/footprint.proto
import ohlc_bars_pb2  # compiled from /terminal/assets/proto/1.1/ohlc_bars.proto


def _env(key, default=None):
    v = os.environ.get(key)
    if v is None:
        raise RuntimeError(f"missing env var {key} (see .env.example)")
    return v


def cognito_id_token():
    body = {
        "AuthFlow": "USER_PASSWORD_AUTH",
        "ClientId": _env("GOCHARTING_COGNITO_CLIENT"),
        "AuthParameters": {
            "USERNAME": _env("GOCHARTING_EMAIL"),
            "PASSWORD": _env("GOCHARTING_PASSWORD"),
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
    with urllib.request.urlopen(req, timeout=30) as r:
        data = json.loads(r.read())
    return data["AuthenticationResult"]["IdToken"]


class GChartClient:
    def __init__(self, token=None):
        self.token = token or cognito_id_token()
        self.dc = os.environ.get("GOCHARTING_DC", "nyc1")
        self._rid = 0
        self.ws = None

    def connect(self):
        url = (
            f"wss://origin.ws.prodb.{self.dc}.gocharting.com/{self.dc}/ws"
            f"?token={self.token}&tag={uuid.uuid4()}"
        )
        self.ws = websocket.WebSocket(sslopt={"cert_reqs": ssl.CERT_NONE})
        self.ws.connect(url, timeout=30)
        return self

    def close(self):
        if self.ws:
            self.ws.close()

    def send(self, obj):
        self.ws.send(json.dumps(obj))

    def request_footprint(self, date, session="RTH", interval="1m", symbol=None):
        self._rid += 1
        msg = {
            "request_id": self._rid,
            "command": "FOOTPRINT/V2",
            "payload": {
                "exchange": _env("GOCHARTING_EXCHANGE", "CME"),
                "segment": _env("GOCHARTING_SEGMENT", "FUTURE"),
                "symbol": symbol or _env("GOCHARTING_SYMBOL", "NQZ26"),
                "interval": interval,
                "dates": [date],
                "session": session,
            },
        }
        self.send(msg)
        return self._rid

    def iter_frames(self, timeout):
        """Yield (text_header, raw_bytes) tuples until timeout."""
        import time

        end = time.time() + timeout
        while time.time() < end:
            try:
                self.ws.settimeout(max(0.2, end - time.time()))
                msg = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                return
            if isinstance(msg, (bytes, bytearray)):
                b = bytes(msg)
                f = b[4]
                yield b[5 : 5 + f].decode("utf-8", "replace"), b[5 + f :]
            elif isinstance(msg, str):
                yield msg, None


def collect_footprint(dates, sessions=("RTH", "ETH"), symbol=None, per_date_timeout=40, attempts=3):
    """Pull footprint for each (date, session); returns {(date, session): FootPrintForDateResponse}.

    Reconnects on socket drop and re-requests the missing pairs (up to `attempts`).
    """
    wanted = [(d, s) for d in dates for s in sessions]
    results = {}
    c = None
    for attempt in range(attempts):
        missing = [k for k in wanted if k not in results]
        if not missing:
            break
        if c is None:
            c = GChartClient().connect()
        try:
            c.close()
        except Exception:
            pass
        try:
            c = GChartClient().connect()
        except Exception as e:
            print(f"connect failed: {e}")
            continue
        pending = {}
        for d, s in missing:
            pending[c.request_footprint(d, s, symbol=symbol)] = (d, s)
        try:
            for txt, body in c.iter_frames(len(pending) * per_date_timeout + 30):
                if body is None:
                    continue
                parts = txt.split("~")
                if parts[0] != "FOOTPRINT/V2":
                    continue
                r = footprint_pb2.FootPrintForDateResponse()
                r.ParseFromString(body)
                if r.is_complete and r.request and r.request.date:
                    key = (r.request.date, r.request.session)
                    results[key] = r
                    pending.pop(int(parts[2]), None)
                    if not pending:
                        break
        except Exception as e:
            print(f"attempt {attempt + 1} interrupted: {e}")
    if c is not None:
        try:
            c.close()
        except Exception:
            pass
    return results


def footprint_to_dict(resp):
    """Compact JSON-able form: per candle totals + per-level (vol, buy, sell, trades_b, trades_s)."""
    day = {
        "fp_day": {f.name: getattr(resp.fp_day, f.name) for f in resp.fp_day.DESCRIPTOR.fields},
        "candles": [],
    }
    for c in resp.candles:
        levels = {
            int(fp.level): (
                fp.buy.volume + fp.sell.volume,
                fp.buy.volume,
                fp.sell.volume,
                fp.buy.trades,
                fp.sell.trades,
            )
            for fp in c.footprint
        }
        day["candles"].append(
            {
                "t": c.date,
                "high": c.ending_summary.high,
                "low": c.ending_summary.low,
                "total": c.totals.overall.volume,
                "buy": c.totals.buy.volume,
                "sell": c.totals.sell.volume,
                "levels": levels,
            }
        )
    return day
