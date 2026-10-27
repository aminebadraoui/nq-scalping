"""HF scalping model: per template, a gradient-boosted regressor of the
honest net outcome (no-fill = 0) on footprint features. Fit on 2023-12..2024,
pick the score threshold on 2025, and NEVER look at 2026 unless --final."""
import json, sys
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor

FINAL = '--final' in sys.argv
D = next((a.split('=')[1] for a in sys.argv if a.startswith('--dir=')), 'hf')
M = json.load(open(f'{D}/meta.json')); n = M['rows']; T = len(M['tpls'])
X = np.fromfile(f'{D}/X.f32', np.float32).reshape(n, len(M['feats']))
Y = np.fromfile(f'{D}/Y.f32', np.float32).reshape(n, T)
Fl = np.fromfile(f'{D}/F.u8', np.uint8).reshape(n, T)
H = np.fromfile(f'{D}/H.u8', np.uint8).reshape(n, T)
NL = np.fromfile(f'{D}/N.f32', np.float32).reshape(n, T)
YP = Y.copy()
if '--neutral' in sys.argv:
    Y = NL  # order-neutral labels drive fit + selection; pessimistic reported alongside
dates = np.array(M['dates']); idx = np.array(M['idx'])
yr = np.array([d[:4] for d in dates])
tr = (yr <= '2024'); va = (yr == '2025'); te = (yr == '2026')
ndays = {k: len(set(dates[m])) for k, m in [('tr', tr), ('va', va), ('te', te)]}


def overlay(sel, k):
    """one position at a time: walk selected rows in time order per session"""
    taken = []
    busy = {}
    for r in np.where(sel)[0]:
        d = dates[r]
        if idx[r] <= busy.get(d, -1):
            continue
        if Fl[r, k] == 0:
            continue
        taken.append(r)
        busy[d] = idx[r] + int(H[r, k])
    return np.array(taken, int)


def summ(rows, k, days, L=None):
    L = Y if L is None else L
    if len(rows) == 0:
        return dict(n=0, perday=0, wr=0, exp=0, pf=0, tot=0)
    y = L[rows, k]
    w = y[y > 0].sum(); l = -y[y < 0].sum()
    return dict(n=len(rows), perday=len(rows) / days, wr=float((y > 0).mean()), exp=float(y.mean()), pf=float(w / l) if l > 0 else 99, tot=float(y.sum()))


out = []
for k, nm in enumerate(M['tpls']):
    mdl = HistGradientBoostingRegressor(max_iter=200, learning_rate=0.05, max_leaf_nodes=31, min_samples_leaf=400, l2_regularization=1.0, random_state=0)
    mdl.fit(X[tr], Y[tr, k])
    p_va = mdl.predict(X[va])
    best = None
    for q in (0.998, 0.995, 0.99, 0.98, 0.95):
        thr = np.quantile(p_va, q)
        sel = np.zeros(n, bool); sel[np.where(va)[0][p_va >= thr]] = True
        rws = overlay(sel, k)
        s = summ(rws, k, ndays['va'])
        s['pess_exp'] = summ(rws, k, ndays['va'], YP)['exp']
        s['q'] = q; s['thr'] = float(thr)
        if s['n'] >= 60 and (best is None or s['tot'] > best['tot']):
            best = s
    row = dict(tpl=nm, val=best)
    if FINAL and best:
        p_te = mdl.predict(X[te])
        sel = np.zeros(n, bool); sel[np.where(te)[0][p_te >= best['thr']]] = True
        row['test'] = summ(overlay(sel, k), k, ndays['te'])
    out.append(row)
    b = best or {}
    line = f"{nm:18s} VAL q={b.get('q')} n={b.get('n',0):5d} /day={b.get('perday',0):4.1f} WR={100*b.get('wr',0):4.1f}% exp={b.get('exp',0):+.2f} (pess {b.get('pess_exp',0):+.2f}) PF={b.get('pf',0):.2f} tot={b.get('tot',0):+8.1f}"
    if 'test' in row:
        t = row['test']; line += f" | TEST n={t['n']} /day={t['perday']:.1f} WR={100*t['wr']:.1f}% exp={t['exp']:+.2f} PF={t['pf']:.2f} tot={t['tot']:+.1f}"
    print(line, flush=True)
json.dump(out, open((f'{D}/model_final' if FINAL else f'{D}/model_val') + ('_neutral' if '--neutral' in sys.argv else '') + '.json', 'w'))
