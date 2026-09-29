#!/usr/bin/env python3
"""One-shot: re-stamp RTH `_meta` with the corrected session_usable, atomically.

The RTH completeness check previously applied the ETH 1360-minute floor (and the
wrong close minute), so every complete RTH session was stamped "partial". The
data was fine; only the label was wrong. Re-compute it for every RTH file and
rewrite atomically (tmp + os.replace) so an interrupted run cannot corrupt a
file.
"""
import json
import glob
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import backfill  # noqa: E402


def main():
    fixed = 0
    skipped = 0
    for f in sorted(glob.glob(os.path.join(HERE, "data", "*_RTH.json"))):
        try:
            p = json.load(open(f))
        except Exception:
            skipped += 1
            continue
        meta = p.get("_meta")
        if not meta:
            continue
        n = len(p.get("candles", []))
        usable = backfill.session_usable(p, "RTH")
        new_kind = "complete" if usable else ("empty" if n == 0 else "partial")
        if meta.get("kind") == new_kind and meta.get("contiguous") == usable:
            continue
        meta["kind"] = new_kind
        meta["contiguous"] = usable
        meta["completeness"] = round(n / 390, 3) if n else None
        p["_meta"] = meta
        tmp = f + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(p, fh)
        os.replace(tmp, f)
        fixed += 1
    print(f"re-stamped {fixed} RTH files, skipped {skipped} unparseable")


if __name__ == "__main__":
    main()
