#!/usr/bin/env python3
"""Audit + repair the local gcdata/data JSON store.

The canonical store layout:
  data/<date>_ETH.json   full Globex session: prior feed-day 17:00 CT -> date 15:59 CT (1380 min)
  data/<date>_RTH.json   cash session 08:30 -> 14:59 CT (390 min)
  data/ohlc/<date>.json  vendor OHLC twin of the RTH session (390 one-minute bars)

Known vendor quirks this script handles:
  1. Holiday weeks come back MERGED (a ~2520-minute payload spanning three
     feed days). When the canonical 1380-minute window inside the merged file
     is complete and contiguous, it is trimmed out and re-stamped complete.
     Otherwise the file stays partial (excluded from analysis, like the
     pipeline already marks it).
  2. OHLC twins collected while a session was still open are partial junk
     (<390 bars) and can disagree with the footprint file. With --repair they
     are deleted (analysis falls back to footprint-derived candles); the
     nightly collect_ohlc re-collects recent dates after the close.

Usage:
  scripts/repair_data.py            # audit only, prints the report
  scripts/repair_data.py --repair   # audit + apply fixes (backs up rewrites)
"""
import argparse
import collections
import glob
import json
import os
import shutil
import sys
from datetime import datetime, timedelta

DATA = os.path.join(os.path.dirname(__file__), "..", "gcdata", "data")
BACKUP = os.path.join(DATA, "repair_backup")
ETH_MIN = 1380
RTH_MIN = 390
WEEKDAYS = {0, 1, 2, 3, 4}


def parse_ts(t: str) -> datetime:
    return datetime.fromisoformat(t)


def contiguous(ts: list[str]) -> bool:
    if not ts:
        return False
    dt = [parse_ts(t) for t in sorted(ts)]
    return all((b - a) == timedelta(minutes=1) for a, b in zip(dt, dt[1:]))


def canonical_window(date: str):
    """[date-1 17:00, date 15:59] feed clock (CT)."""
    d = datetime.strptime(date, "%Y-%m-%d")
    start = d - timedelta(days=1)
    return f"{start:%Y-%m-%d}T17:00:00", f"{d:%Y-%m-%d}T15:59:00"


def load(path: str):
    with open(path) as f:
        return json.load(f)


def backup(path: str):
    os.makedirs(BACKUP, exist_ok=True)
    shutil.copy2(path, os.path.join(BACKUP, os.path.basename(path)))


def repair_eth(date: str) -> str:
    """Trim a merged holiday payload to the canonical window when it is whole.
    Returns 'complete', 'partial' or 'skip'."""
    path = os.path.join(DATA, f"{date}_ETH.json")
    j = load(path)
    cs = j.get("candles", [])
    n = len(cs)
    if n <= ETH_MIN:
        return "skip"
    lo, hi = canonical_window(date)
    win = [c for c in cs if lo <= c["t"] <= hi]
    if len(win) != ETH_MIN or not contiguous([c["t"] for c in win]):
        return "partial"
    backup(path)
    j["candles"] = sorted(win, key=lambda c: c["t"])
    j["_meta"] = {
        "session": "ETH",
        "candles": ETH_MIN,
        "expected": ETH_MIN,
        "completeness": 1.0,
        "kind": "complete",
        "contiguous": True,
        "repaired_at": datetime.now().astimezone().isoformat(),
        "source": j.get("_meta", {}).get("source", "gocharting FOOTPRINT/V2"),
        "symbol": j.get("_meta", {}).get("symbol", "?"),
    }
    with open(path, "w") as f:
        json.dump(j, f, separators=(",", ":"))
    return "complete"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repair", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(DATA):
        print(f"no data dir at {DATA}", file=sys.stderr)
        return 1

    today = datetime.now().strftime("%Y-%m-%d")
    rows: list[str] = []
    problems = 0

    # ---- ETH sessions ------------------------------------------------------
    eth_files = sorted(glob.glob(os.path.join(DATA, "*_ETH.json")))
    counts = collections.Counter()
    merged: list[str] = []
    for path in eth_files:
        date = os.path.basename(path)[:10]
        try:
            n = len(load(path).get("candles", []))
        except Exception:
            rows.append(f"UNREADABLE {os.path.basename(path)}")
            problems += 1
            continue
        if n == ETH_MIN:
            counts["complete"] += 1
        elif n == 0:
            counts["empty"] += 1
        else:
            counts["partial"] += 1
            if n > ETH_MIN:
                merged.append(date)
    rows.append(
        f"ETH sessions: {counts['complete']} complete · {counts['partial']} partial"
        f" · {counts['empty']} empty ({len(eth_files)} files)"
    )
    if merged:
        rows.append(f"merged holiday payloads (>1380 min): {len(merged)} — {', '.join(merged)}")
    for date in merged:
        if not args.repair:
            continue
        out = repair_eth(date)
        rows.append(f"  repair {date}: {out}")
        problems += out == "partial"

    # ---- RTH sessions ------------------------------------------------------
    rth_files = sorted(glob.glob(os.path.join(DATA, "*_RTH.json")))
    ok_rth = bad_rth = 0
    for path in rth_files:
        try:
            n = len(load(path).get("candles", []))
        except Exception:
            bad_rth += 1
            continue
        if n == RTH_MIN:
            ok_rth += 1
        else:
            bad_rth += 1
    rows.append(f"RTH sessions: {ok_rth} complete · {bad_rth} not 390-bar")

    # ---- OHLC twins ---------------------------------------------------------
    ohlc_dir = os.path.join(DATA, "ohlc")
    junk = []
    if os.path.isdir(ohlc_dir):
        for path in sorted(glob.glob(os.path.join(ohlc_dir, "*.json"))):
            date = os.path.basename(path)[:10]
            try:
                n = len(load(path).get("bars", []))
            except Exception:
                n = -1
            if n != RTH_MIN and date != today:  # today's twin is still forming
                junk.append((date, n))
        if junk:
            rows.append(f"partial OHLC twins ({len(junk)}): " + ", ".join(f"{d}({n})" for d, n in junk[:40]))
            if args.repair:
                for date, _ in junk:
                    p = os.path.join(ohlc_dir, f"{date}.json")
                    backup(p)
                    os.remove(p)
                rows.append(f"  deleted {len(junk)} partial OHLC twins (backups in repair_backup/)")
                problems += len(junk)
    else:
        rows.append("no ohlc/ directory")

    # ---- duplicate timestamps / gaps in complete sessions -------------------
    dup = gap = 0
    for path in eth_files + rth_files:
        try:
            cs = load(path).get("candles", [])
        except Exception:
            continue
        ts = [c["t"] for c in cs]
        if len(set(ts)) != len(ts):
            dup += 1
        if len(ts) > 1 and not contiguous(ts):
            gap += 1
    rows.append(f"sessions with duplicate minutes: {dup} · with gaps: {gap}")

    report = "\n".join(rows)
    print(report)
    out = os.path.join(DATA, "audit_report.txt")
    with open(out, "w") as f:
        f.write(report + "\n")
    print(f"\nreport saved to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
