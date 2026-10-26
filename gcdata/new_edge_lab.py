#!/usr/bin/env python3
"""New-edge lab (2026-10-26) — research input, honest execution.

Searches for NQ intraday edges OUTSIDE the current detectors, on REAL
Tradovate 1-min OHLCV (gcdata/data/ohlc_hist, CT clock, 621 sessions).

Execution model (pessimistic, every family):
  - market entries: next bar OPEN + 0.25 pt adverse slip
  - stop entries: the level, or the bar open when it gaps through, + 0.25 slip
  - limit entries: the level or better; the fill bar's adverse range counts
  - stop exits: the stop (or the gapped open) − 0.25 pt slip, stop-first
    inside any bar that spans both; a target on the ENTRY bar is never credited
  - time exits: the bar close − 0.25 pt slip
  - $1.90 / RT per micro, $2/pt, $100 risk budget → floor(100 / (risk·2)) micros
Account: MFF Rapid EOD 50k ($3,000 target, $2,000 EOD trailing MLL, floor
locks at +$100, 30% consistency, 4 min days) + P(pass before breach) over
500 day-order reshuffles.

Families (literature-motivated structures, small grids):
  ORB   opening-range breakout (Crabel; Zarattini & Aziz 2023)
  IMOM  intraday momentum — first-half-hour return → last half hour (Gao et al. 2018)
  GAP   RTH gap fade / go toward the prior close
  PDHL  prior-day high/low breakout
  ONR   overnight (Globex) range breakout at the RTH open
  VWAP  trend pullback to session VWAP
  LATE  last-hour trend continuation

Selection: train < 2026-01-01, test ≥. A config survives only if train AND
test are both net-positive after fees, PF ≥ 1.15 on both, every calendar
year net ≥ 0, and it survives +0.5 pt extra cost. The number of configs
tried is printed (multiple testing: survivors are research input).

Run:  python3 gcdata/new_edge_lab.py
"""
from __future__ import annotations

import glob
import json
import math
import os
import random
import statistics as st
import sys
from dataclasses import dataclass

HIST = os.path.join(os.path.dirname(__file__), "data", "ohlc_hist")
SPLIT = "2026-01-01"
SLIP = 0.25
FEE_RT = 1.90
PT_USD = 2.0
BUDGET = 100.0
EXTRA_COST = float(os.environ.get("LAB_EXTRA_COST", "0"))


# ----------------------------------------------------------------- data
@dataclass
class Bar:
    m: int  # minute of day, CT (0..1439)
    o: float
    h: float
    l: float
    c: float
    v: float


def load_sessions():
    out = []
    for f in sorted(glob.glob(os.path.join(HIST, "*_ETH.json"))):
        d = json.load(open(f))
        bars = []
        for b in d.get("bars", []):
            t = b["t"]
            hh, mm = int(t[11:13]), int(t[14:16])
            bars.append(Bar(hh * 60 + mm, float(b["o"]), float(b["h"]), float(b["l"]), float(b["c"]), float(b.get("v", 0))))
        if len(bars) < 600:
            continue
        out.append((d["date"], bars))
    return out


RTH_OPEN = 8 * 60 + 30  # 08:30 CT = 09:30 ET
RTH_CLOSE = 15 * 60  # 15:00 CT = 16:00 ET


def rth_bars(bars):
    return [b for b in bars if RTH_OPEN <= b.m < RTH_CLOSE]


def on_bars(bars):
    # session starts 17:00 CT previous day; overnight = before the RTH open
    return [b for b in bars if b.m >= 17 * 60 or b.m < RTH_OPEN]


# ----------------------------------------------------------- execution
@dataclass
class Trade:
    date: str
    pnl_pts: float  # per contract, after slippage (fees applied in $)
    risk_pts: float


def walk(bars, i0, direction, entry, stop, target, last_idx, entry_bar_counts_stop=True):
    """walk from bar i0 (the entry bar) to last_idx; returns exit price."""
    for j in range(i0, last_idx + 1):
        b = bars[j]
        on_entry_bar = j == i0
        hit_stop = (b.l <= stop) if direction > 0 else (b.h >= stop)
        hit_tgt = target is not None and ((b.h >= target) if direction > 0 else (b.l <= target))
        if on_entry_bar and not entry_bar_counts_stop:
            hit_stop = False
        if hit_stop:
            gap_px = b.o if (j > i0 and ((direction > 0 and b.o < stop) or (direction < 0 and b.o > stop))) else stop
            return gap_px - direction * SLIP
        if hit_tgt and not on_entry_bar:
            return target
    return bars[last_idx].c - direction * SLIP


def mk(date, direction, entry, exit_px, risk):
    pnl = (exit_px - entry) * direction - EXTRA_COST
    return Trade(date, pnl, risk)


def stop_entry_fill(b, level, direction):
    if direction > 0:
        return max(level, b.o) + SLIP
    return min(level, b.o) - SLIP


def idx_at(bars, minute):
    for i, b in enumerate(bars):
        if b.m >= minute:
            return i
    return None


# --------------------------------------------------------------- families
def orb(rth, date, n_min, stop_mode, tgt, last_entry_m=10 * 60 + 30):
    """first breakout of the N-minute opening range (stop entry), one trade/day."""
    if len(rth) < 300:
        return []
    orr = [b for b in rth if b.m < RTH_OPEN + n_min]
    if len(orr) < n_min * 0.8:
        return []
    hi, lo = max(b.h for b in orr), min(b.l for b in orr)
    k0 = len(orr)
    last = len(rth) - 1
    for i in range(k0, len(rth)):
        b = rth[i]
        if b.m > last_entry_m:
            return []
        up, dn = b.h >= hi + 0.25, b.l <= lo - 0.25
        if not (up or dn):
            continue
        if up and dn:
            return []  # ambiguous bar: skip
        d = 1 if up else -1
        lvl = hi + 0.25 if up else lo - 0.25
        e = stop_entry_fill(b, lvl, d)
        s = (lo if d > 0 else hi) if stop_mode == "opp" else (hi + lo) / 2
        risk = abs(e - s)
        if risk < 2:
            return []
        t = None if tgt == "eod" else e + d * risk * tgt
        x = walk(rth, i, d, e, s, t, last)
        return [mk(date, d, e, x, risk)]
    return []


def imom(rth, prev_close, date, sig_mode, entry_m, stop_pts):
    """Gao et al.: sign of the first-half-hour return → trade the last half hour."""
    if prev_close is None or len(rth) < 300:
        return []
    i30 = idx_at(rth, RTH_OPEN + 30)
    if i30 is None:
        return []
    ref = prev_close if sig_mode == "prevclose" else rth[0].o
    r = rth[i30 - 1].c - ref
    if abs(r) < 1:
        return []
    d = 1 if r > 0 else -1
    ie = idx_at(rth, entry_m)
    if ie is None or ie >= len(rth) - 1:
        return []
    e = rth[ie].o + d * SLIP
    s = e - d * stop_pts
    x = walk(rth, ie, d, e, s, None, len(rth) - 1)
    return [mk(date, d, e, x, stop_pts)]


def gap(rth, prev_close, date, band, mode):
    if prev_close is None or len(rth) < 300:
        return []
    o = rth[0].o
    g = o - prev_close
    lo_b, hi_b = band
    if not (lo_b <= abs(g) <= hi_b):
        return []
    d = -1 if g > 0 else 1  # fade toward the prior close
    if mode == "go":
        d = -d
    e = o + d * SLIP
    risk = abs(g)
    s = e - d * risk
    t = prev_close if mode == "fade" else e + d * risk
    x = walk(rth, 0, d, e, s, t, len(rth) - 1)
    return [mk(date, d, e, x, risk)]


def pdhl(rth, prev_hi, prev_lo, date, stop_pts, tgt, last_entry_m=12 * 60):
    if prev_hi is None or len(rth) < 300:
        return []
    o = rth[0].o
    if not (prev_lo < o < prev_hi):
        return []  # only from inside yesterday's range
    last = len(rth) - 1
    for i, b in enumerate(rth):
        if b.m > last_entry_m:
            return []
        up, dn = b.h >= prev_hi + 0.25, b.l <= prev_lo - 0.25
        if up and dn:
            return []
        if not (up or dn):
            continue
        d = 1 if up else -1
        e = stop_entry_fill(b, prev_hi + 0.25 if up else prev_lo - 0.25, d)
        s = e - d * stop_pts
        t = None if tgt == "eod" else e + d * stop_pts * tgt
        x = walk(rth, i, d, e, s, t, last)
        return [mk(date, d, e, x, stop_pts)]
    return []


def onr(bars, rth, date, stop_mode, tgt, last_entry_m=10 * 60 + 30):
    ob = on_bars(bars)
    if len(ob) < 400 or len(rth) < 300:
        return []
    hi, lo = max(b.h for b in ob), min(b.l for b in ob)
    o = rth[0].o
    if not (lo < o < hi):
        return []
    last = len(rth) - 1
    for i, b in enumerate(rth):
        if b.m > last_entry_m:
            return []
        up, dn = b.h >= hi + 0.25, b.l <= lo - 0.25
        if up and dn:
            return []
        if not (up or dn):
            continue
        d = 1 if up else -1
        e = stop_entry_fill(b, hi + 0.25 if up else lo - 0.25, d)
        s = (e - d * 30) if stop_mode == "30" else (hi + lo) / 2
        risk = abs(e - s)
        if risk < 2:
            return []
        t = None if tgt == "eod" else e + d * risk * tgt
        x = walk(rth, i, d, e, s, t, last)
        return [mk(date, d, e, x, risk)]
    return []


def vwap_pullback(rth, date, stop_pts, tgt, trend_bars=30, start_min=60):
    if len(rth) < 300:
        return []
    pv = vv = 0.0
    vw = []
    for b in rth:
        tp = (b.h + b.l + b.c) / 3
        pv += tp * max(b.v, 1)
        vv += max(b.v, 1)
        vw.append(pv / vv)
    last = len(rth) - 1
    start = idx_at(rth, RTH_OPEN + start_min)
    stop_entries = idx_at(rth, 14 * 60)  # no new entries after 15:00 ET
    if start is None or stop_entries is None:
        return []
    for i in range(start, stop_entries):
        win = range(i - trend_bars, i)
        above = all(rth[k].l > vw[k] for k in win)
        below = all(rth[k].h < vw[k] for k in win)
        if not (above or below):
            continue
        d = 1 if above else -1
        if (vw[i - 1] - vw[i - trend_bars]) * d <= 0:
            continue
        lvl = vw[i - 1]
        b = rth[i]
        touched = b.l <= lvl if d > 0 else b.h >= lvl
        if not touched:
            continue
        e = min(b.o, lvl) if d > 0 else max(b.o, lvl)
        s = e - d * stop_pts
        t = None if tgt == "eod" else e + d * stop_pts * tgt
        x = walk(rth, i, d, e, s, t, last)
        return [mk(date, d, e, x, stop_pts)]
    return []


def late(rth, date, stop_pts):
    if len(rth) < 300:
        return []
    i = idx_at(rth, 14 * 60)  # 15:00 ET
    if i is None:
        return []
    pv = vv = 0.0
    for b in rth[:i]:
        pv += (b.h + b.l + b.c) / 3 * max(b.v, 1)
        vv += max(b.v, 1)
    vw = pv / vv
    px = rth[i - 1].c
    o = rth[0].o
    if px > o and px > vw:
        d = 1
    elif px < o and px < vw:
        d = -1
    else:
        return []
    e = rth[i].o + d * SLIP
    s = e - d * stop_pts
    x = walk(rth, i, d, e, s, None, len(rth) - 1)
    return [mk(date, d, e, x, stop_pts)]


# ------------------------------------------------------------- configs
def configs():
    C = []
    for n in (5, 15, 30):
        for sm in ("opp", "mid"):
            for t in (1.0, 2.0, "eod"):
                C.append((f"ORB{n} stop={sm} tgt={t}", "orb", dict(n_min=n, stop_mode=sm, tgt=t)))
    for sm in ("prevclose", "open"):
        for em in (14 * 60, 14 * 60 + 30):
            for sp in (20, 40):
                C.append((f"IMOM sig={sm} in={em//60}:{em%60:02d}CT stop={sp}", "imom", dict(sig_mode=sm, entry_m=em, stop_pts=sp)))
    for band in ((15, 60), (30, 150)):
        for mode in ("fade", "go"):
            C.append((f"GAP {band[0]}-{band[1]} {mode}", "gap", dict(band=band, mode=mode)))
    for sp in (20, 40):
        for t in (2.0, "eod"):
            C.append((f"PDHL stop={sp} tgt={t}", "pdhl", dict(stop_pts=sp, tgt=t)))
    for sm in ("30", "mid"):
        for t in (1.0, 2.0, "eod"):
            C.append((f"ONR stop={sm} tgt={t}", "onr", dict(stop_mode=sm, tgt=t)))
    for sp in (15, 25):
        for t in (2.0, "eod"):
            C.append((f"VWAP pullback stop={sp} tgt={t}", "vwap", dict(stop_pts=sp, tgt=t)))
    for sp in (20, 40):
        C.append((f"LATE trend stop={sp}", "late", dict(stop_pts=sp)))
    return C


def nbhd_configs():
    """robustness neighbourhood around the survivors (LAB_MODE=nbhd)"""
    C = []
    for sp in (18, 20, 22, 25, 28, 30, 35, 40):
        for t in (1.5, 2.0, 2.5, 3.0):
            for tb in (20, 30, 45):
                C.append((f"VWAP sp={sp} t={t} tb={tb}", "vwap", dict(stop_pts=sp, tgt=t, trend_bars=tb)))
    for sm in ("mid",):
        for t in (1.5, 2.0, 3.0, "eod"):
            C.append((f"ONR stop={sm} tgt={t}", "onr", dict(stop_mode=sm, tgt=t)))
    for band in ((20, 100), (30, 150), (40, 200), (30, 100), (50, 250)):
        C.append((f"GAP {band[0]}-{band[1]} fade", "gap", dict(band=band, mode="fade")))
    return C


def run_all(sessions):
    C = nbhd_configs() if os.environ.get("LAB_MODE") == "nbhd" else configs()
    res = {name: [] for name, _, _ in C}
    prev_close = prev_hi = prev_lo = None
    for date, bars in sessions:
        rth = rth_bars(bars)
        for name, fam, kw in C:
            if fam == "orb":
                res[name] += orb(rth, date, **kw)
            elif fam == "imom":
                res[name] += imom(rth, prev_close, date, **kw)
            elif fam == "gap":
                res[name] += gap(rth, prev_close, date, **kw)
            elif fam == "pdhl":
                res[name] += pdhl(rth, prev_hi, prev_lo, date, **kw)
            elif fam == "onr":
                res[name] += onr(bars, rth, date, **kw)
            elif fam == "vwap":
                res[name] += vwap_pullback(rth, date, **kw)
            elif fam == "late":
                res[name] += late(rth, date, **kw)
        if len(rth) >= 300:
            prev_close = rth[-1].c
            prev_hi = max(b.h for b in rth)
            prev_lo = min(b.l for b in rth)
    return res


# ------------------------------------------------------------- metrics
def contracts(risk):
    return max(1, min(30, int(BUDGET // (risk * PT_USD))))


def usd(t: Trade):
    q = contracts(t.risk_pts)
    return t.pnl_pts * q * PT_USD - q * FEE_RT


def wilson(k, n):
    if n == 0:
        return (0, 0)
    z = 1.96
    p = k / n
    den = 1 + z * z / n
    c = (p + z * z / (2 * n)) / den
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den
    return (c - h, c + h)


def core(ts):
    n = len(ts)
    if n == 0:
        return None
    w = [t for t in ts if t.pnl_pts > 0]
    l = [t for t in ts if t.pnl_pts <= 0]
    gw = sum(t.pnl_pts for t in w)
    gl = -sum(t.pnl_pts for t in l)
    rs = [t.pnl_pts / t.risk_pts for t in ts]
    eq = pk = dd = 0.0
    for t in ts:
        eq += t.pnl_pts
        pk = max(pk, eq)
        dd = min(dd, eq - pk)
    by = {}
    for t in ts:
        by[t.date] = by.get(t.date, 0) + usd(t)
    days = sorted(by)
    srt = sorted((abs(v) for v in by.values()), reverse=True)
    tot = sum(by.values())
    sd = st.pstdev(rs) if n > 1 else 0
    return dict(
        n=n,
        wr=len(w) / n * 100,
        ci=wilson(len(w), n),
        aw=gw / len(w) if w else 0,
        al=gl / len(l) if l else 0,
        exp=sum(t.pnl_pts for t in ts) / n,
        expR=sum(rs) / n,
        pf=gw / gl if gl > 0 else float("inf"),
        sqn=(sum(rs) / n) / sd * math.sqrt(n) if sd > 0 else 0,
        dd=-dd,
        usd=tot,
        top10=(sum(sorted(by.values(), reverse=True)[:10]) / tot * 100) if tot > 0 else float("nan"),
        days=len(days),
    )


def account(daily, rules=dict(target=3000, mll=2000, lock=100, cons=0.30, mindays=4)):
    """Rapid EOD 50k on a daily $ list; returns ('pass', day) / ('breach', day) / ('open', n)."""
    eq = 0.0
    peak = 0.0
    best = 0.0
    for i, v in enumerate(daily):
        eq += v
        best = max(best, v)
        floor = min(peak - rules["mll"], rules["lock"]) if peak - rules["mll"] < rules["lock"] else rules["lock"]
        floor = min(peak - rules["mll"], rules["lock"])
        if eq <= floor:
            return ("breach", i + 1)
        peak = max(peak, eq)
        if eq >= rules["target"] and i + 1 >= rules["mindays"] and best <= rules["cons"] * eq:
            return ("pass", i + 1)
    return ("open", len(daily))


def p_pass(ts, reps=500, seed=7):
    by = {}
    for t in ts:
        by[t.date] = by.get(t.date, 0) + usd(t)
    vals = [by[d] for d in sorted(by)]
    if not vals:
        return 0, None
    rnd = random.Random(seed)
    passes = []
    for _ in range(reps):
        v = vals[:]
        rnd.shuffle(v)
        r = account(v)
        if r[0] == "pass":
            passes.append(r[1])
    return len(passes) / reps, (st.median(passes) if passes else None)


def fmt_core(label, c):
    if c is None:
        return f"| {label} | 0 | — | — | — | — | — | — | — | — | — | — | — |"
    pf = "—" if c["pf"] == float("inf") else f"{c['pf']:.2f}"
    return (
        f"| {label} | {c['n']} | {c['wr']:.1f}% [{c['ci'][0]*100:.1f}%–{c['ci'][1]*100:.1f}%] | +{c['aw']:.2f} | {c['al']:.2f} | "
        f"{(c['aw']/c['al'] if c['al'] else 0):.2f} | {c['exp']:+.2f} | {c['expR']:+.2f} | {pf} | {c['sqn']:.1f} | {c['dd']:.1f} | ${c['usd']:,.0f} | {c['top10']:.0f}% |"
    )


def main():
    sessions = load_sessions()
    print(f"sessions: {len(sessions)} ({sessions[0][0]} → {sessions[-1][0]}) · extra cost {EXTRA_COST} pt")
    res = run_all(sessions)
    print(f"configs tried: {len(res)}\n")
    print("| config | n | WR | exp pts | exp R | PF | $ all | $ train | $ test | PF tr/te | years $ |")
    print("|---|---|---|---|---|---|---|---|---|---|---|")
    rows = []
    for name, ts in res.items():
        if not ts:
            continue
        tr = [t for t in ts if t.date < SPLIT]
        te = [t for t in ts if t.date >= SPLIT]
        c, ctr, cte = core(ts), core(tr), core(te)
        years = {}
        for t in ts:
            years[t.date[:4]] = years.get(t.date[:4], 0) + usd(t)
        ok = (
            ctr and cte and ctr["usd"] > 0 and cte["usd"] > 0 and ctr["pf"] >= 1.15 and cte["pf"] >= 1.15 and all(v >= 0 for v in years.values()) and c["n"] >= 60
        )
        rows.append((name, ts, c, ctr, cte, years, ok))
        yr = " ".join(f"{y}:{v:+.0f}" for y, v in sorted(years.items()))
        print(
            f"| {'**' if ok else ''}{name}{'**' if ok else ''} | {c['n']} | {c['wr']:.1f}% | {c['exp']:+.2f} | {c['expR']:+.2f} | {c['pf']:.2f} | {c['usd']:+,.0f} | "
            f"{(ctr or {}).get('usd', 0):+,.0f} | {(cte or {}).get('usd', 0):+,.0f} | {(ctr or {}).get('pf', 0):.2f}/{(cte or {}).get('pf', 0):.2f} | {yr} |"
        )
    surv = [r for r in rows if r[6]]
    print(f"\nsurvivors (train+test net>0, PF≥1.15 both, every year ≥0, n≥60): {len(surv)} / {len(rows)}")
    for name, ts, c, ctr, cte, years, ok in surv:
        pp, med = p_pass(ts)
        tep, temed = p_pass([t for t in ts if t.date >= SPLIT])
        print(f"\n=== {name} ===")
        print("| cohort | n | WR [CI95] | avg win | avg loss | payoff | exp (pts) | exp (R) | PF | SQN | maxDD (pts) | $ net (fees) | conc top10 |")
        print("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
        print(fmt_core("all", c))
        print(fmt_core("train", ctr))
        print(fmt_core("test", cte))
        print(f"P(pass before breach) all = {pp:.2f} (median {med} days) · test-only = {tep:.2f} (median {temed})")


if __name__ == "__main__":
    main()
