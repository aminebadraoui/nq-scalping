#!/usr/bin/env python3
"""Probe how far back GoCharting retains FOOTPRINT/V2 data PER CONTRACT.

backfill_contracts.sh recovered Dec-2023+ by requesting each quarterly
contract's front-month tenure (NQH24, NQM24, ...). The open question for the
10-year goal: how far back do EXPIRED contracts still serve complete data?

This samples one mid-tenure date per quarterly contract from NQH17 (2017)
to the current front month and reports candle counts per (symbol, date).
Batches of 4 dates per socket, one reconnect per batch — same gentleness
rules as backfill.py.

Usage:
    .venv/bin/python probe_tenures.py [--start NQH17] [--end NQZ26]
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from contracts import tenures  # noqa: E402

EXPECTED_ETH = 1380
BATCH = 4


from envfile import load_env  # noqa: E402  (shared gcdata/.env loader)


def sample_dates():
    """One mid-tenure weekday per contract, oldest first.

    A fresh tenure row starts the trading day after the previous expiry, so
    sampling ~40 trading days in gives a date that is (a) inside the tenure
    and (b) safely past the roll week, when both contracts still trade.
    """
    rows = tenures("2017-03-01", dt.date.today() + dt.timedelta(days=40))
    out = []
    for sym, fr, to in rows:
        d = fr + dt.timedelta(days=40)
        if d > to:  # short first tenure in range — clamp
            d = to
        while d.weekday() >= 5:
            d += dt.timedelta(days=1)
        out.append((sym, d.isoformat(), to.isoformat()))
    return out


def probe(pairs, per_date_timeout=14):
    from client import GChartClient, footprint_pb2

    out = {}
    for i in range(0, len(pairs), BATCH):
        chunk = pairs[i : i + BATCH]
        try:
            c = GChartClient().connect()
        except Exception as e:
            print(f"  batch connect failed: {e}", flush=True)
            continue
        try:
            for sym, d, _exp in chunk:
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
                    n = len(r.candles)
                    out[(r.request.date)] = n
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="NQH17")
    ap.add_argument("--end", default="NQZ26")
    args = ap.parse_args()

    pairs = sample_dates()
    if args.start != "NQH17" or args.end != "NQZ26":
        pairs = [(s, d, e) for s, d, e in pairs if args.start <= s <= args.end]
    print(f"per-contract retention probe — {len(pairs)} contracts, one mid-tenure date each", flush=True)
    got = probe(pairs)
    ok = 0
    for sym, d, exp in pairs:
        n = got.get(d)
        if n is None:
            print(f"  {sym:<6} {d}  expiry {exp}   NO DATA", flush=True)
        else:
            status = "COMPLETE" if n >= EXPECTED_ETH - 5 else f"sparse {n}"
            if n >= EXPECTED_ETH - 5:
                ok += 1
            print(f"  {sym:<6} {d}  expiry {exp}   {n} min  {status}", flush=True)
    print(f"-> {ok}/{len(pairs)} sampled contracts still serve complete ETH sessions", flush=True)


if __name__ == "__main__":
    main()
