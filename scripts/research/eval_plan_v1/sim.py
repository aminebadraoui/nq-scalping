"""Python mirror of web/lib/honestFill.ts simulateHonest (kept rule-for-rule
identical; parity is checked against the TS module by parity.py)."""
import numpy as np

TICK = 0.25
FEE = 0.95       # MNQ $1.90 RT / $2 per pt
SLIP = 0.25
P80 = [0.55, 0.57, 0.82, 0.91, 0.94]
P50 = [0.23, 0.26, 0.51, 0.73, 0.77]


def bucket(sh):
    if sh < 0.3: return 0
    if sh < 0.4: return 1
    if sh < 0.6: return 2
    if sh < 0.7: return 3
    return 4


def rtick(p):
    return round(p / TICK) * TICK


def share(buy, sell, i, d):
    tot = buy[i] + sell[i]
    if tot <= 0: return 0.5
    return (buy[i] if d > 0 else sell[i]) / tot


def market_est(S, i, d, q='p80'):
    hi, lo = S['hi'][i], S['lo'][i]
    q = (P80 if q == 'p80' else P50)[bucket(share(S['buy'], S['sell'], i, d))]
    return rtick(lo + q * (hi - lo)) if d > 0 else rtick(hi - q * (hi - lo))


def close_est(S, i):
    hi, lo = S['hi'][i], S['lo'][i]
    return rtick(lo + P50[bucket(share(S['buy'], S['sell'], i, 1))] * (hi - lo))


def simulate(S, sig, d, kind, price=None, ttl=0, stop_pts=None, tgt_pts=None, hold=60, slip=SLIP, fee=FEE, mq='p80'):
    """returns dict or None (invalid) ; dict['hit']=='nofill' when unfilled"""
    hi, lo = S['hi'], S['lo']
    n = len(hi)
    first = sig + 1
    if first >= n:
        return {'hit': 'nofill'}
    fill_after = False
    if kind == 'market':
        fi = first
        entry = market_est(S, sig, d, mq) + d * slip
        fill_after = True
    else:
        fi = -1
        last = min(n - 1, sig + ttl)
        for j in range(first, last + 1):
            if kind == 'limit':
                if (lo[j] <= price - TICK) if d > 0 else (hi[j] >= price + TICK):
                    fi, entry = j, price
                    break
            else:
                if (hi[j] >= price) if d > 0 else (lo[j] <= price):
                    base = max(price, lo[j]) if d > 0 else min(price, hi[j])
                    fi, entry = j, base + d * slip
                    break
        if fi < 0:
            return {'hit': 'nofill'}
    stop = entry - d * stop_pts
    tgt = entry + d * tgt_pts
    if not (stop_pts > 0 and tgt_pts > 0):
        return None
    end = min(n - 1, fi + hold)
    hit = 'time'
    ex = None
    xi = end
    for j in range(fi, end + 1):
        fb = j == fi
        sh = (lo[j] <= stop) if d > 0 else (hi[j] >= stop)
        th = (hi[j] >= tgt + TICK) if d > 0 else (lo[j] <= tgt - TICK)
        if sh:
            hit, ex, xi = 'stop', stop - d * slip, j
            break
        if th and (not fb or fill_after):
            hit, ex, xi = 'target', tgt, j
            break
    if hit == 'time':
        ex = close_est(S, end) - d * slip
    g = (ex - entry) * d
    return {'hit': hit, 'fi': fi, 'xi': xi, 'entry': entry, 'exit': ex, 'gross': g, 'net': g - fee}
