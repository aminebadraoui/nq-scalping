"""Documented, clock-based NQ anomalies scored with honest fills.

Clock-timed entries are NOT selected on the bar's flow, so the median (p50)
next-open estimate is unbiased for them (+0.07 pt over all bars on the 27
twin sessions); + 0.25 pt slip per side, MNQ commission 0.95 pt RT.
All parameters come from the literature, not from this data (no fitting).
Output: per-day P&L in points per contract, with intraday worst-case
excursion, per strategy."""
import numpy as np, json, sys
from sim import market_est, close_est, SLIP, FEE

Z = np.load('sessions.npz')
DATES = list(Z['dates'])
K = ['hi', 'lo', 'buy', 'sell', 't']
S_ = {d: {k: Z[f'{d}|{k}'] for k in K} for d in DATES}


def bar_at(S, tmin, evening=False):
    t = S['t']
    m = (t >= 1080) if evening else (t < 1080)
    ii = np.where(m & (t >= tmin))[0] if not evening else np.where(m & (t >= tmin))[0]
    return int(ii[0]) if len(ii) else None


def trade(S, k, m, d, stop_pts=None):
    """market in at the open of bar k, out at the close of bar m (or a stop)"""
    if k is None or m is None or k < 1 or m < k:
        return None
    e = market_est(S, k - 1, d, 'p50') + d * SLIP
    mae = 0.0
    for j in range(k, m + 1):
        adv = (e - S['lo'][j]) if d > 0 else (S['hi'][j] - e)
        mae = max(mae, adv)
        if stop_pts is not None and adv >= stop_pts:
            return dict(pnl=-stop_pts - SLIP - FEE, mae=stop_pts + SLIP, stop=stop_pts)
    x = close_est(S, m) - d * SLIP
    return dict(pnl=(x - e) * d - FEE, mae=mae, stop=stop_pts)


def px_close(S, tmin, evening=False):
    k = bar_at(S, tmin, evening)
    return None if k is None else close_est(S, k)


def month_rank(dates):
    """trading-day position in month: (index from start, index from end)"""
    by = {}
    for d in dates: by.setdefault(d[:7], []).append(d)
    pos = {}
    for mth, ds in by.items():
        ds.sort()
        for i, d in enumerate(ds): pos[d] = (i, len(ds) - 1 - i)
    return pos


POS = month_rank(DATES)
out = {}
for n, d in enumerate(DATES):
    S = S_[d]
    P = S_[DATES[n - 1]] if n > 0 else None
    row = {}
    # S1 overnight drift: long from the first evening bar to 9:29 ET
    k0 = 1 if len(S['t']) > 2 and S['t'][0] >= 1080 else None
    row['overnight_long'] = trade(S, k0, bar_at(S, 569), 1)
    # S2 intraday momentum (Gao-Han-Li-Zhou): sign of prior 16:00 close → 10:00,
    # trade 15:30 → 16:00 in that direction
    pc = px_close(P, 959) if P is not None else None
    p10 = px_close(S, 599)
    if pc is not None and p10 is not None and p10 != pc:
        dr = 1 if p10 > pc else -1
        row['intraday_mom'] = trade(S, bar_at(S, 930), bar_at(S, 959), dr)
        # S2b: also require the 13:30–15:30 return to agree (their r12)
        a, b = px_close(S, 809), px_close(S, 929)
        if a is not None and b is not None and (b - a) * dr > 0:
            row['intraday_mom_r12'] = trade(S, bar_at(S, 930), bar_at(S, 959), dr)
    # S3 turn of month: long RTH 9:30 → 15:59 on the last day and first 3 days
    i0, iend = POS[d]
    if iend == 0 or i0 <= 2:
        row['turn_of_month'] = trade(S, bar_at(S, 570), bar_at(S, 959), 1)
    # S5 gap fade: |9:30 open − prior close| > 0.25% → fade until 11:00, stop = gap size
    if pc is not None:
        k = bar_at(S, 570)
        if k is not None and k >= 1:
            op = market_est(S, k - 1, 1, 'p50')
            g = (op - pc) / pc
            if abs(g) > 0.0025:
                row['gap_fade'] = trade(S, k, bar_at(S, 659), -1 if g > 0 else 1, stop_pts=abs(op - pc))
    out[d] = row

strats = sorted({s for r in out.values() for s in r})
print(f'{"strategy":20s} {"yr":5s} {"n":>4s} {"WR":>6s} {"pts/tr":>7s} {"sum":>8s} {"t":>6s} {"worstMAE":>8s}')
for s in strats:
    for yr in ['2024', '2025', '2026', 'all']:
        v = [(d, out[d][s]) for d in DATES if s in out[d] and out[d][s] and (yr == 'all' or d.startswith(yr))]
        if not v: continue
        p = np.array([x['pnl'] for _, x in v]); m = np.array([x['mae'] for _, x in v])
        t = p.mean() / (p.std(ddof=1) or 1) * np.sqrt(len(p))
        print(f'{s:20s} {yr:5s} {len(p):4d} {100*(p>0).mean():5.1f}% {p.mean():+7.2f} {p.sum():+8.1f} {t:+6.2f} {m.max():8.1f}')
json.dump({d: {s: x for s, x in r.items() if x} for d, r in out.items()}, open('anomalies.json', 'w'))
