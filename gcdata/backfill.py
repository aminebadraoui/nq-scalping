#!/usr/bin/env python3
"""Backfill GoCharting footprint history for the configured symbol.

Reality of the vendor's retention (measured 2026-09-28 with probe_history.py):

  * FOOTPRINT/V2 accepts an explicit date list, so any retained date can be
    asked for by name — no paging needed.
  * The most recent ~10 trading sessions come back COMPLETE (1,380 ETH
    minutes). Older dates still return a response but are SPARSE: the session
    still spans 17:00..15:59 feed clock, minutes are missing in the middle
    (observed 1,200 / 954 / 804 / 664 of 1,380). Beyond ~2026-04-23 there is no
    data at all.
  * Asking for too many dates on one socket makes the server drop the
    connection, so this walks small batches and reconnects per batch.

Sparse minutes are NOT safe to analyse as if they were continuous — a gap
invents a "no break in N bars" that never happened — so every written file
records its own completeness and downstream code can filter on it.

Usage:
    python backfill.py --from 2026-04-01 --to today        # ETH + RTH
    python backfill.py --from 2026-09-08 --sessions ETH    # ETH only
    python backfill.py --from 2026-09-01 --force           # re-fetch existing
    python backfill.py --from 2026-04-01 --plan            # list dates only
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
DATA = os.path.join(HERE, "data")

EXPECTED = {"ETH": 1380, "RTH": 390}  # minutes in a complete session
BATCH = 4  # dates per socket; more than this and the server drops us


def load_env():
    env_path = os.path.join(HERE, ".env")
    if os.path.exists(env_path):
        with open(env_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    os.environ.setdefault(k, v)


def weekdays(start: dt.date, end: dt.date):
    d = start
    out = []
    while d <= end:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def existing(date: str, session: str) -> bool:
    return os.path.exists(os.path.join(DATA, f"{date}_{session}.json"))


def needs_fetch(date: str, sessions) -> bool:
    """True when any requested session is missing or stored incomplete.

    A file on disk is not enough: a session collected mid-session (or on a date
    the vendor only partly retains) lands as `partial`, and treating it as done
    would freeze that gap forever. Re-fetching is idempotent, so the nightly job
    heals partial days by itself.
    """
    for s in sessions:
        p = os.path.join(DATA, f"{date}_{s}.json")
        if not os.path.exists(p):
            return True
        try:
            with open(p) as f:
                meta = json.load(f).get("_meta") or {}
        except Exception:
            return True
        if meta.get("kind") != "complete":
            return True
    return False


def session_usable(payload: dict, session: str) -> bool:
    """A session is usable only if it is CONTIGUOUS, not merely long.

    The vendor's history comes in three shapes:
      * complete      — 17:00 CT -> 15:59 CT, no gaps (1380 min)
      * almost        — same span with ONE dropped minute (1379), or the first
                        few minutes missing (1368, one 4-min gap) — still usable
      * sparse        — minutes missing throughout (e.g. 954/1380), or two days
                        stitched with a multi-hour hole (2520 = a 301-min gap)

    A missing minute in the middle of a session fabricates structure ("no break
    in N bars"), but a missing minute at the open does not. So the rule is span
    + gap-based, not a raw count.
    """
    cs = payload.get("candles", [])
    if not cs:
        return False
    ts = sorted(c["t"] for c in cs)
    if len(ts) < 1360:
        return False
    base = int(ts[0][8:10])
    mins = [int(t[11:13]) * 60 + int(t[14:16]) + (int(t[8:10]) - base) * 1440 for t in ts]
    first = mins[0] % 1440
    last = mins[-1] % 1440
    maxgap = max((mins[i + 1] - mins[i]) for i in range(len(mins) - 1)) if len(mins) > 1 else 0
    if session == "ETH":
        return 1020 <= first <= 1035 and last == 959 and maxgap <= 5
    return first == 510 and last == 959 and maxgap <= 5  # RTH 08:30 -> 15:59


def write_dataset(date: str, session: str, payload: dict) -> str:
    """Persist one dataset, stamping its completeness. Returns the kind."""
    n = len(payload.get("candles", []))
    exp = EXPECTED.get(session, 0)
    if n == 0:
        kind = "empty"
    elif session_usable(payload, session):
        kind = "complete"
    else:
        kind = "partial"
    payload["_meta"] = {
        "session": session,
        "candles": n,
        "expected": exp,
        "completeness": round(n / exp, 3) if exp else None,
        "kind": kind,
        "collected_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "gocharting FOOTPRINT/V2",
        "symbol": os.environ.get("GOCHARTING_SYMBOL", "?"),
        "contiguous": session_usable(payload, session),
    }
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, f"{date}_{session}.json")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)  # atomic: never leave a half-written dataset behind
    print(f"  saved {date}_{session}  {n:>4}/{exp}  {kind}", flush=True)
    return kind


def fetch(dates, sessions, per_request_timeout=18, attempts=2, on_result=None, symbol=None):
    """Walk the dates in small batches, calling on_result(date, session, payload).

    Results are handed to the caller as soon as a batch lands rather than being
    accumulated for the whole run: a backfill of a hundred-plus sessions takes
    tens of minutes, and losing all of it to one dropped socket is unacceptable.
    """
    from client import GChartClient, footprint_pb2, footprint_to_dict

    seen = set()
    for i in range(0, len(dates), BATCH):
        chunk = dates[i : i + BATCH]
        wanted = [(d, s) for d in chunk for s in sessions]
        for attempt in range(attempts):
            missing = [k for k in wanted if k not in seen]
            if not missing:
                break
            try:
                c = GChartClient().connect()
            except Exception as e:
                print(f"    connect failed: {e}", flush=True)
                continue
            try:
                for d, s in missing:
                    c.request_footprint(d, s, symbol=symbol)
                for txt, body in c.iter_frames(len(missing) * per_request_timeout + 20):
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
                        key = (r.request.date, r.request.session)
                        if key in seen:
                            continue
                        seen.add(key)
                        if on_result:
                            on_result(key[0], key[1], footprint_to_dict(r))
            except Exception as e:
                print(f"    socket dropped mid-batch ({type(e).__name__})", flush=True)
            finally:
                try:
                    c.close()
                except Exception:
                    pass
        got = sum(1 for k in seen if k[0] in chunk)
        print(f"  batch {chunk[0]}..{chunk[-1]}: {got}/{len(wanted)} returned", flush=True)
    return seen


def main():
    load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default="2026-04-01")
    ap.add_argument("--to", dest="end", default=dt.date.today().isoformat())
    ap.add_argument("--sessions", nargs="*", default=["ETH", "RTH"])
    ap.add_argument("--force", action="store_true", help="re-fetch dates already on disk")
    ap.add_argument("--symbol", default=os.environ.get("GOCHARTING_SYMBOL", "NQZ26"), help="contract symbol, e.g. NQU26")
    ap.add_argument("--plan", action="store_true", help="print the date list and exit")
    args = ap.parse_args()

    end = dt.date.today().isoformat() if args.end == "today" else args.end
    dates = weekdays(dt.date.fromisoformat(args.start), dt.date.fromisoformat(end))
    todo = [d for d in dates if args.force or needs_fetch(d, args.sessions)]
    print(
        f"backfill {args.start} .. {end}: {len(dates)} weekdays, "
        f"{len(todo)} need fetching ({len(dates) - len(todo)} already on disk)"
    )
    if args.plan:
        for d in todo:
            print("  ", d)
        return 0
    if not todo:
        print("nothing to do")
        return 0

    os.makedirs(DATA, exist_ok=True)
    written = {"complete": 0, "partial": 0, "empty": 0}

    def on_result(date, session, payload):
        written[write_dataset(date, session, payload)] += 1

    os.environ["GOCHARTING_SYMBOL"] = args.symbol
    seen = fetch(todo, args.sessions, on_result=on_result, symbol=args.symbol)

    missing = [f"{d}_{s}" for d in todo for s in args.sessions if (d, s) not in seen]
    print(
        f"\nwrote {sum(written.values())} datasets — {written['complete']} complete, "
        f"{written['partial']} partial, {written['empty']} empty"
    )
    if missing:
        print(
            f"{len(missing)} returned nothing (no data retained that far back): "
            f"{missing[:6]}{' ...' if len(missing) > 6 else ''}"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
