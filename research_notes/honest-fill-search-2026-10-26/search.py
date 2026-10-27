"""Honest-fill strategy search on the footprint archive.

Every trade goes through sim.simulate (rule-for-rule mirror of
web/lib/honestFill.ts, parity-checked): orders are placed only AFTER the
signal bar completes; limits need a one-tick trade-through; stop entries
and stop exits slip 0.25; market entries use the unbiased next-open
estimate (p50) — p80 is re-run as a stress test; the fill bar is
stop-first and never credits the target; MNQ commission 0.95 pt/RT.

Selection uses TRAIN sessions only (< 2026-01-01). The 2026 sessions are a
frozen holdout, reported for every candidate but never used to choose.
"""
import os
HERE = os.environ.get('WORK_DIR', os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
import itertools, json, sys, math
import numpy as np
from sim import simulate

Z = np.load(os.path.join(HERE, 'sessions.npz'))
DATES = list(Z['dates'])
SPLIT = '2026-01-01'
KEYS = ['hi', 'lo', 'buy', 'sell', 't', 'poc', 'bhi', 'shi', 'blo', 'slo']


def roll_mean(x, w):
    c = np.cumsum(np.insert(x, 0, 0.0))
    out = np.full(len(x), np.nan)
    out[w - 1:] = (c[w:] - c[:-w]) / w
    return out


def prev_roll_median(x, w):
    out = np.full(len(x), np.nan)
    for i in range(w, len(x)):
        out[i] = np.median(x[i - w:i])
    return out


def features(S):
    hi, lo = S['hi'], S['lo']
    vol = S['buy'] + S['sell']
    rng = hi - lo
    F = dict(S)
    F['vol'] = vol
    F['rng'] = rng
    F['atr'] = roll_mean(rng, 14)
    F['med60'] = prev_roll_median(vol, 60)
    with np.errstate(invalid='ignore', divide='ignore'):
        F['bsh'] = np.where(vol > 0, S['buy'] / vol, 0.5)
    n = len(hi)
    F['hh30'] = np.array([hi[max(0, i - 30):i].max() if i >= 30 else np.inf for i in range(n)])
    F['ll30'] = np.array([lo[max(0, i - 30):i].min() if i >= 30 else -np.inf for i in range(n)])
    F['shigh'] = np.array([hi[:i].max() if i > 0 else np.inf for i in range(n)])
    F['slow'] = np.array([lo[:i].min() if i > 0 else -np.inf for i in range(n)])
    cv = np.cumsum(vol)
    F['vwap'] = np.cumsum(S['poc'] * vol) / np.where(cv > 0, cv, 1)
    F['mid'] = (hi + lo) / 2
    F['vw'], F['vsd'] = vwap_sigma(F)
    return F


def in_window(t, w):
    if w == 'all':
        return True
    rth = 570 <= t < 960
    if w == 'rth':
        return rth
    if w == 'open':
        return 570 <= t < 660
    return not rth  # 'night'


# ------------------------------------------------------------------ #
# strategy families: return list of (i, dir, order) for one session
# order = ('market',) | ('limit', price, ttl) | ('stop', price, ttl)
# ------------------------------------------------------------------ #

def sig_breakout(F, p):
    out = []
    for i in range(60, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        a, m = F['atr'][i], F['med60'][i]
        if not (a > 0 and m > 0): continue
        if F['rng'][i] < p['m'] * a or F['vol'][i] < p['k'] * m: continue
        b = F['bsh'][i]
        if b >= p['s']:
            out.append((i, 1, ('stop', F['hi'][i] + 0.25, 3)))
        elif b <= 1 - p['s']:
            out.append((i, -1, ('stop', F['lo'][i] - 0.25, 3)))
    return out


def sig_impulse_pullback(F, p):
    out = []
    for i in range(60, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        a, m = F['atr'][i], F['med60'][i]
        if not (a > 0 and m > 0): continue
        if F['rng'][i] < p['m'] * a or F['vol'][i] < p['k'] * m: continue
        b = F['bsh'][i]
        poc = F['poc'][i]
        if b >= p['s']:
            out.append((i, 1, ('limit', poc, 10)))
        elif b <= 1 - p['s']:
            out.append((i, -1, ('limit', poc, 10)))
    return out


def sig_absorption(F, p):
    """new 30-bar extreme on heavy volume where the extreme ticks are
    dominated by the OPPOSITE side (passive absorption) → fade it once the
    bar's other end breaks (stop entry)."""
    out = []
    for i in range(60, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        m = F['med60'][i]
        if not (m > 0) or F['vol'][i] < p['k'] * m: continue
        if F['hi'][i] > F['hh30'][i]:
            top_b, top_s = F['bhi'][i], F['shi'][i]
            if top_s >= p['r'] * max(top_b, 1) and top_s >= p['lots']:
                out.append((i, -1, ('stop', F['lo'][i] - 0.25, p['ttl'])))
        elif F['lo'][i] < F['ll30'][i]:
            bot_b, bot_s = F['blo'][i], F['slo'][i]
            if bot_b >= p['r'] * max(bot_s, 1) and bot_b >= p['lots']:
                out.append((i, 1, ('stop', F['hi'][i] + 0.25, p['ttl'])))
    return out


def sig_divergence(F, p):
    """new SESSION extreme printed on net-opposite flow (delta divergence)
    and above-normal volume → fade."""
    out = []
    for i in range(90, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        m = F['med60'][i]
        if not (m > 0) or F['vol'][i] < p['k'] * m: continue
        b = F['bsh'][i]
        if F['hi'][i] > F['shigh'][i] and b <= 1 - p['s']:
            o = ('market',) if p['entry'] == 'market' else ('stop', F['lo'][i] - 0.25, 3)
            out.append((i, -1, o))
        elif F['lo'][i] < F['slow'][i] and b >= p['s']:
            o = ('market',) if p['entry'] == 'market' else ('stop', F['hi'][i] + 0.25, 3)
            out.append((i, 1, o))
    return out


def sig_vwap_revert(F, p):
    """price stretched ≥ z·ATR from session VWAP on a volume spike whose
    flow already turned back toward VWAP → limit at the bar's mid toward VWAP."""
    out = []
    for i in range(60, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        a, m = F['atr'][i], F['med60'][i]
        if not (a > 0 and m > 0) or F['vol'][i] < p['k'] * m: continue
        dev = (F['mid'][i] - F['vwap'][i]) / a
        b = F['bsh'][i]
        if dev >= p['z'] and b <= 1 - p['s']:
            out.append((i, -1, ('limit', round(F['mid'][i] * 4) / 4, 5)))
        elif dev <= -p['z'] and b >= p['s']:
            out.append((i, 1, ('limit', round(F['mid'][i] * 4) / 4, 5)))
    return out


FAMILIES = {
    'breakout': (sig_breakout, dict(k=[1.5, 2.5], s=[0.6, 0.7], m=[1.0, 1.5], win=['all', 'rth', 'night'])),
    'impulse_pullback': (sig_impulse_pullback, dict(k=[1.5, 2.5], s=[0.6, 0.7], m=[1.0, 1.5], win=['all', 'rth', 'night'])),
    'absorption': (sig_absorption, dict(k=[1.5, 2.5], r=[1.5, 2.5], lots=[10, 30], ttl=[3], win=['all', 'rth', 'night'])),
    'divergence': (sig_divergence, dict(k=[1.0, 2.0], s=[0.55, 0.6], entry=['market', 'stop'], win=['all', 'rth', 'night'])),
    'vwap_revert': (sig_vwap_revert, dict(k=[1.5, 2.5], z=[2.0, 3.0], s=[0.55, 0.6], win=['all', 'rth', 'night'])),
}
# ---------------- level-based families (fills exact: limit / stop) ----------------

def vwap_sigma(F):
    """session VWAP and volume-weighted σ of POC prices through each bar"""
    v = F['vol']; p = F['poc']
    cv = np.cumsum(v); cv = np.where(cv > 0, cv, 1)
    m = np.cumsum(p * v) / cv
    m2 = np.cumsum(p * p * v) / cv
    return m, np.sqrt(np.maximum(m2 - m * m, 0))


def sig_vwap_band_fade(F, p):
    """rest a limit at VWAP ± z·σ (computed from completed bars) when the
    last bar's volume is NOT expanding (no breakout fuel) — fade back to VWAP"""
    out = []
    vw, sd = F['vw'], F['vsd']
    for i in range(60, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        if not (sd[i] > 0): continue
        m = F['med60'][i]
        if not (m > 0) or F['vol'][i] > p['vmax'] * m: continue
        up = round((vw[i] + p['z'] * sd[i]) * 4) / 4
        dn = round((vw[i] - p['z'] * sd[i]) * 4) / 4
        if F['hi'][i] < up and F['hi'][i] >= up - p['near'] * F['atr'][i]:
            out.append((i, -1, ('limit', up, 5)))
        elif F['lo'][i] > dn and F['lo'][i] <= dn + p['near'] * F['atr'][i]:
            out.append((i, 1, ('limit', dn, 5)))
    return out


def sig_prior_level(F, p):
    """prior session high / low / POC as resting liquidity: when price
    approaches within `near`·ATR, rest a limit AT the level (fade) — or a
    stop just through it (break) — depending on `mode`"""
    out = []
    lv = F['plv'][p['level']]
    if lv is None: return out
    for i in range(30, len(F['hi']) - 1):
        if not in_window(F['t'][i], p['win']): continue
        a = F['atr'][i]
        if not (a > 0): continue
        if F['lo'][i] > lv and F['lo'][i] - lv <= p['near'] * a:     # above, approaching from above
            if p['mode'] == 'fade':
                out.append((i, 1, ('limit', lv, 5)))
            else:
                out.append((i, -1, ('stop', lv - 0.25, 5)))
        elif F['hi'][i] < lv and lv - F['hi'][i] <= p['near'] * a:  # below, approaching from below
            if p['mode'] == 'fade':
                out.append((i, -1, ('limit', lv, 5)))
            else:
                out.append((i, 1, ('stop', lv + 0.25, 5)))
    return out


def sig_ib_breakout(F, p):
    """RTH initial balance (first `ib` minutes after 9:30 ET): after it is
    set, a stop order 1 tick outside each side, armed once per side, only
    if the IB-period volume was ≥ `k`× the session's prior median minute"""
    out = []
    t = F['t']
    idx = [i for i in range(len(t)) if 570 <= t[i] < 570 + p['ib']]
    if len(idx) < p['ib'] // 2: return out
    ibh = F['hi'][idx].max(); ibl = F['lo'][idx].min()
    last = idx[-1]
    m = F['med60'][last]
    if not (m > 0) or F['vol'][idx].mean() < p['k'] * m: return out
    # one signal at the IB close: both stops; the first to trigger is the trade
    # (modelled as two candidates; the busy rule keeps one at a time)
    out.append((last, 1, ('stop', ibh + 0.25, p['ttl'])))
    out.append((last, -1, ('stop', ibl - 0.25, p['ttl'])))
    return out


FAMILIES.update({
    'vwap_band_fade': (sig_vwap_band_fade, dict(z=[2.0, 2.5, 3.0], vmax=[1.0, 2.0], near=[0.5, 1.0], win=['all', 'rth', 'night'])),
    'prior_level': (sig_prior_level, dict(level=['high', 'low', 'poc'], mode=['fade', 'break'], near=[0.5, 1.0], win=['all', 'rth'])),
    'ib_breakout': (sig_ib_breakout, dict(ib=[30, 60], k=[0.0, 1.5], ttl=[60, 180])),
})


# exits: stop = a·ATR (floor 3.5 pt), target = R·stop, 60-bar time exit
EXITS = [dict(a=a, R=R) for a in (1.0, 2.0) for R in (1.0, 2.0)]


def run_config(fam, p, ex, sessions, mq='p50'):
    fn = FAMILIES[fam][0]
    trades = []
    for d, F in sessions:
        busy_until = -1
        for (i, dr, o) in fn(F, p):
            if i <= busy_until: continue
            stop_pts = max(3.5, round(ex['a'] * F['atr'][i] * 4) / 4)
            tgt = round(ex['R'] * stop_pts * 4) / 4
            if o[0] == 'market':
                r = simulate(F, i, dr, 'market', stop_pts=stop_pts, tgt_pts=tgt, mq=mq)
            else:
                r = simulate(F, i, dr, o[0], price=o[1], ttl=o[2], stop_pts=stop_pts, tgt_pts=tgt, mq=mq)
            if r is None: continue
            if r['hit'] == 'nofill':
                continue  # an unfilled resting order does not block (the flat check is at placement)
            busy_until = r['xi']
            trades.append((d, dr, r['gross'], r['net'], stop_pts, r['hit'], int(F['t'][i])))
    return trades


def cfg_name(fam, p, ex):
    return fam + '|' + ','.join(f'{k}={v}' for k, v in p.items()) + f'|a={ex["a"]},R={ex["R"]}'


def all_configs():
    for fam, (_, grid) in FAMILIES.items():
        ks = list(grid)
        for vals in itertools.product(*[grid[k] for k in ks]):
            p = dict(zip(ks, vals))
            for ex in EXITS:
                yield fam, p, ex


if __name__ == '__main__':
    import pickle, time
    t0 = time.time()
    sessions = []
    prev = None
    for d in DATES:
        S = {k: Z[f'{d}|{k}'] for k in KEYS}
        F = features(S)
        if prev is None:
            F['plv'] = {'high': None, 'low': None, 'poc': None}
        else:
            # prior session's high / low / volume POC (rounded to the tick)
            ph, pl = float(prev['hi'].max()), float(prev['lo'].min())
            vols = {}
            for pp, vv in zip(prev['poc'], prev['vol']):
                vols[pp] = vols.get(pp, 0) + vv
            F['plv'] = {'high': ph, 'low': pl, 'poc': float(max(vols, key=vols.get))}
        prev = F
        sessions.append((d, F))
    print('features', round(time.time() - t0), 's', flush=True)
    mq = sys.argv[1] if len(sys.argv) > 1 else 'p80'
    res = {}
    cfgs = list(all_configs())
    for n, (fam, p, ex) in enumerate(cfgs):
        res[cfg_name(fam, p, ex)] = run_config(fam, p, ex, sessions, mq)
        if n % 50 == 0:
            print(n, '/', len(cfgs), round(time.time() - t0), 's', flush=True)
    pickle.dump(res, open(os.path.join(HERE, f'results_{mq}.pkl'), 'wb'))
    print('done', len(cfgs), round(time.time() - t0), 's')
