#!/usr/bin/env python3
"""Exploratory backtest: strong one-sided (imbalanced) footprint minutes.

Answers, over the complete 2.5-year ETH session set:
  1. time-of-day distribution of strong one-sided minutes (buy vs sell)
  2. does a one-sided minute predict continuation? (win rate + points at K min)
  3. how long does the move persist before attenuating?

Definitions (tunable):
  buyPct = buy / (buy + sell) per minute
  strong-buy minute  : buyPct >= 0.70 and volume >= session median
  strong-sell minute : buyPct <= 0.30 and volume >= session median
  entry = mid of the NEXT minute (no lookahead)
"""
from __future__ import annotations

import json
import glob
import os
from collections import Counter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

BUY_PCT_HI = 0.70
BUY_PCT_LO = 0.30


def load_sessions():
    """Return list of sessions, each a list of dicts {mid, total, buyPct, hour}."""
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
            mins.append({
                "mid": (c["high"] + c["low"]) / 200.0,
                "total": total,
                "buyPct": (c["buy"] / total) if total else 0.5,
                "hour": c["t"][11:13],
            })
        out.append(mins)
    return out


def main():
    sessions = load_sessions()
    print(f"complete ETH sessions loaded: {len(sessions)}")

    # ---- 1. time-of-day ----
    hour_buy = Counter(); hour_sell = Counter(); hour_tot = Counter()
    n_buy = n_sell = 0
    sig_locs = {"BUY": [], "SELL": []}  # (session_idx, i)
    for si, mins in enumerate(sessions):
        vols = sorted(m["total"] for m in mins)
        floor = max(50, vols[len(vols) // 2])
        for i, m in enumerate(mins):
            hour_tot[m["hour"]] += 1
            if m["total"] < floor:
                continue
            if m["buyPct"] >= BUY_PCT_HI:
                hour_buy[m["hour"]] += 1
                n_buy += 1
                sig_locs["BUY"].append((si, i))
            elif m["buyPct"] <= BUY_PCT_LO:
                hour_sell[m["hour"]] += 1
                n_sell += 1
                sig_locs["SELL"].append((si, i))

    print(f"strong-buy minutes: {n_buy}   strong-sell minutes: {n_sell}")
    print("\n=== time-of-day (ET hour): strong one-sided minutes per 1000 session-minutes ===")
    print(f"{'ET':>4} {'buy':>7} {'sell':>7} {'one-sided/1000':>15}")
    for h in [f"{x:02d}" for x in range(24)]:
        tot = hour_tot.get(h, 0) or 1
        b = hour_buy.get(h, 0); s = hour_sell.get(h, 0)
        rate = (b + s) / tot * 1000
        et = (int(h) + 1) % 24
        print(f"{et:>4} {b:>7} {s:>7} {rate:>14.0f}  {'#' * int(rate / 2)}")

    # ---- 2. continuation backtest ----
    print("\n=== continuation after a strong one-sided minute (entry = next minute mid) ===")
    for label, sign in (("BUY", 1), ("SELL", -1)):
        for K in (1, 3, 5, 10):
            wins = tot = 0; pts = 0.0
            for si, i in sig_locs[label]:
                mins = sessions[si]
                if i + 1 + K >= len(mins):
                    continue
                entry = mins[i + 1]["mid"]
                ex = mins[i + 1 + K]["mid"]
                move = sign * (ex - entry)
                tot += 1; pts += move
                if move > 0:
                    wins += 1
            if tot:
                print(f"  {label:4s} K={K:>2}: n={tot:>6} win={wins/tot*100:5.1f}%  avg={pts/tot:+.3f} pts")

    # ---- 3. attenuation (persistence of same-side dominance) ----
    print("\n=== attenuation: minutes until same-side dominance (<0.55 / >0.45) breaks ===")
    for label, hi in (("BUY", True), ("SELL", False)):
        durations = []
        for si, i in sig_locs[label]:
            mins = sessions[si]
            dur = 0
            for j in range(i, min(len(mins), i + 60)):
                bp = mins[j]["buyPct"]
                if (hi and bp >= 0.55) or ((not hi) and bp <= 0.45):
                    dur += 1
                else:
                    break
            durations.append(dur)
        s = sorted(durations)
        print(f"  {label:4s}: n={len(s):>6}  median={s[len(s)//2]:>2} min  p10={s[int(len(s)*0.1)]:>2}  p90={s[int(len(s)*0.9)]:>2}")


if __name__ == "__main__":
    main()
