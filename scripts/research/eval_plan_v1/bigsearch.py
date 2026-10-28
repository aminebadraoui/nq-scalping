"""Large pre-registered search with a lockbox, TRUE 1-min OHLC fills + footprint delta.
Space = trigger × filter × exit on 5-min RTH bars; one position at a time; flat 15:59.
Discovery 2024-05..2025-12 → top 40 by discovery t → validation 2026-01..05 →
survivors (val t > 1.5, same sign) → lockbox 2026-06..10 opened once at the end."""
import numpy as np, itertools, json, sys, time
from tlib import T, TD, ok, walk, SLIP, RTH0, RTH_END
import grid; FG = grid.load()
B = 5
DISC = ('2024-05-01', '2026-01-01'); VAL = ('2026-01-01', '2026-06-01'); LOCK = ('2026-06-01', '2026-11-01')
# ---------- precompute 5-min bars per day ----------
BARS = {}
for d in TD:
    g = T[d]; f = FG.get(d); out = []
    for s in range(RTH0, RTH_END + 1, B):
        e = min(s + B - 1, RTH_END); seg = [j for j in range(s, e + 1) if ok(g, j)]
        if not seg: continue
        dl = (np.nansum(f['buy'][s:e + 1]) - np.nansum(f['sell'][s:e + 1])) if f is not None else 0.0
        out.append((seg[-1], g['o'][seg[0]], np.nanmax(g['h'][s:e + 1]), np.nanmin(g['l'][s:e + 1]), g['c'][seg[-1]], np.nansum(g['v'][s:e + 1]), dl))
    if len(out) > 40: BARS[d] = np.array(out)
PREV = {}
ds = sorted(BARS)
for i in range(1, len(ds)):
    p = BARS[ds[i - 1]]; PREV[ds[i]] = dict(h=p[:, 2].max(), l=p[:, 3].min(), c=p[-1, 4], o=p[0, 1], rng=p[:, 2].max() - p[:, 3].min())
# ---------- triggers: return +1/-1/0 at bar i ----------
def trig(name, b, i, P):
    c = b[:, 4]
    if name == 'brk12':   return 1 if c[i] > b[i-12:i, 2].max() else -1 if c[i] < b[i-12:i, 3].min() else 0
    if name == 'fade12':  return -trig('brk12', b, i, P)
    if name == 'z24rev':
        w = c[i-23:i+1]; s = w.std(); z = (c[i]-w.mean())/s if s > 0 else 0
        return -1 if z > 2 else 1 if z < -2 else 0
    if name == 'z24mom':  return -trig('z24rev', b, i, P)
    if name == 'dl_fol':
        x = b[i-12:i, 6]; s = x.std(); z = (b[i, 6]-x.mean())/s if s > 0 else 0
        return 1 if z > 2.5 else -1 if z < -2.5 else 0
    if name == 'dl_fade': return -trig('dl_fol', b, i, P)
    if name == 'absorb':
        if b[i, 2] > b[i-12:i, 2].max() and b[i, 6] < 0: return -1
        if b[i, 3] < b[i-12:i, 3].min() and b[i, 6] > 0: return 1
        return 0
    if name == 'pdh_rej':
        if P is None: return 0
        if b[i, 2] > P['h'] and c[i] < P['h']: return -1
        if b[i, 3] < P['l'] and c[i] > P['l']: return 1
        return 0
    if name == 'vwap_x':
        tp = (b[:i+1, 2]+b[:i+1, 3]+c[:i+1])/3; v = b[:i+1, 5]; vw = (tp*v).sum()/max(1, v.sum())
        tpp = (b[:i, 2]+b[:i, 3]+c[:i])/3; vp = b[:i, 5]; vwp = (tpp*vp).sum()/max(1, vp.sum())
        return 1 if c[i] > vw and c[i-1] <= vwp else -1 if c[i] < vw and c[i-1] >= vwp else 0
    if name == 'eng':     # engulfing reversal bar after 3 same-direction bars
        up3 = all(c[k] > b[k, 1] for k in range(i-3, i)); dn3 = all(c[k] < b[k, 1] for k in range(i-3, i))
        if up3 and c[i] < b[i-1, 3]: return -1
        if dn3 and c[i] > b[i-1, 2]: return 1
        return 0
    return 0
TRIG = ['brk12', 'fade12', 'z24rev', 'z24mom', 'dl_fol', 'dl_fade', 'absorb', 'pdh_rej', 'vwap_x', 'eng']
# ---------- filters (known at bar i) ----------
def filt(name, b, i, P, dr):
    if name == 'none': return True
    if name == 'am':   return i < 18          # before 11:00
    if name == 'pm':   return i >= 48         # after 13:30
    if name == 'mid':  return 18 <= i < 48
    if name == 'trend_with':
        return (b[i, 4] - b[0, 1]) * dr > 0
    if name == 'trend_against':
        return (b[i, 4] - b[0, 1]) * dr < 0
    if name == 'hivol':
        return P is not None and (b[:i+1, 2].max()-b[:i+1, 3].min()) > 0.6 * P['rng']
    if name == 'lovol':
        return P is not None and (b[:i+1, 2].max()-b[:i+1, 3].min()) < 0.4 * P['rng']
    return True
FILT = ['none', 'am', 'mid', 'pm', 'trend_with', 'trend_against', 'hivol', 'lovol']
EXIT = [(1.0, 1.0, 6), (1.0, 2.0, 12), (1.5, 1.0, 12), (2.0, 0.5, 12), (1.0, 0.0, 12), (2.0, 0.0, 78)]  # (stop×ATR, target×stop (0=none), max bars)
def run(tn, fn, ex, lo, hi):
    k, R, H = ex; res = {}
    for d in ds:
        if not (lo <= d < hi): continue
        b = BARS[d]; g = T[d]; P = PREV.get(d); busy = -1; pnl = 0.0
        for i in range(24, len(b) - 1):
            ej = int(b[i, 0])
            if ej <= busy or ej >= RTH_END - 5: continue
            dr = trig(tn, b, i, P)
            if not dr or not filt(fn, b, i, P, dr): continue
            a = np.mean(b[i-11:i+1, 2] - b[i-11:i+1, 3]); j = ej + 1
            if not ok(g, j) or a <= 0: continue
            e = g['o'][j] + dr * SLIP; st = e - dr * k * a; tg = e + dr * R * k * a if R else None
            r, xj = walk(g, j, dr, e, lambda _: st, tg, min(RTH_END, ej + H * B))
            pnl += r; busy = xj
        res[d] = pnl
    return res
def tstat(o):
    v = np.array(list(o.values()));  return (v.mean() / (v.std(ddof=1) or 1) * np.sqrt(len(v)), v.mean()) if len(v) > 10 else (0, 0)
if __name__ == '__main__':
    combos = list(itertools.product(TRIG, FILT, EXIT)); print('configs', len(combos), flush=True)
    rows = []; t0 = time.time()
    for n, (tn, fn, ex) in enumerate(combos):
        t, m = tstat(run(tn, fn, ex, *DISC)); rows.append((t, m, tn, fn, ex))
        if n % 100 == 0: print(f'  {n}/{len(combos)} {time.time()-t0:.0f}s', flush=True)
    rows.sort(key=lambda r: -abs(r[0]))
    print('\nTop 40 by |discovery t| → validation:')
    surv = []
    for t, m, tn, fn, ex in rows[:40]:
        tv, mv = tstat(run(tn, fn, ex, *VAL))
        ok_ = np.sign(tv) == np.sign(t) and abs(tv) > 1.5
        print(f'  {tn:8s} {fn:13s} {str(ex):14s} disc t{t:+.2f} ({m:+.1f}/d) → val t{tv:+.2f} ({mv:+.1f}/d) {"SURVIVES" if ok_ else ""}', flush=True)
        if ok_: surv.append((tn, fn, ex, np.sign(t)))
    print('\nLOCKBOX (opened once):')
    for tn, fn, ex, sg in surv:
        tl, ml = tstat(run(tn, fn, ex, *LOCK))
        print(f'  {tn} {fn} {ex} sign{sg:+.0f}: lockbox t{tl:+.2f} ({ml:+.1f}/d) {"PASS" if np.sign(tl)==sg and abs(tl)>1.5 else "fail"}')
    print('expected false discoveries: of', len(combos), 'configs ~', round(len(combos) * 0.07 * 0.07, 1), 'survive disc+val by chance at |t|>1.5')
    json.dump([[*r[:2], r[2], r[3], list(r[4])] for r in rows], open('bigsearch.json', 'w'))
