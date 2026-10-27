#!/usr/bin/env python3
"""Compare the local ES archive against the NQ R2 manifest: how many of the
NQ dates have a complete ES ETH/RTH pair, which are partial/missing, and any
ES files that have no NQ counterpart. Exits 0 when coverage is full.

Usage: .venv/bin/python check_es_coverage.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from backfill_es import ES_DATA, nq_manifest_dates  # noqa: E402


def es_status(date: str, session: str) -> str:
    p = os.path.join(ES_DATA, f"{date}_{session}.json")
    if not os.path.exists(p):
        return "missing"
    try:
        meta = json.load(open(p)).get("_meta") or {}
    except Exception:
        return "corrupt"
    return meta.get("kind", "unknown")


def main():
    nq = sorted(nq_manifest_dates())
    rows = []
    for d in nq:
        e, r = es_status(d, "ETH"), es_status(d, "RTH")
        rows.append((d, e, r))
    missing = [r for r in rows if r[1] != "complete" or r[2] != "complete"]
    # ES files with no NQ counterpart (shouldn't exist unless the manifest moved)
    es_files = {f[:10] for f in os.listdir(ES_DATA) if f.endswith("_ETH.json")} if os.path.isdir(ES_DATA) else set()
    orphans = sorted(es_files - set(nq))
    print(f"NQ archive: {len(nq)} dates")
    print(f"ES complete (ETH+RTH): {len(rows) - len(missing)}/{len(nq)}")
    if missing:
        print(f"incomplete/missing ({len(missing)}):")
        for d, e, r in missing:
            print(f"  {d}  ETH={e}  RTH={r}")
    if orphans:
        print(f"ES files without NQ counterpart: {orphans}")
    return 0 if not missing else 1


if __name__ == "__main__":
    raise SystemExit(main())
