#!/usr/bin/env python3
"""Backfill CME futures footprint history for ANY underlying (default 6E euro FX; same
quarterly H/M/U/Z cycle via contracts.py). Copy of backfill_es.py parametrised by
UNDERLYING (env FX_UNDERLYING or --underlying). Output: gcdata/data/<und>/.

Original ES notes:
Backfill ES futures footprint history from GoCharting, mirroring the NQ
archive: every date the NQ store holds, both sessions (ETH + RTH), asked of
the ES contract that was the front month on that date (same H/M/U/Z quarterly
cycle as NQ — contracts.py with the ES prefix).

Storage is deliberately separate from the NQ store so nothing downstream is
disturbed: files land in gcdata/data/es/<date>_<session>.json (the NQ store,
the web manifest, and r2_sync.py only look at the data/ root, data/ohlc and
data/options). ES files get their own manifest on R2 via scripts/es_r2_sync.py.

The date list comes from the NQ R2 manifest (usable ETH sessions) — "as many
dates as we have for NQ", no more, no less.

Usage:
    .venv/bin/python backfill_es.py --plan            # date/symbol calendar only
    .venv/bin/python backfill_es.py                   # full walk, skips complete files
    .venv/bin/python backfill_es.py --from 2026-09-25 --to today   # recent window
    .venv/bin/python backfill_es.py --inspect 2026-10-01          # fetch one date, print spans, no writes
    .venv/bin/python backfill_es.py --force           # re-fetch files already complete
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import backfill  # noqa: E402  (load_env, weekdays, fetch, session_usable)
from contracts import tenures  # noqa: E402

UNDERLYING = os.environ.get("FX_UNDERLYING", "6E")
for _i, _a in enumerate(sys.argv):
    if _a == "--underlying" and _i + 1 < len(sys.argv):
        UNDERLYING = sys.argv[_i + 1]
ES_DATA = os.path.join(HERE, "data", UNDERLYING.lower())
PUBLIC_MANIFEST = "https://pub-d68008dba02c4ad190e9814f6c41cbef.r2.dev/manifest.json"

# ES session shapes. The vendor's NQ sessions run 17:00 CT -> 15:59 CT (1380
# min ETH window) with RTH 08:30 -> 14:59 CT (390 min). ES RTH closes later
# (16:15 ET vs 16:00 ET), so these are corrected from observed data — the
# --inspect run prints the real spans; adjust these two maps to match.
ES_EXPECTED = {"ETH": 1380, "RTH": 390}


def nq_manifest_dates() -> set[str]:
    url = os.environ.get("GC_REMOTE_URL", "").rstrip("/") + "/manifest.json"
    if not url.startswith("https://"):
        url = PUBLIC_MANIFEST
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        m = json.loads(r.read())
    return {f["date"] for f in m.get("files", []) if f.get("session") == "ETH" and f.get("usable")}


def es_path(date: str, session: str) -> str:
    return os.path.join(ES_DATA, f"{date}_{session}.json")


def es_needs_fetch(date: str, sessions) -> bool:
    """True when any requested ES session is missing or stored incomplete."""
    for s in sessions:
        p = es_path(date, s)
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


def write_es_dataset(date: str, session: str, payload: dict, symbol: str) -> str:
    """Persist one ES dataset under data/es/, stamping completeness."""
    n = len(payload.get("candles", []))
    exp = ES_EXPECTED.get(session, 0)
    contiguous = backfill.session_usable(payload, session)
    if n == 0:
        kind = "empty"
    elif contiguous:
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
        "symbol": symbol,
        "underlying": UNDERLYING,
        "contiguous": contiguous,
    }
    os.makedirs(ES_DATA, exist_ok=True)
    path = es_path(date, session)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, path)
    print(f"  saved {UNDERLYING}/{date}_{session}  {n:>4}/{exp}  {kind}  ({symbol})", flush=True)
    return kind


def inspect(date: str) -> int:
    """Fetch one date's ETH + RTH with the front-month ES contract and print
    the raw session spans (first/last feed-clock minutes) — the ground truth
    for ES_EXPECTED and the usability windows. Writes nothing."""
    from client import GChartClient, footprint_pb2, footprint_to_dict

    sym = None
    for s, fr, to in tenures(date, date, prefix=UNDERLYING):
        sym = s
    print(f"inspect {date} with {sym}")
    results = {}
    c = GChartClient().connect()
    try:
        for s in ("ETH", "RTH"):
            c.request_footprint(date, s, symbol=sym)
        for txt, body in c.iter_frames(120):
            if body is None:
                continue
            parts = txt.split("~")
            if parts[0] != "FOOTPRINT/V2":
                continue
            r = footprint_pb2.FootPrintForDateResponse()
            r.ParseFromString(body)
            if r.is_complete and r.request and r.request.date:
                results[r.request.session] = footprint_to_dict(r)
    finally:
        c.close()
    for s in ("ETH", "RTH"):
        d = results.get(s)
        if not d or not d["candles"]:
            print(f"  {s}: NO DATA")
            continue
        ts = [x["t"] for x in d["candles"]]
        first, last = min(ts), max(ts)
        # feed clock minutes-of-day
        f = int(first[11:13]) * 60 + int(first[14:16])
        l = int(last[11:13]) * 60 + int(last[14:16])
        gaps = [int(ts[i + 1][11:13]) * 60 + int(ts[i + 1][14:16]) - (int(ts[i][11:13]) * 60 + int(ts[i][14:16])) for i in range(len(ts) - 1)]
        print(f"  {s}: {len(ts)} candles  first={first} ({f} min-of-day)  last={last} ({l} min-of-day)  maxgap={max(gaps) if gaps else 0}")
    return 0


def main():
    backfill.load_env()
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="start", default=None, help="default: the NQ archive start")
    ap.add_argument("--to", dest="end", default=dt.date.today().isoformat())
    ap.add_argument("--plan", action="store_true", help="print the date/symbol calendar and exit")
    ap.add_argument("--force", action="store_true", help="re-fetch dates already complete on disk")
    ap.add_argument("--sleep", type=float, default=2.0, help="pause between contracts (s)")
    ap.add_argument("--underlying", default=UNDERLYING, help="CME root, e.g. 6E, 6J, 6B, GC, CL")
    ap.add_argument("--inspect", metavar="DATE", help="fetch one date, print session spans, no writes")
    args = ap.parse_args()

    if args.inspect:
        return inspect(args.inspect)

    nq_dates = sorted(nq_manifest_dates())
    start = args.start or nq_dates[0]
    end = dt.date.today().isoformat() if args.end == "today" else args.end
    target = {d for d in nq_dates if start <= d <= end}
    rows = tenures(start, end, prefix=UNDERLYING)
    print(
        f"{UNDERLYING} backfill: NQ archive holds {len(nq_dates)} usable sessions "
        f"({nq_dates[0]} .. {nq_dates[-1]}); window {start} .. {end} -> {len(target)} dates "
        f"across {len(rows)} ES tenures"
    )
    if args.plan:
        for sym, fr, to in rows:
            hits = [d for d in sorted(target) if fr <= dt.date.fromisoformat(d) <= to]
            print(f"  {sym:<6} {fr} .. {to}  ({len(hits)} dates)")
        return 0

    grand = {"complete": 0, "partial": 0, "empty": 0, "miss": 0}
    for n, (sym, fr, to) in enumerate(rows, 1):
        dates = [d for d in sorted(target) if fr <= dt.date.fromisoformat(d) <= to]
        todo = [d for d in dates if args.force or es_needs_fetch(d, ("ETH", "RTH"))]
        if not todo:
            print(f"[{n}/{len(rows)}] {sym} {fr}..{to}: {len(dates)} dates all complete", flush=True)
            continue
        print(
            f"[{n}/{len(rows)}] {sym} {fr}..{to}: {len(dates)} dates, {len(todo)} to fetch  ({dt.datetime.now():%H:%M:%S})",
            flush=True,
        )
        written = {"complete": 0, "partial": 0, "empty": 0}

        def on_result(d, s, p):
            kind = write_es_dataset(d, s, p, sym)
            written[kind] = written.get(kind, 0) + 1

        seen = backfill.fetch(todo, ("ETH", "RTH"), symbol=sym, on_result=on_result)
        miss = sum(1 for d in todo for s in ("ETH", "RTH") if (d, s) not in seen)
        for k, v in written.items():
            grand[k] += v
        grand["miss"] += miss

        # Roll-week fallback: the last days of a tenure can come back sparse
        # under the expiring contract (same behaviour the NQ archive needed
        # refetch_rollover.py for). Retry those dates under the NEXT contract.
        if n < len(rows):
            next_sym = rows[n][0]
            roll_start = to - dt.timedelta(days=10)
            stale = [
                d for d in todo
                if roll_start <= dt.date.fromisoformat(d) and es_needs_fetch(d, ("ETH", "RTH"))
            ]
            if stale:
                print(f"  -> roll window: retrying {len(stale)} sparse dates under {next_sym}", flush=True)
                for d in stale:
                    def on_fallback(dd, ss, pp):
                        kind = write_es_dataset(dd, ss, pp, next_sym)
                        written[kind] = written.get(kind, 0) + 1
                    backfill.fetch([d], ("ETH", "RTH"), symbol=next_sym, on_result=on_fallback)
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
