"""Two PUBLISHED intraday trend strategies, run with their published rules
(no fitting) on NQ, honest fills:

1. Noise-Area intraday momentum (Zarattini, Aziz, Barbon 2024, SPY):
   sigma(t) = 14-day mean |close(t)/open − 1| at each minute of RTH;
   UB = max(open, prev 16:00 close)·(1+sigma), LB = min(...)·(1−sigma);
   at :00/:30 from 10:00, long above UB / short below LB; trailing stop
   max(UB, VWAP) (long) / min(LB, VWAP) (short) checked every bar as a
   stop order; flat at 15:59.
2. Opening-range breakout (Zarattini & Aziz 2023 + the common stop-order
   variant): OR = first N minutes of RTH; (a) stop orders at OR high/low,
   first trigger wins, stop = opposite OR side, exit 10R or 15:59;
   (b) the paper's version: direction = sign of the OR candle (here:
   the OR's net delta, buy−sell, since the archive has no closes),
   market entry at the next open, same stop/exit.

Prices: "price at T" = the median close estimate of the bar before T;
market entries use the p50 next-open estimate (clock-timed) — and the
conservative p80 is reported too; stops are stop orders (+0.25 slip);
MNQ commission 0.95 pt RT. Output: per-day net points (1 contract)."""
import numpy as np, json, sys
from sim import market_est, close_est, SLIP, FEE, TICK

Z = np.load('sessions.npz')
DATES = list(Z['dates'])
K = ['hi', 'lo', 'buy', 'sell', 't', 'poc']
SS = {d: {k: Z[f'{d}|{k}'] for k in K} for d in DATES}


def rth_idx(S):
    t = S['t']
    ii = np.where((t >= 570) & (t < 960))[0]
    return ii if len(ii) >= 380 else None


def walk_exit(S, ii_after, entry, d, stop_fn, tgt=None):
    """walk bars after the fill: stop_fn(j) gives the current stop level"""
    for j in ii_after:
        st = stop_fn(j)
        if st is not None and ((S['lo'][j] <= st) if d > 0 else (S['hi'][j] >= st)):
            return (st - d * SLIP - entry) * d - FEE
        if tgt is not None and ((S['hi'][j] >= tgt + TICK) if d > 0 else (S['lo'][j] <= tgt - TICK)):
            return (tgt - entry) * d - FEE
    return (close_est(S, ii_after[-1]) - d * SLIP - entry) * d - FEE


def noise_area(mq='p50'):
    out = {}
    hist = []  # list of arrays |close/open − 1| per RTH minute for prior days
    prev_close = None
    for d in DATES:
        S = SS[d]; ii = rth_idx(S)
        if ii is None:
            continue
        op = market_est(S, ii[0] - 1, 1, 'p50')
        closes = np.array([close_est(S, j) for j in ii])
        mv = np.abs(closes / op - 1)
        if len(hist) >= 14 and prev_close is not None:
            sig = np.mean(np.array([h[:len(ii)] for h in hist[-14:] if len(h) >= len(ii)] or [mv]), axis=0)
            hi_ref, lo_ref = max(op, prev_close), min(op, prev_close)
            UB = hi_ref * (1 + sig); LB = lo_ref * (1 - sig)
            # RTH VWAP from the POC proxy
            vol = S['buy'][ii] + S['sell'][ii]
            vw = np.cumsum(S['poc'][ii] * vol) / np.maximum(1, np.cumsum(vol))
            pnl = 0.0; pos = 0; entry = 0.0; k = 0
            n = len(ii)
            while k < n - 1:
                t = S['t'][ii[k]]
                if pos == 0 and t >= 600 and t % 30 == 29:          # the bar ending at :00/:30
                    px = closes[k]
                    dr = 1 if px > UB[k] else -1 if px < LB[k] else 0
                    if dr:
                        entry = market_est(S, ii[k], dr, mq) + dr * SLIP
                        pos = dr
                        # walk from the next bar with the trailing stop
                        def stopf(jj, dr=dr):
                            m = int(np.searchsorted(ii, jj)) - 1
                            m = max(0, min(m, n - 1))
                            return max(UB[m], vw[m]) if dr > 0 else min(LB[m], vw[m])
                        # find exit bar index
                        exited = False
                        for m in range(k + 1, n):
                            j = ii[m]
                            st = stopf(j)
                            if (S['lo'][j] <= st) if dr > 0 else (S['hi'][j] >= st):
                                pnl += (st - dr * SLIP - entry) * dr - FEE
                                k = m; pos = 0; exited = True
                                break
                        if not exited:
                            pnl += (closes[n - 1] - dr * SLIP - entry) * dr - FEE
                            k = n; pos = 0
                        continue
                k += 1
            out[d] = pnl
        hist.append(mv)
        prev_close = closes[-1]
    return out


def orb(N, mode, mq='p50', R=10):
    out = {}
    for d in DATES:
        S = SS[d]; ii = rth_idx(S)
        if ii is None:
            continue
        orr = ii[:N]
        H = S['hi'][orr].max(); L = S['lo'][orr].min()
        rest = ii[N:]
        if mode == 'stop':
            # OCO stop orders; first bar that trades through either side
            fill = None
            for m, j in enumerate(rest):
                up = S['hi'][j] >= H + TICK; dn = S['lo'][j] <= L - TICK
                if up and dn:
                    fill = None; break  # both in one bar: unknown order → skip the day
                if up or dn:
                    dr = 1 if up else -1
                    trig = H + TICK if up else L - TICK
                    base = max(trig, S['lo'][j]) if dr > 0 else min(trig, S['hi'][j])
                    entry = base + dr * SLIP
                    stop = L - TICK if dr > 0 else H + TICK
                    risk = abs(entry - stop)
                    # fill bar: stop first if the bar also reached it
                    if (S['lo'][j] <= stop) if dr > 0 else (S['hi'][j] >= stop):
                        out[d] = (stop - dr * SLIP - entry) * dr - FEE
                    else:
                        out[d] = walk_exit(S, rest[m + 1:] if m + 1 < len(rest) else rest[-1:], entry, dr, lambda _: stop, entry + dr * R * risk)
                    fill = True
                    break
        else:
            dl = (S['buy'][orr] - S['sell'][orr]).sum()
            if dl == 0:
                continue
            dr = 1 if dl > 0 else -1
            entry = market_est(S, orr[-1], dr, mq) + dr * SLIP
            stop = L - TICK if dr > 0 else H + TICK
            risk = abs(entry - stop)
            if risk <= 0:
                continue
            out[d] = walk_exit(S, rest, entry, dr, lambda _: stop, entry + dr * R * risk)
    return out


def report(name, o):
    for yr in ['2024', '2025', '2026', 'all']:
        v = np.array([p for d, p in o.items() if yr == 'all' or d.startswith(yr)])
        if len(v) < 5: continue
        days = len([d for d in DATES if yr == 'all' or d.startswith(yr)])
        daily = np.zeros(days); daily[:len(v)] = v  # no-trade days = 0
        sh = daily.mean() / (daily.std(ddof=1) or 1)
        t = v.mean() / (v.std(ddof=1) or 1) * np.sqrt(len(v))
        print(f'{name:28s} {yr:4s} n={len(v):4d} WR={100*(v>0).mean():5.1f}% pts/tr={v.mean():+7.2f} sum={v.sum():+8.1f} t={t:+5.2f} dailySharpe={sh:+.3f}')


if __name__ == '__main__':
    res = {}
    for mq in ['p50', 'p80']:
        o = noise_area(mq); res[f'noise_area_{mq}'] = o; report(f'noise_area {mq}', o)
    for N in [5, 15, 30]:
        o = orb(N, 'stop'); res[f'orb{N}_stop'] = o; report(f'orb{N} stop-orders 10R', o)
        o = orb(N, 'stop', R=2); res[f'orb{N}_stop_2R'] = o; report(f'orb{N} stop-orders 2R', o)
        for mq in ['p50', 'p80']:
            o = orb(N, 'delta', mq); res[f'orb{N}_delta_{mq}'] = o; report(f'orb{N} delta-dir {mq}', o)
    json.dump(res, open('intraday_trend.json', 'w'))
