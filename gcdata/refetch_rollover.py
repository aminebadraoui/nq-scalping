#!/usr/bin/env python3
"""Targeted re-fetch of near-rollover sessions under the CORRECT (new) contract.

The quarterly backfill walks fixed, non-overlapping tenures, but NQ volume rolls
to the new contract ~1 week before the 3rd-Friday boundary. The vendor thins the
old contract's data once it stops being the liquid front month, so the last ~1
week of each tenure came back sparse. Re-fetching those dates under the NEXT
contract recovers them to full 1380/390-minute contiguity.

Usage:  python refetch_rollover.py [--dry-run]
"""
from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# date -> correct (new front-month) contract to fetch it under
TARGETS = [
    # NQH24 roll -> NQM24
    ("2024-03-11", "NQM24"), ("2024-03-13", "NQM24"), ("2024-03-14", "NQM24"), ("2024-03-15", "NQM24"),
    # NQM24 roll -> NQU24
    ("2024-06-11", "NQU24"), ("2024-06-14", "NQU24"), ("2024-06-20", "NQU24"), ("2024-06-21", "NQU24"),
    # NQU24 roll -> NQZ24
    ("2024-09-20", "NQZ24"),
    # NQZ24 roll -> NQH25
    ("2024-12-19", "NQH25"), ("2024-12-20", "NQH25"),
    # NQH25 roll -> NQM25
    ("2025-03-21", "NQM25"),
    # NQM25 roll -> NQU25
    ("2025-06-12", "NQU25"), ("2025-06-16", "NQU25"), ("2025-06-18", "NQU25"), ("2025-06-20", "NQU25"),
    # NQU25 roll -> NQZ25
    ("2025-09-17", "NQZ25"), ("2025-09-19", "NQZ25"),
    # NQZ25 roll -> NQH26
    ("2025-12-17", "NQH26"), ("2025-12-18", "NQH26"), ("2025-12-19", "NQH26"),
    # NQH26 roll -> NQM26
    ("2026-03-06", "NQM26"), ("2026-03-09", "NQM26"), ("2026-03-16", "NQM26"),
    ("2026-03-18", "NQM26"), ("2026-03-19", "NQM26"), ("2026-03-20", "NQM26"),
    # NQM26 roll -> NQU26
    ("2026-06-17", "NQU26"), ("2026-06-18", "NQU26"),
]


def load_env():
    if os.path.exists(os.path.join(HERE, ".env")):
        with open(os.path.join(HERE, ".env")) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


def fetch(date: str, symbol: str):
    """Fetch ETH + RTH for one date under one symbol, over one socket."""
    from client import GChartClient, footprint_pb2, footprint_to_dict

    out = {}
    c = GChartClient().connect()
    try:
        for sess in ("ETH", "RTH"):
            c.request_footprint(date, sess, symbol=symbol)
        import time
        end = time.time() + 60
        while time.time() < end and len(out) < 2:
            for txt, body in c.iter_frames(10):
                if body is None:
                    continue
                if txt.split("~")[0] != "FOOTPRINT/V2":
                    continue
                r = footprint_pb2.FootPrintForDateResponse()
                try:
                    r.ParseFromString(body)
                except Exception:
                    continue
                if r.request and r.request.date == date:
                    out[r.request.session] = footprint_to_dict(r)
    finally:
        try:
            c.close()
        except Exception:
            pass
    return out


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    import backfill

    recovered = 0
    for date, sym in TARGETS:
        os.environ["GOCHARTING_SYMBOL"] = sym
        got = fetch(date, sym)
        line = []
        for sess in ("ETH", "RTH"):
            payload = got.get(sess)
            if not payload:
                line.append(f"{sess}: no-response")
                continue
            n = len(payload.get("candles", []))
            usable = backfill.session_usable(payload, sess)
            line.append(f"{sess}:{n}{'✓' if usable else '✗'}")
            if usable and not args.dry_run:
                backfill.write_dataset(date, sess, payload)
        print(f"{date} -> {sym}  " + "  ".join(line), flush=True)
        if any("✓" in x for x in line):
            recovered += 1
    print(f"\ndone — {recovered}/{len(TARGETS)} dates recovered")


if __name__ == "__main__":
    main()
