"""Per-session feature store from the raw footprint archive.

For each ETH session file (17:00 CT prior day → 16:00 CT) compute, in ET:
  RTH (09:30–15:59) volume profile: POC, VAH, VAL (70% value area), high, low,
  open estimate (p50 next-open from the 09:29 bar), close estimate (14:59 CT bar),
  delta; overnight (18:00–09:29) high/low/POC/VAH/VAL/delta/volume;
  initial balance (09:30–10:29) high/low.
Everything here is known by the END of the session (or by 09:29 for the ON
fields) — strategies must only use a session's RTH fields for LATER days.
Output: features.json  {date: {...}}"""
import gzip, json, os, glob, numpy as np
from multiprocessing import Pool
from sim import market_est, close_est

A = '/home/claude/arch'


def value_area(prices, vols, frac=0.70):
    if len(prices) == 0 or vols.sum() <= 0:
        return None
    o = np.argsort(prices); p = prices[o]; v = vols[o]
    i = int(np.argmax(v)); lo = hi = i; tot = v.sum(); acc = v[i]
    while acc < frac * tot and (lo > 0 or hi < len(p) - 1):
        up = v[hi + 1] if hi < len(p) - 1 else -1
        dn = v[lo - 1] if lo > 0 else -1
        if up >= dn: hi += 1; acc += up
        else: lo -= 1; acc += dn
    return float(p[i]), float(p[hi]), float(p[lo])  # poc, vah, val


def one(f):
    d = os.path.basename(f)[:10]
    js = json.load(gzip.open(f))
    c = js['candles']
    if len(c) < 600:
        return d, None
    n = len(c)
    hi = np.array([x['high'] / 100 for x in c]); lo = np.array([x['low'] / 100 for x in c])
    buy = np.array([x['buy'] for x in c], float); sell = np.array([x['sell'] for x in c], float)
    t = np.array([((int(x['t'][11:13]) + 1) % 24) * 60 + int(x['t'][14:16]) for x in c])
    S = dict(hi=hi, lo=lo, buy=buy, sell=sell)
    rth = np.where((t >= 570) & (t < 960))[0]
    on = np.where((t >= 1080) | (t < 570))[0]
    if len(rth) < 380 or len(on) < 300:
        return d, None

    def prof(idx):
        acc = {}
        for i in idx:
            for p, v in (c[i]['levels'] or {}).items():
                acc[int(p)] = acc.get(int(p), 0) + v[0]
        if not acc:
            return None
        ps = np.array(list(acc)) / 100; vs = np.array(list(acc.values()), float)
        return value_area(ps, vs)

    pr = prof(rth); po = prof(on)
    if pr is None or po is None:
        return d, None
    ib = rth[:60]
    out = dict(
        rth_open=float(market_est(S, rth[0] - 1, 1, 'p50')),
        rth_close=float(close_est(S, rth[-1])),
        rth_hi=float(hi[rth].max()), rth_lo=float(lo[rth].min()),
        rth_poc=pr[0], rth_vah=pr[1], rth_val=pr[2],
        rth_delta=float((buy - sell)[rth].sum()), rth_vol=float((buy + sell)[rth].sum()),
        on_hi=float(hi[on].max()), on_lo=float(lo[on].min()),
        on_poc=po[0], on_vah=po[1], on_val=po[2],
        on_delta=float((buy - sell)[on].sum()), on_vol=float((buy + sell)[on].sum()),
        on_last=float(close_est(S, rth[0] - 1)),
        ib_hi=float(hi[ib].max()), ib_lo=float(lo[ib].min()),
        n_rth=int(len(rth)),
    )
    return d, out


if __name__ == '__main__':
    files = sorted(f for f in glob.glob(A + '/*_ETH.json.gz') if not os.path.basename(f).startswith('ohlc'))
    with Pool(os.cpu_count()) as p:
        res = dict(r for r in p.map(one, files) if r[1] is not None)
    json.dump(res, open('/home/claude/research/features.json', 'w'))
    print(len(res), min(res), max(res))
