#!/usr/bin/env python3
"""Backfill every NQ quarterly contract's front-month tenure, oldest first.

The rollover problem: FOOTPRINT/V2 serves per-CONTRACT history, and each
contract comes back complete only for roughly its own front-month tenure.
Asking today's contract for 2019 returns nothing; asking NQH19 for 2019
works. So a long-range backfill must walk the quarterly calendar and ask
each date of the contract that was the front month on that date.

contracts.py generates that calendar (expiry = 3rd Friday of H/M/U/Z, the
same convention as the old hardcoded table); this driver walks it oldest
first so that where two contracts overlap around a roll, the older (the
true front month) wins and complete files are never overwritten.

Usage:
    .venv/bin/python backfill_tenures.py [--from 2017-03-01] [--to today] \
        [--sessions ETH RTH] [--force] [--plan] [--sleep 2]
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backfill  # noqa: E402  (load_env, weekdays, needs_fetch, fetch, write_dataset)
from contracts import tenures  # noqa: E402


def main():
    backfill.load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2017-03-01")
    ap.add_argument("--to", dest="end", default=dt.date.today().isoformat())
    ap.add_argument("--sessions", nargs="*", default=["ETH", "RTH"])
    ap.add_argument("--force", action="store_true", help="re-fetch dates already complete on disk")
    ap.add_argument("--plan", action="store_true", help="print the contract calendar and exit")
    ap.add_argument("--sleep", type=float, default=2.0, help="pause between contracts (s)")
    args = ap.parse_args()

    end = dt.date.today().isoformat() if args.end == "today" else args.end
    rows = tenures(args.start, end)
    print(f"contract calendar {args.start} .. {end}: {len(rows)} tenures")
    if args.plan:
        for sym, fr, to in rows:
            print(f"  {sym:<6} {fr} .. {to}")
        return 0

    grand = {"complete": 0, "partial": 0, "empty": 0, "miss": 0}
    for n, (sym, fr, to) in enumerate(rows, 1):
        dates = backfill.weekdays(fr, to)
        todo = [d for d in dates if args.force or backfill.needs_fetch(d, args.sessions)]
        if not todo:
            print(f"[{n}/{len(rows)}] {sym} {fr}..{to}: {len(dates)} dates all complete on disk", flush=True)
            continue
        print(
            f"[{n}/{len(rows)}] {sym} {fr}..{to}: {len(dates)} weekdays, "
            f"{len(todo)} to fetch  ({dt.datetime.now():%H:%M:%S})",
            flush=True,
        )
        written = {"complete": 0, "partial": 0, "empty": 0}

        def on_result(d, s, p):
            kind = backfill.write_dataset(d, s, p)
            written[kind] = written.get(kind, 0) + 1

        seen = backfill.fetch(todo, args.sessions, symbol=sym, on_result=on_result)
        miss = sum(1 for d in todo for s in args.sessions if (d, s) not in seen)
        for k, v in written.items():
            grand[k] += v
        grand["miss"] += miss
        print(
            f"  -> {sym}: {written['complete']} complete, {written['partial']} partial, "
            f"{written['empty']} empty, {miss} missing",
            flush=True,
        )
        if args.sleep:
            time.sleep(args.sleep)

    print(
        f"\nTOTAL — {grand['complete']} complete · {grand['partial']} partial · "
        f"{grand['empty']} empty · {grand['miss']} missing",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
