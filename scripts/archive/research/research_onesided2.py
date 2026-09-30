#!/usr/bin/env python3
"""v2: does the one-sided signal work better overnight, and do SUSTAINED runs
(multiple consecutive one-sided minutes) predict continuation?"""
from __future__ import annotations

import json
import glob
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


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
            # ET hour = CT hour + 1
            et = (int(c["t"][11:13]) + 1) % 24
            mins.append({
                "mid": (c["high"] + c["low"]) / 200.0,
                "total": total,
                "buyPct": (c["buy"] / total) if total else 0.5,
                "et": et,
            })
        out.append(mins)
    return out


def zone(et):
    if 18 <= et <= 23 or 0 <= et <= 8:
        return "overnight"
    if 10 <= et <= 15:
        return "rth"
    return "transition"


def backtest(sessions, sigs, sign, K):
    wins = tot = 0; pts = 0.0
    for si, i in sigs:
        mins = sessions[si]
        if i + 1 + K >= len(mins):
            continue
        entry = mins[i + 1]["mid"]
        ex = mins[i + 1 + K]["mid"]
        move = sign * (ex - entry)
        tot += 1; pts += move
        if move > 0:
            wins += 1
    return tot, wins / tot * 100 if tot else 0, pts / tot if tot else 0


def main():
    sessions = load()
    print(f"sessions: {len(sessions)}")

    # ---- single-minute signal, split by zone ----
    print("\n=== single strong minute -> continuation, by time-of-day (K=5) ===")
    sigs = {"overnight": [], "rth": []}
    for si, mins in enumerate(sessions):
        vols = sorted(m["total"] for m in mins)
        floor = max(50, vols[len(vols) // 2])
        for i, m in enumerate(mins):
            if m["total"] < floor:
                continue
            z = zone(m["et"])
            if z not in sigs:
                continue
            if m["buyPct"] >= 0.70:
                sigs[z].append((si, i, 1))
            elif m["buyPct"] <= 0.30:
                sigs[z].append((si, i, -1))
    for z in ("overnight", "rth"):
        for sign in (1, -1):
            sub = [(s, i) for s, i, sg in sigs[z] if sg == sign]
            tot, wr, pts = backtest(sessions, sub, sign, 5)
            print(f"  {z:10s} {'BUY' if sign==1 else 'SELL'}: n={tot:>6} win={wr:5.1f}% avg={pts:+.3f} pts")

    # ---- sustained run: >=3 consecutive same-side (buyPct>=0.6 / <=0.4) with price progress ----
    print("\n=== sustained run (>=3 consecutive one-sided + price progress) -> continuation ===")
    runs = {"BUY": [], "SELL": []}
    for si, mins in enumerate(sessions):
        vols = sorted(m["total"] for m in mins)
        floor = max(50, vols[len(vols) // 2])
        i = 0
        while i < len(mins) - 3:
            # try to start a buy run at i
            if mins[i]["buyPct"] >= 0.6 and mins[i]["total"] >= floor:
                run = 1
                advancing = True
                for j in range(i + 1, len(mins)):
                    if mins[j]["buyPct"] >= 0.6 and mins[j]["mid"] >= mins[j - 1]["mid"] - 0.25:
                        run += 1
                    else:
                        break
                    if run >= 3:
                        break
                if run >= 3:
                    runs["BUY"].append((si, i + run - 1))
                    i += run
                    continue
            # sell run
            if mins[i]["buyPct"] <= 0.4 and mins[i]["total"] >= floor:
                run = 1
                for j in range(i + 1, len(mins)):
                    if mins[j]["buyPct"] <= 0.4 and mins[j]["mid"] <= mins[j - 1]["mid"] + 0.25:
                        run += 1
                    else:
                        break
                    if run >= 3:
                        break
                if run >= 3:
                    runs["SELL"].append((si, i + run - 1))
                    i += run
                    continue
            i += 1
    print(f"  buy runs: {len(runs['BUY'])}   sell runs: {len(runs['SELL'])}")
    for label, sign in (("BUY", 1), ("SELL", -1)):
        for K in (3, 5, 10):
            tot, wr, pts = backtest(sessions, runs[label], sign, K)
            print(f"  {label:4s} K={K:>2}: n={tot:>6} win={wr:5.1f}% avg={pts:+.3f} pts")


if __name__ == "__main__":
    main()
