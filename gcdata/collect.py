#!/usr/bin/env python3
"""Collect GoCharting NQ footprint data and emit the daily level sheet.

Usage:
  python collect.py --days 6          # pull the last 6 calendar days (RTH+ETH)
  python collect.py --level-sheet     # compute P0-P5 (P0 = most recent) + LVNs and print

Environment: see .env.example. Personal use only; undocumented transport.
"""
import argparse
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


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
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=0, help="calendar days back to collect")
    ap.add_argument("--dates", nargs="*", default=[], help="explicit dates YYYY-MM-DD")
    ap.add_argument("--level-sheet", action="store_true")
    ap.add_argument("--today", default=datetime.date.today().isoformat())
    args = ap.parse_args()

    data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
    os.makedirs(data_dir, exist_ok=True)

    if args.level_sheet:
        import profiles

        sheet = profiles.build_level_sheet(data_dir, args.today)
        print(json.dumps(sheet, indent=2))
        return

    from client import GChartClient, collect_footprint, footprint_to_dict

    if args.dates:
        dates = args.dates
    elif args.days:
        t = datetime.date.today()
        dates = []
        i = 0
        while len(dates) < args.days and i < args.days * 2:
            d = t - datetime.timedelta(days=i)
            if d.weekday() < 5:  # skip weekends
                dates.append(d.isoformat())
            i += 1
    else:
        ap.error("provide --days or --dates")

    print("collecting", dates)
    results = collect_footprint(dates)
    for (d, s), resp in results.items():
        path = os.path.join(data_dir, f"{d}_{s}.json")
        with open(path, "w") as f:
            json.dump(footprint_to_dict(resp), f)
        print("saved", path, len(resp.candles), "candles")
    print("done:", len(results), "datasets")


if __name__ == "__main__":
    main()
