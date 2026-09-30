#!/usr/bin/env python3
"""Session-clustered backtest of two footprint strategies over 2.5 years.

  A) FADE the one-sided climax  — strong buy/sell minute (>=70/30) is treated as
     exhaustion; enter OPPOSITE, all hours.
  B) FOLLOW RTH sell-aggression — strong sell minute (<=30) during 10:00-15:00 ET
     is treated as institutional selling; enter SHORT (follow).

Exits: fixed 1:1 (3pt/3pt), fixed 2:1 (3pt/6pt), and attenuation (exit when the
3-min dominance flips). Stop-first is assumed when a bar spans both levels.
"""
from __future__ import annotations

import json
import glob
import os
import random
from collections import Counter, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

STOP = 3.0


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
            et = (int(c["t"][11:13]) + 1) % 24
            mins.append({
                "mid": (c["high"] + c["low"]) / 200.0,
                "high": c["high"] / 100.0,
                "low": c["low"] / 100.0,
                "total": total,
                "buyPct": (c["buy"] / total) if total else 0.5,
                "et": et,
            })
        out.append(mins)
    return out


def signals(sessions):
    """Return (fade_sigs, follow_sigs). Each sig = (session_idx, i, direction).
    direction = +1 long, -1 short."""
    fade = []   # fade the climax
    follow = []  # follow RTH sell aggression
    for si, mins in enumerate(sessions):
        vols = sorted(m["total"] for m in mins)
        floor = max(50, vols[len(vols) // 2])
        for i, m in enumerate(mins):
            if m["total"] < floor:
                continue
            if m["buyPct"] >= 0.70:      # buy climax -> fade SHORT
                fade.append((si, i, -1))
            elif m["buyPct"] <= 0.30:    # sell climax -> fade LONG
                fade.append((si, i, 1))
                if 10 <= m["et"] <= 15:  # RTH sell aggression -> follow SHORT
                    follow.append((si, i, -1))
    return fade, follow


def run(sessions, sigs, direction_mult, target, max_hold=15, atten=False):
    """Return list of (session_idx, hour, R). direction_mult already encodes long/short.

    No lookahead: the signal is known at the END of minute i, so we enter at the
    signal minute's mid (proxy for its close) and only examine minutes i+1.."""
    trades = []
    for si, i, dr in sigs:
        mins = sessions[si]
        if i + 1 >= len(mins):
            continue
        entry = mins[i]["mid"]
        stop_px = entry - dr * STOP
        target_px = entry + dr * target
        hour = mins[i]["et"]
        r = None
        for j in range(i + 1, min(len(mins), i + 1 + max_hold)):
            b = mins[j]
            if dr == 1:  # long
                if b["low"] <= stop_px:
                    r = -STOP / STOP; break
                if b["high"] >= target_px:
                    r = target / STOP; break
            else:        # short
                if b["high"] >= stop_px:
                    r = -STOP / STOP; break
                if b["low"] <= target_px:
                    r = target / STOP; break
            if atten:
                # exit when 3-min dominance flips against us
                if j >= i + 3:
                    bp = [mins[k]["buyPct"] for k in range(j - 2, j + 1)]
                    dom = sum(bp) / 3
                    if dr == 1 and dom < 0.45:
                        r = (mins[j]["mid"] - entry) / STOP; break
                    if dr == -1 and dom > 0.55:
                        r = (entry - mins[j]["mid"]) / STOP; break
        if r is None:
            last = mins[min(len(mins) - 1, i + max_hold)]["mid"]
            r = dr * (last - entry) / STOP
        trades.append((si, hour, r))
    return trades


def report(name, sessions, trades):
    if not trades:
        print(f"\n{name}: no trades"); return
    rs = [t[2] for t in trades]
    n = len(rs)
    wins = sum(1 for r in rs if r > 0)
    losses = sum(1 for r in rs if r <= 0)
    wr = wins / n * 100
    avgR = sum(rs) / n
    exp = avgR  # R per trade
    print(f"\n=== {name} ===")
    print(f"n={n}  win={wr:.1f}%  avgR={avgR:+.3f}  expectancy={exp:+.3f}R  (stop={STOP}pt)")

    # per-hour
    byh = defaultdict(list)
    for si, h, r in trades:
        byh[h].append(r)
    print("  per-hour (ET):  n   win%   avgR")
    for h in range(24):
        if h in byh:
            rs2 = byh[h]
            w = sum(1 for r in rs2 if r > 0) / len(rs2) * 100
            a = sum(rs2) / len(rs2)
            print(f"    {h:>2}          {len(rs2):>4}  {w:5.1f}  {a:+.3f}")

    # session-clustered
    bys = defaultdict(list)
    for si, h, r in trades:
        bys[si].append(r)
    wr_sess = [sum(1 for r in rs if r > 0) / len(rs) * 100 for rs in bys.values()]
    above = sum(1 for w in wr_sess if w > 50)
    wr_sess.sort()
    print(f"  sessions={len(bys)}  median session WR={wr_sess[len(wr_sess)//2]:.0f}%  days>50%={above}/{len(bys)} ({above/len(bys)*100:.0f}%)")

    # session-bootstrap 95% CI on win rate
    keys = list(bys.keys())
    random.seed(0)
    means = []
    for _ in range(1000):
        samp = [random.choice(keys) for _ in keys]
        w = sum(1 for si in samp for r in bys[si] if r > 0)
        t = sum(len(bys[si]) for si in samp)
        means.append(w / t * 100)
    means.sort()
    print(f"  bootstrap 95% CI on win%: [{means[25]:.1f}, {means[974]:.1f}]  (naive would be much tighter)")

    return rs


def main():
    sessions = load()
    print(f"complete sessions: {len(sessions)}")
    fade, follow = signals(sessions)
    print(f"fade signals: {len(fade)}   follow-RTH-sell signals: {len(follow)}")

    for target, label in ((3.0, "1:1 (3pt/3pt)"), (6.0, "2:1 (3pt/6pt)")):
        report(f"A) FADE climax — {label}", sessions, run(sessions, fade, 1, target))
        report(f"B) FOLLOW RTH sell — {label}", sessions, run(sessions, follow, 1, target))

    report("A) FADE climax — attenuation exit", sessions, run(sessions, fade, 1, 3.0, atten=True))
    report("B) FOLLOW RTH sell — attenuation exit", sessions, run(sessions, follow, 1, 3.0, atten=True))


if __name__ == "__main__":
    main()
