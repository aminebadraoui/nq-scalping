"""MFF 50K Rapid EOD eval simulator over per-day stream P&L (pts per 1 MNQ).
Rules: +$3,000 target; EOD trailing $2,000 drawdown (floor = max EOD balance
- 2000, locks at 50,100), breach intraday (approximated by the day's worst
intraday dip: morning streams first, then the afternoon stream, with each
losing trade's loss counted in full before any later gain); best day ≤ 30% of
total profit; ≥ 4 trading days. $2 per point per MNQ.

policy(state) -> dict stream -> contracts (0 = skip). state has bal, floor,
cushion, day_n, profit, best, locked."""
import numpy as np, json

USD = 2.0
OVERNIGHT = ('ON',)
MORNING = ('GF', 'FA')     # resolved before the afternoon stream
AFTERNOON = ('NA',)


def run_eval(days, streams, policy, start=0, maxd=500, daily_stop=None, daily_lock=None):
    bal = 50000.; hi = 50000.; fl = 48000.; pro = []; n = 0
    for d in days[start:start + maxd]:
        st = dict(bal=bal, floor=fl, cushion=bal - fl, day_n=len(pro), profit=bal - 50000,
                  best=max(pro) if pro else 0., locked=fl >= 50100)
        q = policy(st)
        dayp = 0.; worst = 0.; traded = False
        for grp in (OVERNIGHT, MORNING, AFTERNOON):
            if daily_stop is not None and dayp <= -daily_stop: break
            if daily_lock is not None and dayp >= daily_lock: break
            g = 0.
            for s in grp:
                if s not in streams: continue
                x = streams[s].get(d)
                c = q.get(s, 0)
                if x is None or c == 0 or x == 0: continue
                traded = True
                p = x * c * USD
                worst = min(worst, dayp + g + min(0., p))
                g += p
            dayp += g
            worst = min(worst, dayp)
        if not traded: continue
        if bal + worst <= fl:
            return 'breach', len(pro) + 1
        bal += dayp; pro.append(dayp)
        hi = max(hi, bal); fl = min(50100., max(fl, hi - 2000))
        tot = bal - 50000
        if tot >= 3000 and len(pro) >= 4 and max(pro) <= 0.3 * tot:
            return 'pass', len(pro)
    return 'open', len(pro)


def evaluate(days, streams, policy, starts=None, boot=0, block=5, seed=0, **kw):
    res = []
    if starts is not None:
        for i in starts: res.append(run_eval(days, streams, policy, i, **kw))
    rng = np.random.default_rng(seed)
    for b in range(boot):
        nb = 600 // block
        idx = np.concatenate([np.arange(s, s + block) for s in rng.integers(0, len(days) - block, nb)])
        bd = [days[i] for i in idx]
        # re-key: bootstrap days may repeat; map to unique keys
        ss = {k: {f'{j}': v.get(dd) for j, dd in enumerate(bd) if v.get(dd) is not None} for k, v in streams.items()}
        res.append(run_eval([f'{j}' for j in range(len(bd))], ss, policy, 0, **kw))
    p = np.mean([r[0] == 'pass' for r in res]); b = np.mean([r[0] == 'breach' for r in res])
    dd = sorted(r[1] for r in res if r[0] == 'pass')
    return dict(pass_=p, breach=b, open=1 - p - b, med=dd[len(dd) // 2] if dd else None,
                p75=dd[int(len(dd) * .75)] if dd else None, n=len(res))


def fmt(r):
    return f"pass {r['pass_']:4.0%} breach {r['breach']:4.0%} open {r['open']:4.0%} median {r['med']}d p75 {r['p75']}d"
