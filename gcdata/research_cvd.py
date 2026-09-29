#!/usr/bin/env python3
"""Two more analyses:

  Task 1 — precise OHLC stop/target on the (RTH-only) OHLC window that actually
           has real open/close, joined to footprint buy/sell.
  Task 3 — CVD (cumulative delta) DIVERGENCE entry over the full 2.5 years:
           price makes a lower low but CVD a higher low (bullish) or a higher
           high with CVD a lower high (bearish) -> the one side is weakening.
"""
from __future__ import annotations

import json
import glob
import os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
STOP = 3.0


def load_footprint(date):
    j = json.load(open(os.path.join(DATA, f"{date}_ETH.json")))
    out = []
    for c in j.get("candles", []):
        total = c["buy"] + c["sell"]
        out.append({
            "t": c["t"], "hm": c["t"][11:16],
            "high": c["high"] / 100.0, "low": c["low"] / 100.0,
            "mid": (c["high"] + c["low"]) / 200.0,
            "buy": c["buy"], "sell": c["sell"],
            "total": total, "buyPct": c["buy"] / total if total else 0.5,
            "et": (int(c["t"][11:13]) + 1) % 24,
        })
    return out


def load_ohlc(date):
    f = os.path.join(DATA, "ohlc", f"{date}.json")
    if not os.path.exists(f):
        return {}
    j = json.load(open(f))
    return {b["t"][11:16]: b for b in j.get("bars", [])}


# ── Task 1: precise OHLC stop/target (RTH only, where OHLC exists) ──
def task1():
    print("=== TASK 1: precise stop/target using real OHLC open/close (RTH) ===")
    trades = []
    for f in sorted(glob.glob(os.path.join(DATA, "ohlc", "*.json"))):
        date = os.path.basename(f)[:-5]
        ohlc = load_ohlc(date)
        if len(ohlc) < 380:
            continue  # skip sparse OHLC files
        fp = load_footprint(date)
        if not fp:
            continue
        vols = sorted(m["total"] for m in fp)
        floor = max(50, vols[len(vols) // 2])
        for i in range(len(fp) - 1):
            m = fp[i]
            if m["total"] < floor or m["hm"] not in ohlc:
                continue
            if not (m["buyPct"] >= 0.70 or m["buyPct"] <= 0.30):
                continue
            c = ohlc[m["hm"]]  # real close of the signal minute
            entry = float(c["c"])
            dr = -1 if m["buyPct"] >= 0.70 else 1  # fade? no—follow here: test both below
            # follow: buy-climax -> long, sell-climax -> short
            dr = 1 if m["buyPct"] >= 0.70 else -1
            stop_px = entry - dr * STOP
            target_px = entry + dr * STOP
            r = None
            for j in range(i + 1, min(len(fp), i + 1 + 15)):
                if fp[j]["hm"] not in ohlc:
                    break
                b = ohlc[fp[j]["hm"]]
                hi, lo = float(b["h"]), float(b["l"])
                if dr == 1:
                    if lo <= stop_px: r = -1; break
                    if hi >= target_px: r = 1; break
                else:
                    if hi >= stop_px: r = -1; break
                    if lo <= target_px: r = 1; break
            if r is None:
                continue
            trades.append((date, m["et"], r))
    if not trades:
        print("  no trades (not enough complete OHLC + strong signals)")
        return
    n = len(trades); wins = sum(1 for t in trades if t[2] > 0)
    print(f"  n={n}  win={wins/n*100:.1f}%  avgR={sum(t[2] for t in trades)/n:+.3f}  (follow, 1:1 3pt, RTH only)")
    print(f"  (note: OHLC is RTH-only and sparse; this is a tiny, recent-only sample)")


# ── Task 3: CVD divergence ──
def task3():
    print("\n=== TASK 3: CVD divergence entry (full 2.5 years) ===")
    sigs = {"long": [], "short": []}  # (session, i)
    sessions = []
    for f in sorted(glob.glob(os.path.join(DATA, "*_ETH.json"))):
        j = json.load(open(f))
        if j.get("_meta", {}).get("kind") != "complete":
            continue
        mins = []
        cvd = 0
        for c in j.get("candles", []):
            cvd += c["buy"] - c["sell"]
            mins.append({
                "high": c["high"] / 100.0, "low": c["low"] / 100.0,
                "mid": (c["high"] + c["low"]) / 200.0,
                "cvd": cvd,
                "et": (int(c["t"][11:13]) + 1) % 24,
            })
        sessions.append(mins)
    for si, mins in enumerate(sessions):
        n = len(mins)
        hi = [m["high"] for m in mins]; lo = [m["low"] for m in mins]; cvd = [m["cvd"] for m in mins]
        pLo = [i for i in range(2, n - 2) if lo[i] < min(lo[i-1], lo[i-2], lo[i+1], lo[i+2])]
        pHi = [i for i in range(2, n - 2) if hi[i] > max(hi[i-1], hi[i-2], hi[i+1], hi[i+2])]
        for k in range(1, len(pLo)):
            i1, i2 = pLo[k-1], pLo[k]
            if lo[i2] < lo[i1] and cvd[i2] > cvd[i1]:
                sigs["long"].append((si, i2))
        for k in range(1, len(pHi)):
            i1, i2 = pHi[k-1], pHi[k]
            if hi[i2] > hi[i1] and cvd[i2] < cvd[i1]:
                sigs["short"].append((si, i2))
    print(f"  bullish div (long): {len(sigs['long'])}   bearish div (short): {len(sigs['short'])}")

    for label, dr in (("long", 1), ("short", -1)):
        for K in (1, 3, 5, 10):
            wins = tot = 0; pts = 0.0
            for si, i in sigs[label]:
                mins = sessions[si]
                j = i + 2  # pivot only confirmable 2 bars later — enter on confirmation
                if j + K >= len(mins):
                    continue
                entry = mins[j]["mid"]
                ex = mins[j + K]["mid"]
                move = dr * (ex - entry)
                tot += 1; pts += move
                if move > 0:
                    wins += 1
            if tot:
                print(f"  {label:6s} K={K:>2}: n={tot:>6} win={wins/tot*100:5.1f}%  avg={pts/tot:+.3f} pts")

    # time-of-day of the divergences
    hh = defaultdict(int)
    for si, i in sigs["long"] + sigs["short"]:
        hh[sessions[si][i]["et"]] += 1
    print("  divergence count by ET hour:", {h: hh[h] for h in sorted(hh)})


if __name__ == "__main__":
    task1()
    task3()
