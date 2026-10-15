"""One-off scratch probe (not committed): pull the IN-PROGRESS 2026-10-15
ETH session from the vendor even though is_complete=0 — the veto-bug
morning replay needs this window. Writes data/2026-10-15_ETH.json."""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from client import GChartClient, footprint_to_dict  # noqa: E402
import footprint_pb2  # noqa: E402


def load_env():
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


def main():
    load_env()
    c = GChartClient().connect()
    rid = c.request_footprint("2026-10-15", "ETH")
    try:
        for txt, body in c.iter_frames(150):
            if body is None:
                continue
            parts = txt.split("~")
            if parts[0] != "FOOTPRINT/V2":
                continue
            r = footprint_pb2.FootPrintForDateResponse()
            r.ParseFromString(body)
            print("frame", parts[1:4], "complete=", r.is_complete, "candles=", len(r.candles))
            if r.request and r.request.date == "2026-10-15" and r.request.session == "ETH" and len(r.candles) > 0:
                out = footprint_to_dict(r)
                p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "2026-10-15_ETH.json")
                with open(p, "w") as f:
                    json.dump(out, f)
                print("saved", p, len(out["candles"]), "candles")
                return
        print("no usable frame for 2026-10-15 ETH")
    finally:
        c.close()


if __name__ == "__main__":
    main()
