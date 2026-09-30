#!/usr/bin/env python3
"""Probe how much history GoCharting will actually serve for the configured symbol.

Two independent limits matter, and they are different:

  * FOOTPRINT/V2 takes an explicit list of dates, so any date it still retains
    can be asked for by name. This probe binary-searches the oldest retained
    footprint date.
  * TS/V2 with hint="max=true" returns a sliding 3-trading-day window, and each
    additional request on the SAME socket pages one window further back. This
    probe walks windows backwards until the vendor stops returning bars.

Usage:
    python probe_history.py --footprint          # oldest retained footprint date
    python probe_history.py --ohlc --windows 40  # walk OHLC windows backwards
    python probe_history.py --both
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)


def load_env():
    env_path = os.path.join(HERE, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


def probe_footprint(dates, batch=4, per_date_timeout=14, quiet=False):
    """Return {date: candle_count} for the dates that came back with data.

    Small batches on a fresh socket each time: asking for ~30 dates at once makes
    the server drop the connection outright, and a dropped socket tells us
    nothing about whether the dates had data.
    """
    from client import GChartClient, footprint_pb2

    out = {}
    for i in range(0, len(dates), batch):
        chunk = dates[i : i + batch]
        try:
            c = GChartClient().connect()
        except Exception as e:
            if not quiet:
                print(f"  batch {chunk[0]}..{chunk[-1]}: connect failed ({e})")
            continue
        try:
            for d in chunk:
                c.request_footprint(d, "ETH")
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
                    cs = r.candles
                    if cs:
                        ts = [c.date for c in cs]
                        out[r.request.date] = {
                            "n": len(cs),
                            "first": min(ts),
                            "last": max(ts),
                        }
                    else:
                        out[r.request.date] = {"n": 0, "first": "-", "last": "-"}
        except Exception:
            pass  # socket dropped mid-batch; whatever arrived is already recorded
        finally:
            try:
                c.close()
            except Exception:
                pass
    return out


def probe_ohlc(windows=40, per_window_timeout=25):
    """Page OHLC windows backwards on one socket; return [(date, bars)] seen."""
    from client import GChartClient, ohlc_bars_pb2

    c = GChartClient().connect()
    seen = {}
    order = []
    try:
        for w in range(windows):
            c._rid += 1
            rid = c._rid
            c.send(
                {
                    "request_id": rid,
                    "command": "TS/V2",
                    "payload": {
                        "exchange": os.environ.get("GOCHARTING_EXCHANGE", "CME"),
                        "segment": os.environ.get("GOCHARTING_SEGMENT", "FUTURE"),
                        "symbol": os.environ.get("GOCHARTING_SYMBOL", "NQZ26"),
                        "interval": "1m",
                        "hint": "max=true",
                    },
                }
            )
            got = 0
            for txt, body in c.iter_frames(per_window_timeout):
                if body is None:
                    continue
                parts = txt.split("~")
                if parts[0] not in ("OHLCV/V2", "TS/V2"):
                    continue
                r = ohlc_bars_pb2.OHLCBarsResponse()
                try:
                    r.ParseFromString(body)
                except Exception:
                    continue
                for b in r.bars:
                    day = b.date[:10]
                    seen[day] = seen.get(day, 0) + 1
                    if day not in order:
                        order.append(day)
                got += len(r.bars)
            dates = sorted(seen)
            oldest = dates[0] if dates else "-"
            print(
                f"  window {w + 1:>3}: {got:>5} bars   oldest={oldest}   "
                f"days={len(seen)}   total_bars={sum(seen.values())}",
                flush=True,
            )
            if got == 0:
                print("  -> vendor returned no bars for this window; history ends here")
                break
    finally:
        try:
            c.close()
        except Exception:
            pass
    return seen


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--footprint", action="store_true")
    ap.add_argument("--ohlc", action="store_true")
    ap.add_argument("--both", action="store_true")
    ap.add_argument("--windows", type=int, default=40)
    ap.add_argument("--start", default="2026-09-24", help="newest date to test")
    ap.add_argument("--step", type=int, default=7)
    ap.add_argument("--span", type=int, default=400, help="days back to sample")
    args = ap.parse_args()
    do_fp = args.footprint or args.both
    do_ohlc = args.ohlc or args.both
    if not (do_fp or do_ohlc):
        ap.error("pass --footprint, --ohlc or --both")

    if do_fp:
        start = dt.date.fromisoformat(args.start)
        dates = [(start - dt.timedelta(days=i)).isoformat() for i in range(0, args.span, args.step)]
        print(f"FOOTPRINT/V2 depth probe — {len(dates)} dates sampled, newest first")
        got = probe_footprint(dates)
        for d in dates:
            g = got.get(d)
            if g:
                print(f"  {d}  {g['n']:>5} candles   {str(g['first'])[11:16]} .. {str(g['last'])[11:16]}")
            else:
                print(f"  {d}  no data")
        have = [d for d in dates if got.get(d) and got[d]["n"]]
        print(f"  -> {len(have)}/{len(dates)} sampled dates returned data; oldest with data: {min(have) if have else 'none'}")

    if do_ohlc:
        print(f"\nTS/V2 depth probe — paging back up to {args.windows} windows")
        seen = probe_ohlc(args.windows)
        if seen:
            dates = sorted(seen)
            print(f"  -> {len(dates)} trading days, {sum(seen.values())} bars, {dates[0]} .. {dates[-1]}")


if __name__ == "__main__":
    main()
