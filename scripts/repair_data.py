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

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gcdata", "data")
BACKUP = os.path.join(DATA, "repair_backup")
ETH_MIN = 1380
RTH_MIN = 390


def contiguous(ts: list[str]) -> bool:
    """Minutes-consecutive check without datetime parsing: ISO feed-clock
    strings sort correctly, so compare minute-of-day + day deltas arithmetically."""
    if not ts:
        return False
    s = sorted(ts)

    def key(t: str):
        # "2026-09-08T14:59:00-05:00" -> (day-number, minute-of-day)
        return (int(t[0:4]) * 372 + int(t[5:7]) * 31 + int(t[8:10]), int(t[11:13]) * 60 + int(t[14:16]))

    prev = key(s[0])
    for t in s[1:]:
        cur = key(t)
        if cur[0] == prev[0] and cur[1] == prev[1] + 1:
            prev = cur
            continue
        if cur[0] == prev[0] + 1 and prev[1] == 24 * 60 - 1 and cur[1] == 0:
            prev = cur
            continue
        return False
    return True


def _canonical(date: str):
    # build the day before without datetime (dates are always YYYY-MM-DD)
    y, m, d = (int(x) for x in date.split("-"))
    if d > 1:
        d -= 1
    else:
        d = 31
        if m > 1:
            m -= 1
        else:
            m, y = 12, y - 1
    # fix month lengths crudely (only used for string bounds; a 31-day guess
    # over long months never over-trims because the file's own minutes bound it)
    prev = f"{y:04d}-{m:02d}-{d:02d}"
    return f"{prev}T17:00:00", f"{date}T15:59:00"


def load(path: str):
    with open(path) as f:
        return json.load(f)


def backup(path: str):
    os.makedirs(BACKUP, exist_ok=True)
    shutil.copy2(path, os.path.join(BACKUP, os.path.basename(path)))


def repair_eth(date: str, j: dict, cs: list) -> str:
    """Trim a merged holiday payload to the canonical window when it is whole.
    Returns 'complete', 'partial' or 'skip'."""
    n = len(cs)
    if n <= ETH_MIN:
        return "skip"
    lo, hi = _canonical(date)
    win = [c for c in cs if lo <= c["t"] <= hi]
    if len(win) != ETH_MIN or not contiguous([c["t"] for c in win]):
        return "partial"
    backup(os.path.join(DATA, f"{date}_ETH.json"))
    j["candles"] = sorted(win, key=lambda c: c["t"])
    j["_meta"] = {
        "session": "ETH",
        "candles": ETH_MIN,
        "expected": ETH_MIN,
        "completeness": 1.0,
        "kind": "complete",
        "contiguous": True,
        "repaired_at": os.environ.get("REPAIR_TS", "now"),
        "source": j.get("_meta", {}).get("source", "gocharting FOOTPRINT/V2"),
        "symbol": j.get("_meta", {}).get("symbol", "?"),
    }
    with open(os.path.join(DATA, f"{date}_ETH.json"), "w") as f:
        json.dump(j, f, separators=(",", ":"))
    return "complete"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repair", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(DATA):
        print(f"no data dir at {DATA}", file=sys.stderr)
        return 1

    today = os.environ.get("REPAIR_TODAY", "") or __import__("datetime").datetime.now().strftime("%Y-%m-%d")
    os.environ.setdefault("REPAIR_TS", __import__("datetime").datetime.now().astimezone().isoformat())

    # ---- single pass over every session file --------------------------------
    eth_count = collections.Counter()
    rth_ok = rth_bad = 0
    merged: list[str] = []
    dup = gap = 0
    for path in sorted(glob.glob(os.path.join(DATA, "*_ETH.json"))) + sorted(
        glob.glob(os.path.join(DATA, "*_RTH.json"))
    ):
        try:
            j = load(path)
            cs = j.get("candles", [])
        except Exception:
            print(f"UNREADABLE {os.path.basename(path)}")
            continue
        ts = [c["t"] for c in cs]
        if len(set(ts)) != len(ts):
            dup += 1
        if len(ts) > 1 and not contiguous(ts):
            gap += 1
        base = os.path.basename(path)
        if base.endswith("_ETH.json"):
            n = len(cs)
            eth_count["complete" if n == ETH_MIN else ("empty" if n == 0 else "partial")] += 1
            if n > ETH_MIN:
                merged.append(base[:10])
        else:
            if len(cs) == RTH_MIN:
                rth_ok += 1
            else:
                rth_bad += 1

    # ---- repairs ------------------------------------------------------------
    rows: list[str] = [
        f"ETH sessions: {eth_count['complete']} complete · {eth_count['partial']} partial"
        f" · {eth_count['empty']} empty",
        f"RTH sessions: {rth_ok} complete · {rth_bad} not 390-bar",
        f"sessions with duplicate minutes: {dup} · with gaps: {gap}",
    ]
    if merged:
        rows.append(f"merged holiday payloads (>1380 min): {len(merged)}")
        for date in merged:
            if not args.repair:
                continue
            try:
                j = load(os.path.join(DATA, f"{date}_ETH.json"))
                out = repair_eth(date, j, j.get("candles", []))
                rows.append(f"  repair {date}: {out}")
            except Exception as e:
                rows.append(f"  repair {date}: ERROR {e}")

    # ---- OHLC twins ----------------------------------------------------------
    ohlc_dir = os.path.join(DATA, "ohlc")
    if os.path.isdir(ohlc_dir):
        junk = []
        mismatch = []
        for path in sorted(glob.glob(os.path.join(ohlc_dir, "*.json"))):
            date = os.path.basename(path)[:10]
            try:
                bars = load(path).get("bars", [])
            except Exception:
                n = -1
                bars = []
            n = len(bars)
            if n != RTH_MIN and date != today:  # today's twin is still forming
                junk.append((date, n))
                continue
            # price/volume parity vs the footprint RTH file (catches wrong-contract
            # collections, e.g. NQZ26 OHLC saved against NQU26 footprint at rollover)
            if n == RTH_MIN:
                fp_path = os.path.join(DATA, f"{date}_RTH.json")
                if os.path.exists(fp_path):
                    try:
                        fp = {c["t"][11:16]: c for c in load(fp_path).get("candles", [])}
                    except Exception:
                        fp = {}
                    for b in bars:
                        c = fp.get(b["t"][11:16])
                        if not c:
                            continue
                        if b["h"] != c["high"] / 100 or b["l"] != c["low"] / 100 or b["v"] != c["total"]:
                            mismatch.append((date, b["t"]))
                            break
        if junk:
            rows.append(f"partial OHLC twins ({len(junk)})")
            if args.repair:
                for date, _ in junk:
                    p = os.path.join(ohlc_dir, f"{date}.json")
                    backup(p)
                    os.remove(p)
                rows.append(f"  deleted {len(junk)} partial OHLC twins (backups in repair_backup/)")
        if mismatch:
            rows.append(f"wrong-contract/parity OHLC twins ({len(mismatch)}): " + ", ".join(f"{d}@{t[11:16]}" for d, t in mismatch))
            if args.repair:
                for date, _ in mismatch:
                    p = os.path.join(ohlc_dir, f"{date}.json")
                    backup(p)
                    os.remove(p)
                rows.append(f"  deleted {len(mismatch)} mismatched OHLC twins (backups in repair_backup/)")
    else:
        rows.append("no ohlc/ directory")

    report = "\n".join(rows)
    print(report)
    with open(os.path.join(DATA, "audit_report.txt"), "w") as f:
        f.write(report + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
