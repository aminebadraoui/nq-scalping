"""Score every config of the honest-fill search: train-only selection,
DSR over all trials, PBO via CSCV, and the frozen 2026 holdout."""
import os
HERE = os.environ.get('WORK_DIR', os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
import pickle, sys, math, itertools, json
import numpy as np
from scipy.stats import norm

SPLIT = '2026-01-01'
mq = sys.argv[1] if len(sys.argv) > 1 else 'p50'
R = pickle.load(open(os.path.join(HERE, f'results_{mq}.pkl'), 'rb'))
Z = np.load(os.path.join(HERE, 'sessions.npz'))
DATES = list(Z['dates'])
TRAIN = [d for d in DATES if d < SPLIT]
TEST = [d for d in DATES if d >= SPLIT]
ti = {d: i for i, d in enumerate(TRAIN)}
si = {d: i for i, d in enumerate(TEST)}


def stats(tr):
    if not tr:
        return dict(n=0, wr=0, exp=0, pf=0, net=0)
    net = np.array([t[3] for t in tr])
    w = net[net > 0].sum(); l = -net[net < 0].sum()
    return dict(n=len(tr), wr=float((net > 0).mean()), exp=float(net.mean()), pf=float(w / l) if l > 0 else float('inf'), net=float(net.sum()))


def usd(tr, budget=100.0, fee_rt=1.90, cap=30):
    """$100 risk per trade, MNQ $2/pt: contracts = floor(budget / (stop·2))"""
    out = []
    for t in tr:
        c = max(1, min(cap, int(budget // (t[4] * 2))))
        out.append(c * t[2] * 2 - c * fee_rt)
    return np.array(out)


def session_R(tr, idx, n):
    """per-session return in R (net pts / stop pts), 0 on no-trade sessions"""
    v = np.zeros(n)
    for t in tr:
        if t[0] in idx:
            v[idx[t[0]]] += t[3] / t[4]
    return v


def max_dd(x):
    c = np.cumsum(x); peak = np.maximum.accumulate(np.concatenate([[0], c]))[1:]
    return float((c - peak).min()) if len(c) else 0.0


def sharpe(x):
    s = x.std(ddof=1)
    return float(x.mean() / s) if s > 0 else 0.0


rows = []
M = []  # train per-session R matrix (configs × sessions)
names = list(R)
for name in names:
    tr = R[name]
    a = [t for t in tr if t[0] < SPLIT]
    b = [t for t in tr if t[0] >= SPLIT]
    sa, sb = stats(a), stats(b)
    va = session_R(tr, ti, len(TRAIN))
    M.append(va)
    ua, ub = usd(a), usd(b)
    rows.append(dict(name=name, train=sa, test=sb, sr_train=sharpe(va),
                     usd_train=float(ua.sum()), usd_test=float(ub.sum()),
                     dd_train=max_dd(ua), dd_test=max_dd(ub)))
M = np.array(M)

# ---- Deflated Sharpe (Bailey & López de Prado 2014) over ALL trials ----
srs = np.array([r['sr_train'] for r in rows])
N = len(srs)
T = M.shape[1]
var_sr = srs.var(ddof=1)
emc = 0.5772156649
sr0 = math.sqrt(var_sr) * ((1 - emc) * norm.ppf(1 - 1 / N) + emc * norm.ppf(1 - 1 / (N * math.e)))


def dsr(i):
    x = M[i]
    sr = srs[i]
    s = x.std(ddof=1)
    if s == 0: return 0.0
    z = (x - x.mean()) / s
    sk = float((z ** 3).mean()); ku = float((z ** 4).mean())
    den = math.sqrt(max(1e-12, 1 - sk * sr + (ku - 1) / 4 * sr * sr))
    return float(norm.cdf((sr - sr0) * math.sqrt(T - 1) / den))


# ---- PBO via CSCV (16 blocks) on the train matrix ----
def pbo(M, S=16):
    n = M.shape[1]
    blocks = np.array_split(np.arange(n), S)
    lam = []
    for comb in itertools.combinations(range(S), S // 2):
        ins = np.concatenate([blocks[k] for k in comb])
        oos = np.concatenate([blocks[k] for k in range(S) if k not in comb])
        def sr(A):
            sd = A.std(axis=1, ddof=1)
            return np.where(sd > 0, A.mean(axis=1) / np.where(sd > 0, sd, 1), 0)
        best = int(np.argmax(sr(M[:, ins])))
        oos_sr = sr(M[:, oos])
        rank = (oos_sr < oos_sr[best]).sum() + 0.5 * ((oos_sr == oos_sr[best]).sum() - 1)
        w = (rank + 1) / (len(oos_sr) + 1)
        lam.append(math.log(w / (1 - w)))
    lam = np.array(lam)
    return float((lam <= 0).mean())


P = pbo(M)
for i, r in enumerate(rows):
    r['dsr'] = dsr(i)

# ---- train-only qualification ----
qual = [r for r in rows if r['train']['n'] >= 100 and r['train']['exp'] > 0 and r['train']['pf'] >= 1.10]
qual.sort(key=lambda r: -r['sr_train'])
print(f'fill={mq} configs={N} train sessions={len(TRAIN)} test sessions={len(TEST)}  SR0(deflation bar)={sr0:.3f}  PBO={P:.2f}')
print(f'train-qualified (n≥100, net exp>0, PF≥1.10): {len(qual)}')
fmt = lambda s: f"n={s['n']:5d} WR={100*s['wr']:5.1f}% exp={s['exp']:+.2f} PF={s['pf']:.2f}"
for r in qual[:25]:
    print(f"{r['name']:70s} TRAIN {fmt(r['train'])} SR={r['sr_train']:.3f} DSR={r['dsr']:.2f} ${r['usd_train']:+8.0f} dd${r['dd_train']:+6.0f} | TEST {fmt(r['test'])} ${r['usd_test']:+7.0f} dd${r['dd_test']:+6.0f}")
# family-level best (train) for context
print('\nbest train config per family:')
for fam in sorted({r['name'].split('|')[0] for r in rows}):
    fr = sorted([r for r in rows if r['name'].startswith(fam + '|') and r['train']['n'] >= 100], key=lambda r: -r['sr_train'])
    if fr:
        r = fr[0]
        print(f"{r['name']:70s} TRAIN {fmt(r['train'])} DSR={r['dsr']:.2f} | TEST {fmt(r['test'])}")
json.dump(dict(pbo=P, sr0=sr0, rows=rows), open(os.path.join(HERE, f'analysis_{mq}.json'), 'w'), default=float)
