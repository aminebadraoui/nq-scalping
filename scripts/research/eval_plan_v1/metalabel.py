"""Meta-labeling the high-win-rate bracket: predict P(bracket wins) from ~30
features at each 15-min RTH decision point, long and short separately; trade
only when predicted p ≥ fair + margin. Labels/fills on TRUE OHLC (entry next
1-min open, exact stop/target walk, flat 15:59). Monthly walk-forward refit."""
import numpy as np, sys
from tlib import T, TD, ok, walk, SLIP, FEE
import ml_wf as M
from sklearn.ensemble import HistGradientBoostingClassifier

A, B = float(sys.argv[1]) if len(sys.argv) > 1 else 30, float(sys.argv[2]) if len(sys.argv) > 2 else 90
FAIR = B / (A + B)
M.H = 30; M.STEP = 15
rows = []
for i, d in enumerate(M.fd):
    if d not in M.atr or i == 0 or d not in T: continue
    g = T[d]
    for (dd, t, x, _) in M.feats(d, i):
        j = t + 1
        if not ok(g, j) or t > 1300: continue
        for dr in (1, -1):
            e = g['o'][j] + dr * SLIP
            r, _ = walk(g, j, dr, e, lambda jj: e - dr * B, e + dr * A, 1319)
            rows.append((d, t, dr, [*x.values(), dr], r))
keys = None
X = np.nan_to_num(np.array([r[3] for r in rows], float)); R = np.array([r[4] for r in rows]); Y = R > 0
D = np.array([r[0] for r in rows])
print('samples', len(rows), 'base WR', Y.mean().round(3), 'fair', round(FAIR, 3), 'mean pts', R.mean().round(2))
months = sorted(set(d[:7] for d in D)); pred = np.full(len(rows), np.nan)
for m in months:
    tr = D < m + '-01'; te = np.array([d.startswith(m) for d in D])
    if len(set(D[tr])) < 200 or not te.any(): continue
    mdl = HistGradientBoostingClassifier(max_depth=3, learning_rate=0.03, max_iter=250, min_samples_leaf=300, l2_regularization=1.0)
    mdl.fit(X[tr], Y[tr]); pred[te] = mdl.predict_proba(X[te])[:, 1]
okp = ~np.isnan(pred)
print('out-of-sample samples', okp.sum())
for thr in [FAIR, FAIR + 0.03, FAIR + 0.06, FAIR + 0.09]:
    sel = okp & (pred >= thr)
    if sel.sum() < 30: print(f'  p≥{thr:.2f}: too few'); continue
    wr = Y[sel].mean(); pts = R[sel].mean()
    yrs = ' '.join(f"{y}:{Y[sel & np.array([d.startswith(y) for d in D])].mean():.3f}" for y in ['2025', '2026'])
    print(f'  predicted p≥{thr:.2f}: trades {sel.sum():5d}  realised WR {wr:.3f} (fair {FAIR:.3f}, edge {wr-FAIR:+.3f})  mean {pts:+.2f} pts/contract  [{yrs}]')
