#!/usr/bin/env python3
"""Focused retention re-probe: correct the MLK-Day sampling artifact and
find the exact oldest-available boundary.

The first probe sampled H contracts ~60 days before expiry, which lands on
the 3rd Monday of January — MLK Day, a market holiday, for most years. This
re-probes H contracts on adjacent non-holiday dates and walks the boundary
around early 2024 one date at a time per contract.
"""
import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
os.environ.setdefault("GOCHARTING_SYMBOL", "NQZ26")


from envfile import load_env  # noqa: E402  (shared gcdata/.env loader)


def probe(pairs, per_date_timeout=14, batch=4):
    from client import GChartClient, footprint_pb2

    out = {}
    for i in range(0, len(pairs), batch):
        chunk = pairs[i : i + batch]
        try:
            c = GChartClient().connect()
        except Exception as e:
            print(f"  batch connect failed: {e}", flush=True)
            continue
        try:
            for sym, d in chunk:
                c.request_footprint(d, "ETH", symbol=sym)
            for txt, body in c.iter_frames(len(chunk) * per_date_timeout + 15):
                if body is None:
                    continue
                parts = txt.split("~")
                if parts[0] != "FOOTPRINT/V2":
                    continue
                r = footprint_pb2.FootPrintForDateResponse()
                try:
                    r.ParseFromString(body)
                except Exception:
                    continue
                if r.is_complete and r.request and r.request.date:
                    out[r.request.date] = len(r.candles)
        except Exception:
            pass
        finally:
            try:
                c.close()
            except Exception:
                pass
    return out


def main():
    load_env()
    pairs = [
        # H contracts on NON-holiday mid-tenure dates (day after the MLK Monday)
        ("NQH24", "2024-01-16"),
        ("NQH24", "2024-02-20"),
        ("NQH25", "2025-01-21"),
        ("NQH25", "2025-02-18"),
        ("NQH26", "2026-01-20"),
        ("NQH26", "2026-02-17"),
        # boundary hunt: earliest months of the first-known-complete contract
        ("NQM24", "2024-03-18"),
        ("NQM24", "2024-04-02"),
        ("NQM24", "2024-05-01"),
        # is ANY early-2024 date still served by any contract?
        ("NQH24", "2024-03-01"),
        ("NQZ23", "2023-12-20"),
        # does the vendor serve data for contracts outside their own tenure
        # (e.g. NQZ25 during NQU24 tenure) — decides whether tenure matters
        ("NQZ25", "2024-07-22"),
    ]
    print(f"focused re-probe — {len(pairs)} (symbol, date) pairs", flush=True)
    got = probe(pairs)
    for sym, d in pairs:
        n = got.get(d)
        status = "NO DATA" if n is None else (f"{n} min COMPLETE" if n >= 1375 else f"sparse {n}")
        print(f"  {sym:<6} {d}  {status}", flush=True)


if __name__ == "__main__":
    main()
