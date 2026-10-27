"""Exact-fill strategy library on TRUE Tradovate 1-min OHLC (no estimates).
Market order sent at the end of bar k fills at open[k+1] ± slip. Stops: a
bar that OPENS through the stop fills at its open; otherwise at the stop ±
slip. Targets need a one-tick trade-through and get no credit on the fill
bar. Time exits at close[end] ∓ slip. MNQ fee 0.95 pt RT. 1 contract, pts."""
import numpy as np, json
from ogrid import load
TICK, SLIP, FEE = 0.25, 0.25, 0.95
T = load(); TD = sorted(T)
F = json.load(open('/home/claude/research/features.json'))
RTH0, RTH_END = 930, 1319


def ok(g, i): return 0 <= i < 1380 and not np.isnan(g['o'][i])


def nxt(g, i, end):
    while i <= end and not ok(g, i): i += 1
    return i if i <= end else None


def mkt(g, k, d, slip=SLIP):
    j = nxt(g, k + 1, k + 30)
    return (None, None) if j is None else (g['o'][j] + d * slip, j)


def walk(g, j0, d, entry, stop_fn, tgt=None, end=RTH_END, slip=SLIP):
    """position live from the OPEN of bar j0. stop_fn(j) = stop during bar j."""
    o, h, l, c = g['o'], g['h'], g['l'], g['c']
    for j in range(j0, end + 1):
        if not ok(g, j): continue
        st = stop_fn(j)
        if st is not None:
            if (o[j] <= st) if d > 0 else (o[j] >= st):
                return (o[j] - d * slip - entry) * d - FEE, j
            if (l[j] <= st) if d > 0 else (h[j] >= st):
                return (st - d * slip - entry) * d - FEE, j
        if tgt is not None and j > j0 and ((h[j] >= tgt + TICK) if d > 0 else (l[j] <= tgt - TICK)):
            return (tgt - entry) * d - FEE, j
    j = end
    while j > j0 and not ok(g, j): j -= 1
    return (c[j] - d * slip - entry) * d - FEE, j


def rth_open(g): return g['o'][RTH0] if ok(g, RTH0) else None
def rth_close(g):
    j = RTH_END
    while j > RTH0 and not ok(g, j): j -= 1
    return g['c'][j] if j > RTH0 else None


def rep(name, o, yrs=('2024', '2025', '2026', 'all')):
    s = []
    for yr in yrs:
        v = np.array([p for d, p in o.items() if yr == 'all' or d.startswith(yr)])
        if len(v) < 20: continue
        sh = v.mean() / (v.std(ddof=1) or 1)
        s.append(f"{yr}:{v.mean():+6.2f}/d t{sh*np.sqrt(len(v)):+.2f}")
    tr = np.array([x for x in o.values() if x])
    wr = f"WR {np.mean(tr>0):.0%}" if len(tr) else ""
    print(f"{name:38s} n_tr={len(tr):3d} {wr} " + " | ".join(s))


# ---------------- strategies ----------------
def gap_fade(cap=150, minf=0.0025, end=1019, at='open'):
    out = {}
    for i, d in enumerate(TD):
        if i == 0: continue
        g = T[d]; pc = rth_close(T[TD[i - 1]]); op = rth_open(g)
        if pc is None or op is None: continue
        gp = (op - pc) / pc
        if abs(gp) <= minf or abs(op - pc) > cap: out[d] = 0.0; continue
        dr = -1 if gp > 0 else 1
        if at == 'open': e, j = op + dr * SLIP, RTH0
        else: e, j = mkt(g, RTH0, dr)
        if e is None: continue
        st = e - dr * abs(op - pc)
        out[d] = walk(g, j, dr, e, lambda jj: st, None, end)[0]
    return out


def noise_area(first=60, every=30, lookback=14):
    out = {}; hist = []; prev = None
    for d in TD:
        g = T[d]; op = rth_open(g)
        idx = np.arange(RTH0, RTH_END + 1)
        if op is None or np.isnan(g['c'][idx]).sum() > 30:
            hist.append(None); prev = None; continue
        cl = g['c'][idx]
        mv = np.abs(cl / op - 1)
        valid = [x for x in hist[-lookback:] if x is not None]
        if len(valid) >= lookback - 2 and prev is not None:
            sig = np.nanmean(np.vstack(valid), axis=0)
            UB = max(op, prev) * (1 + sig); LB = min(op, prev) * (1 - sig)
            v = np.nan_to_num(g['v'][idx]); tp = (g['h'][idx] + g['l'][idx] + cl) / 3
            tp = np.where(np.isnan(tp), op, tp)
            vw = np.cumsum(tp * v) / np.maximum(1, np.cumsum(v))
            pnl = 0.0; k = first - 1
            while k < len(idx) - 1:
                if (k + 1) % every != 0 or np.isnan(cl[k]): k += 1; continue
                dr = 1 if cl[k] > UB[k] else -1 if cl[k] < LB[k] else 0
                if not dr: k += 1; continue
                e, j = mkt(g, RTH0 + k, dr)
                if e is None: break
                def sf(jj, dr=dr):
                    m = max(0, min(jj - RTH0 - 1, len(idx) - 1))
                    return max(UB[m], vw[m]) if dr > 0 else min(LB[m], vw[m])
                p, xj = walk(g, j, dr, e, sf)
                pnl += p; k = xj - RTH0 + 1
            out[d] = pnl
        hist.append(mv); prev = cl[-1] if not np.isnan(cl[-1]) else None
    return out


def on_long(a=1, b=929, stop=100):
    out = {}
    for d in TD:
        g = T[d]
        if not ok(g, b): continue
        j = nxt(g, a, a + 30)
        if j is None: continue
        e = g['o'][j] + SLIP; st = e - stop if stop else None
        out[d] = walk(g, j, 1, e, lambda jj: st, None, b)[0]
    return out


def fa_on(confirm=15, ttl=5, window=(930, 1109), target='poc', entry='stop'):
    out = {}
    for i, d in enumerate(TD):
        if i == 0 or d not in F or TD[i - 1] not in F: continue
        g = T[d]; idx = range(0, 930)
        oh = np.nanmax(g['h'][:930]); ol = np.nanmin(g['l'][:930])
        if np.isnan(oh): continue
        T_ = F[TD[i - 1]]['rth_poc'] if target == 'poc' else (oh + ol) / 2
        op = rth_open(g)
        if op is None or op > oh or op < ol: out[d] = 0.0; continue
        res = 0.0; poke = None; eh = -1e9; el = 1e9
        for j in range(*window):
            if not ok(g, j): continue
            eh = max(eh, g['h'][j]); el = min(el, g['l'][j])
            if poke is None:
                if g['h'][j] >= oh + 2 * TICK: poke = (-1, j)
                elif g['l'][j] <= ol - 2 * TICK: poke = (1, j)
                continue
            dr, pj = poke
            if j - pj > confirm: poke = None; continue
            c = g['c'][j]
            if not ((dr < 0 and c < oh) or (dr > 0 and c > ol)): continue
            if entry == 'market':
                e, fj = mkt(g, j, dr)
                if e is None: break
            else:
                trig = (g['l'][j] - TICK) if dr < 0 else (g['h'][j] + TICK)
                fj = None
                for k in range(j + 1, min(j + 1 + ttl, RTH_END)):
                    if not ok(g, k): continue
                    if (g['o'][k] <= trig) if dr < 0 else (g['o'][k] >= trig):
                        e = g['o'][k] + dr * SLIP; fj = k; break
                    if (g['l'][k] <= trig) if dr < 0 else (g['h'][k] >= trig):
                        e = trig + dr * SLIP; fj = k; break
                if fj is None: break
            st = (max(eh, np.nanmax(g['h'][j:fj + 1])) + TICK) if dr < 0 else (min(el, np.nanmin(g['l'][j:fj + 1])) - TICK)
            if (e - st) * dr <= 1 or (T_ - e) * dr <= 4: break
            # stop-entry fill bar: if triggered intrabar, the rest of the bar may hit the stop
            if entry == 'stop' and ((g['h'][fj] >= st) if dr < 0 else (g['l'][fj] <= st)) and not ((g['o'][fj] <= trig) if dr < 0 else (g['o'][fj] >= trig)):
                res = (st - dr * SLIP - e) * dr - FEE
            else:
                res = walk(g, fj, dr, e, lambda jj: st, T_)[0]
            break
        out[d] = res
    return out


if __name__ == '__main__':
    R = {}
    def go(n, o): R[n] = o; rep(n, o)
    go('TRUE noise area 10:30+', noise_area(60))
    go('TRUE noise area 10:00+', noise_area(30))
    go('TRUE gap fade cap150 @9:30 open', gap_fade())
    go('TRUE gap fade cap150 @9:31 (live)', gap_fade(at='next'))
    go('TRUE gap fade nocap @9:30', gap_fade(cap=1e9))
    go('TRUE ON long 18:01-09:29 stop100', on_long())
    go('TRUE ON long stop50', on_long(stop=50))
    go('TRUE ON long nostop', on_long(stop=None))
    go('TRUE FA-ON stop-entry', fa_on())
    go('TRUE FA-ON market-at-close', fa_on(entry='market'))
    json.dump(R, open('/home/claude/research/tlib.json', 'w'))
