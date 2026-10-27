"""Load the footprint archive into per-session numpy arrays (cached)."""
import os
HERE = os.environ.get('WORK_DIR', os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
import gzip, json, os, glob, numpy as np
A = os.environ.get('ARCHIVE_DIR', os.path.expanduser('~/.cache/nq-archive'))
OUT = os.path.join(HERE, 'sessions.npz')

def load_one(f):
    d = json.load(gzip.open(f))
    c = d['candles']
    n = len(c)
    hi = np.empty(n); lo = np.empty(n); buy = np.empty(n); sell = np.empty(n)
    tmin = np.empty(n, dtype=np.int32)          # minutes since midnight, ET
    poc = np.empty(n); bhi = np.empty(n); slo = np.empty(n)  # POC, buy vol at top 2 ticks, sell vol at bottom 2 ticks
    shi = np.empty(n); blo = np.empty(n)
    for i, x in enumerate(c):
        hi[i] = x['high'] / 100; lo[i] = x['low'] / 100
        buy[i] = x['buy']; sell[i] = x['sell']
        hh, mm = int(x['t'][11:13]), int(x['t'][14:16])
        off = x['t'][19:]  # -05:00 (CDT) or -06:00 (CST) → ET = CT + 1h
        tmin[i] = ((hh + 1) % 24) * 60 + mm
        lv = x['levels']
        if lv:
            ps = np.array([int(p) for p in lv]) / 100
            vb = np.array([v[1] for v in lv.values()], float)
            vs = np.array([v[2] for v in lv.values()], float)
            tot = vb + vs
            poc[i] = ps[np.argmax(tot)]
            top = ps >= hi[i] - 0.5; bot = ps <= lo[i] + 0.5
            bhi[i] = vb[top].sum(); shi[i] = vs[top].sum()
            blo[i] = vb[bot].sum(); slo[i] = vs[bot].sum()
        else:
            poc[i] = (hi[i] + lo[i]) / 2; bhi[i] = shi[i] = blo[i] = slo[i] = 0
    return dict(hi=hi, lo=lo, buy=buy, sell=sell, t=tmin, poc=poc, bhi=bhi, shi=shi, blo=blo, slo=slo)

if __name__ == '__main__':
    files = sorted(f for f in glob.glob(A + '/*_ETH.json.gz') if not os.path.basename(f).startswith('ohlc'))
    out = {}
    dates = []
    for f in files:
        d = os.path.basename(f)[:10]
        s = load_one(f)
        if len(s['hi']) < 60: continue
        dates.append(d)
        for k, v in s.items(): out[f'{d}|{k}'] = v
    out['dates'] = np.array(dates)
    np.savez_compressed(OUT, **out)
    print(len(dates), dates[0], dates[-1])
