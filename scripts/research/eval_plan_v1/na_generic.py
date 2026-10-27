"""The published noise-area model (Zarattini/Aziz/Barbon 2024) run on any
session window of the 23h grid, fixed paper parameters (14-day sigma, checks
every 30 min, trailing max(band, VWAP), flat at window end).

anchor: grid minute of the window open (the reference "open")
end:    grid minute of the flat bar
first:  minutes after the anchor of the first check bar END
ref:    'prev' = also use the prior session's window close as in the paper
        (RTH: prior 16:00 close); 'open' = bands around the anchor open only.
bias:   adverse pts added to market fills at check bars (+0.35 measured)"""
import numpy as np, json, sys
from grid import load, mkt, close, walk, NM

G = load()
DATES = sorted(G)


def run(anchor, end, first=60, every=30, ref='prev', bias=0.35, lookback=14, mult=1.0, q='p50'):
    out = {}
    hist = []
    prev_close = None
    for d in DATES:
        g = G[d]
        if np.isnan(g['hi'][anchor - 1]) or np.isnan(g['hi'][end]):
            hist.append(None); prev_close = None
            continue
        op = mkt(g, anchor - 1, 1, 'p50') - 0.25  # unbiased open estimate (strip slip)
        idx = np.arange(anchor, end + 1)
        cl = np.array([close(g, j) if not np.isnan(g['hi'][j]) else np.nan for j in idx])
        mv = np.abs(cl / op - 1)
        valid = [h for h in hist[-lookback:] if h is not None]
        if len(valid) >= lookback - 2 and (prev_close is not None or ref == 'open'):
            sig = np.nanmean(np.vstack(valid), axis=0) * mult
            hr = max(op, prev_close) if ref == 'prev' else op
            lr = min(op, prev_close) if ref == 'prev' else op
            UB = hr * (1 + sig); LB = lr * (1 - sig)
            vol = np.nan_to_num(g['buy'][idx] + g['sell'][idx])
            pp = np.where(np.isnan(g['poc'][idx]), cl, g['poc'][idx])
            pp = np.where(np.isnan(pp), op, pp)
            vw = np.cumsum(pp * vol) / np.maximum(1, np.cumsum(vol))
            pnl = 0.0; n = 0
            k = first - 1
            while k < len(idx) - 1:
                if (k + 1) % every != 0 or np.isnan(cl[k]):
                    k += 1; continue
                px = cl[k]
                dr = 1 if px > UB[k] else -1 if px < LB[k] else 0
                if not dr:
                    k += 1; continue
                gi = anchor + k
                e = mkt(g, gi, dr, q, bias)

                def sf(j, dr=dr):
                    m = j - anchor - 1  # info through bar j-1
                    m = max(0, min(m, len(idx) - 1))
                    return max(UB[m], vw[m]) if dr > 0 else min(LB[m], vw[m])
                p, xj = walk(g, gi, dr, e, sf, None, end)
                pnl += p; n += 1
                k = xj - anchor + 1
            out[d] = pnl if n else 0.0
        hist.append(mv)
        prev_close = cl[-1] if not np.isnan(cl[-1]) else None
    return out


def rep(name, o):
    for yr in ['2024', '2025', '2026', 'all']:
        v = np.array([p for d, p in o.items() if yr == 'all' or d.startswith(yr)])
        if len(v) < 20: continue
        tr = v[v != 0]
        sh = v.mean() / (v.std(ddof=1) or 1)
        print(f'{name:34s} {yr} days={len(v):3d} trade-days={len(tr):3d} pts/day={v.mean():+6.2f} dailySh={sh:+.3f} t={sh*np.sqrt(len(v)):+.2f}')


if __name__ == '__main__':
    # sanity: RTH (anchor 09:30 = 930, flat 15:59 = 1319), first check 10:30
    W = {
        'RTH 10:30+':   dict(anchor=930, end=1319, first=60),
        'RTH 10:00+':   dict(anchor=930, end=1319, first=30),
        'Asia 18:00-02:00': dict(anchor=1, end=479, first=60, ref='open'),
        'Asia 20:00-02:00': dict(anchor=120, end=479, first=60, ref='open'),
        'London 03:00-09:29': dict(anchor=540, end=929, first=60, ref='open'),
        'London 03:00-08:29': dict(anchor=540, end=869, first=60, ref='open'),
        'Data 08:30-09:29': dict(anchor=870, end=929, first=15, every=15, ref='open'),
    }
    res = {}
    for name, kw in W.items():
        o = run(**kw); res[name] = o; rep(name, o)
    json.dump(res, open('/home/claude/research/na_generic.json', 'w'))
