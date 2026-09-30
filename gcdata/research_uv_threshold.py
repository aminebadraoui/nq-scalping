#!/usr/bin/env python3
"""Threshold sensitivity for the unusual-volume alert.

Question: is the 70% one-sided gate too strict? For each candidate threshold
we replay the LIVE pipeline exactly (volumeProfile.ts gate + unusualVolume.ts
uvWatchCheck) over all 640 complete ETH sessions and measure:
  · how many alerts each gate produces (alerts/day)
  · the stage-2 outcome mix: no pullback / pullback started / cancelled
    (move reversed) / reclaim (full 1R setup)
  · the same rates for ONLY the marginal band the lower threshold adds
    (e.g. 67–70% one-sided) — that band is the "wiggle room", and its
    quality decides whether loosening is free or costly
"""
from __future__ import annotations

import json
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# web/lib/volumeProfile.ts — median minute volume by NY hour (640 sessions)
HOURLY_MEDIAN_VOLUME = {
    0: 37, 1: 49, 2: 68, 3: 106, 4: 107, 5: 80, 6: 83, 7: 118, 8: 204,
    9: 948, 10: 1349, 11: 917, 12: 689, 13: 615, 14: 606, 15: 770, 16: 139,
    17: 0, 18: 63, 19: 56, 20: 76, 21: 63, 22: 49, 23: 40,
}

# web/lib/unusualVolume.ts constants
FLIP_MIN = 0.15          # first aggressive counter-side bar
RECLAIM_ONENESS = 0.65   # the reclaim bar's one-sidedness gate
SWEEP_TICK = 0.25
WINDOW = 6               # UV_WATCH_MS ≈ 6 minutes


def load():
    out = []
    for f in sorted(glob.glob(os.path.join(DATA, "*_ETH.json"))):
        try:
            j = json.load(open(f))
        except Exception:
            continue
        if j.get("_meta", {}).get("kind") != "complete":
            continue
        cs = j.get("candles", [])
        if len(cs) < 1360:
            continue
        mins = []
        for c in cs:
            total = c["buy"] + c["sell"]
            et = (int(c["t"][11:13]) + 1) % 24  # CT + 1 = ET (feed clock)
            mins.append({
                "high": c["high"] / 100.0,
                "low": c["low"] / 100.0,
                "buy": c["buy"],
                "sell": c["sell"],
                "total": total,
                "et": et,
                "buyPct": (c["buy"] / total) if total else 0.5,
            })
        out.append(mins)
    return out


def stage2(mins, i, side, volmed):
    """Faithful port of uvWatchCheck over the 6-bar window. Returns the first
    event chronologically: cancelled / reclaim / started / none."""
    alert = mins[i]
    started = False
    start_idx = -1
    pull_extreme = 0.0
    past = 0
    end = min(len(mins), i + 1 + WINDOW)
    for k in range(i + 1, end):
        m = mins[k]
        mid = (m["high"] + m["low"]) / 2
        is_past = mid < alert["low"] if side == "buy" else mid > alert["high"]
        past = past + 1 if is_past else 0
        if past >= 2:
            return "cancelled"
        if not started:
            dp = (m["buy"] - m["sell"]) / m["total"] if m["total"] else 0.0
            against = dp <= -FLIP_MIN if side == "buy" else dp >= FLIP_MIN
            if against:
                started = True
                start_idx = k
                pull_extreme = m["low"] if side == "buy" else m["high"]
            continue
        if k <= start_idx:
            continue
        swept = m["low"] <= pull_extreme - SWEEP_TICK if side == "buy" else m["high"] >= pull_extreme + SWEEP_TICK
        if not swept:
            continue
        for j in range(k + 1, min(end, k + 3)):
            b = mins[j]
            bmid = (b["high"] + b["low"]) / 2
            back_inside = bmid > pull_extreme if side == "buy" else bmid < pull_extreme
            if not back_inside:
                break
            tot = b["total"]
            bp = b["buy"] / tot if tot else 0.5
            one_sided = bp >= RECLAIM_ONENESS if side == "buy" else bp <= 1 - RECLAIM_ONENESS
            if not one_sided or tot < volmed:
                break
            return "reclaim"
    return "started" if started else "none"


def main():
    sessions = load()
    print(f"complete sessions: {len(sessions)}")

    # every minute that passes the RVOL >= 2x gate, tagged with its buyPct
    cand = []  # (session, i)
    volmeds = []
    for si, mins in enumerate(sessions):
        volmeds.append(max(50.0, sorted(m["total"] for m in mins)[len(mins) // 2]))
        for i, m in enumerate(mins):
            base = HOURLY_MEDIAN_VOLUME.get(m["et"], 0)
            if base <= 0 or m["total"] < 2 * base:
                continue
            cand.append((si, i))

    print(f"minutes at >=2x hourly RVOL: {len(cand)} ({len(cand)/len(sessions):.1f}/day)")

    THRESHOLDS = [0.60, 0.63, 0.65, 0.67, 0.70, 0.75, 0.80]

    # ---- outcome rates per threshold (alert = RVOL gate + one-sided gate) ----
    print("\n=== full pipeline per threshold (alert -> pullback -> reclaim) ===")
    print(f"{'gate':>8} {'alerts':>8} {'/day':>6} {'pullback':>9} {'cancel':>7} {'reclaim':>8} {'no-move':>8}")
    rows = {}
    for t in THRESHOLDS:
        counts = {"none": 0, "started": 0, "cancelled": 0, "reclaim": 0}
        n = 0
        for si, i in cand:
            mins = sessions[si]
            bp = mins[i]["buyPct"]
            if not (bp >= t or bp <= 1 - t):
                continue
            n += 1
            side = "buy" if bp >= t else "sell"
            out = stage2(mins, i, side, volmeds[si])
            counts[out] += 1
        pb = (counts["started"] + counts["reclaim"]) / n * 100
        rows[t] = (n, counts)
        print(f"{t*100:>7.0f}% {n:>8} {n/len(sessions):>5.1f} {pb:>8.1f}% {counts['cancelled']/n*100:>6.1f}% {counts['reclaim']/n*100:>7.1f}% {counts['none']/n*100:>7.1f}%")

    # ---- the marginal band: what exactly does loosening 70% add? ----
    print("\n=== the wiggle room: outcomes of ONLY the added band ===")
    for lo, hi in ((0.70, 0.80), (0.67, 0.70), (0.65, 0.67), (0.63, 0.65), (0.60, 0.63)):
        counts = {"none": 0, "started": 0, "cancelled": 0, "reclaim": 0}
        n = 0
        for si, i in cand:
            mins = sessions[si]
            bp = mins[i]["buyPct"]
            one_sided = max(bp, 1 - bp)
            if not (lo <= one_sided < hi):
                continue
            n += 1
            side = "buy" if bp >= 0.5 else "sell"
            counts[stage2(mins, i, side, volmeds[si])] += 1
        if not n:
            print(f"  [{lo*100:.0f}–{hi*100:.0f})%: no minutes")
            continue
        pb = (counts["started"] + counts["reclaim"]) / n * 100
        print(f"  [{lo*100:.0f}–{hi*100:.0f})%: n={n:>6} ({n/len(sessions):.2f}/day)  pullback {pb:4.1f}%  cancel {counts['cancelled']/n*100:4.1f}%  reclaim {counts['reclaim']/n*100:4.1f}%")

    # ---- distribution of one-sidedness at the RVOL gate ----
    print("\n=== one-sidedness distribution of >=2x RVOL minutes ===")
    bins = {}
    for si, i in cand:
        b = int(max(sessions[si][i]["buyPct"], 1 - sessions[si][i]["buyPct"]) * 20)  # 5% bins
        bins[b] = bins.get(b, 0) + 1
    for b in range(12, 21):
        lo = b * 5
        hi = lo + 5
        v = bins.get(b, 0)
        print(f"  {lo:>3}–{hi:>3}% one-sided: {v:>6} ({v/len(cand)*100:4.1f}% of RVOL minutes)")

    # ---- time-of-day split for the two candidate gates ----
    print("\n=== reclaim rate by time-of-day (gate 70% vs 67%) ===")
    for t in (0.70, 0.67):
        zones = {"overnight": [0, 0], "transition": [0, 0], "rth": [0, 0]}
        for si, i in cand:
            mins = sessions[si]
            et = mins[i]["et"]
            bp = mins[i]["buyPct"]
            if not (bp >= t or bp <= 1 - t):
                continue
            side = "buy" if bp >= 0.5 else "sell"
            out = stage2(mins, i, side, volmeds[si])
            z = "rth" if 10 <= et <= 15 else ("overnight" if (18 <= et <= 23 or 0 <= et <= 8) else "transition")
            zones[z][0] += 1
            zones[z][1] += out == "reclaim"
        line = "  ".join(f"{z} {n}->{r/n*100:.1f}%" for z, (n, r) in zones.items() if n)
        print(f"  {t*100:.0f}%: {line}")


if __name__ == "__main__":
    main()
