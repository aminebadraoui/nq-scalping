#!/usr/bin/env python3
"""Probe whether GoCharting serves ES futures footprint data, in what symbol
format, and how deep the retention window goes (vs NQ: 2023-12-18 start).

Reuses the probe machinery from probe_symbols.py. One socket, small batches,
gentle: a handful of (symbol, date) pairs only.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from probe_symbols import load_env, probe  # noqa: E402


def main():
    load_env()
    pairs = [
        # current + recent contracts (baseline: should be complete)
        ("ESZ26", "2026-10-01"),
        ("ESU26", "2026-09-22"),
        # mid-tenure samples across the NQ archive window
        ("ESM26", "2026-06-12"),
        ("ESH26", "2026-03-13"),
        ("ESZ25", "2025-12-17"),
        ("ESU25", "2025-09-17"),
        ("ESM25", "2025-06-13"),
        ("ESH25", "2025-03-14"),
        ("ESZ24", "2024-12-17"),
        ("ESU24", "2024-09-17"),
        ("ESM24", "2024-06-13"),
        ("ESH24", "2024-03-13"),
        # boundary checks: NQ retention starts 2023-12-18 (NQH24 tenure)
        ("ESH24", "2023-12-18"),
        ("ESH24", "2023-12-19"),
        ("ESZ23", "2023-12-14"),
        # alternate symbol formats (in case per-contract differs from NQ)
        ("ES", "2026-10-01"),
        ("ES1!", "2026-10-01"),
    ]
    print(f"ES probe — {len(pairs)} pairs", flush=True)
    got = probe(pairs)
    for sym, d in pairs:
        n = got.get((sym, d))
        status = "NO DATA" if n is None else (f"{n} min COMPLETE" if n >= 1375 else f"sparse {n}")
        print(f"  {sym:<8} {d}  {status}", flush=True)


if __name__ == "__main__":
    main()
