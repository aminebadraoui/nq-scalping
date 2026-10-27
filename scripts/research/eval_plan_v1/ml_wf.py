"""Walk-forward ML on everything we have (no ES): predict the sign of the next
H-minute NQ return at RTH decision bars from ~30 features known at the bar;
trade only confident predictions with honest fills. Monthly refit on all prior
data (min 250 sessions); test = the next month; never look ahead."""
import numpy as np, json, sys
from grid import mkt, close, walk, TICK
from lib2 import G, DATES, F, ok
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline

H = int(sys.argv[1]) if len(sys.argv) > 1 else 30
STEP = 15
fd = [d for d in DATES if d in F]
atr = {}
for i, d in enumerate(fd):
    if i >= 20: atr[d] = np.mean([F[x]['rth_hi'] - F[x]['rth_lo'] for x in fd[i - 20:i]])


def feats(d, i):
    g = G[d]; f = F[d]; p = F[fd[i - 1]]; A = atr[d]
    rows = []
    idx = np.arange(930, 1320)
    if np.isnan(g['hi'][idx]).sum() > 20: return rows
    hi = g['hi']; lo = g['lo']; bu = np.nan_to_num(g['buy']); se = np.nan_to_num(g['sell'])
    c = np.array([close(g, j) if ok(g, j) else np.nan for j in range(1380)])
    c = np.where(np.isnan(c), np.nan, c)
    op = mkt(g, 929, 1, 'p50') - 0.25
    vol = bu + se
    pp = np.where(np.isnan(g['poc']), (hi + lo) / 2, g['poc'])
    for t in range(944, 1320 - H, STEP):     # decision at the END of bar t
        if not ok(g, t) or not ok(g, t + H): continue
        seg = np.arange(930, t + 1)
        v = vol[seg]; vw = np.nansum(pp[seg] * v) / max(1, v.sum())
        px = c[t]
        if np.isnan(px): continue
        def r(k):
            a = c[t - k] if t - k >= 0 and not np.isnan(c[t - k]) else np.nan
            return (px - a) / A
        shi = np.nanmax(hi[seg]); slo = np.nanmin(lo[seg])
        x = dict(
            tod=t - 930, dow=__import__('datetime').date.fromisoformat(d).weekday(),
            r5=r(5), r15=r(15), r30=r(30), r60=r(60), ropen=(px - op) / A,
            vwap=(px - vw) / A, onh=(px - f['on_hi']) / A, onl=(px - f['on_lo']) / A,
            pc=(px - p['rth_close']) / A, ph=(px - p['rth_hi']) / A, pl=(px - p['rth_lo']) / A,
            ppoc=(px - p['rth_poc']) / A, pvah=(px - p['rth_vah']) / A, pval=(px - p['rth_val']) / A,
            shi=(px - shi) / A, slo=(px - slo) / A, srng=(shi - slo) / A,
            cd=(bu[seg] - se[seg]).sum() / max(1, v.sum()),
            d15=(bu[t - 14:t + 1] - se[t - 14:t + 1]).sum() / max(1, vol[t - 14:t + 1].sum()),
            d5=(bu[t - 4:t + 1] - se[t - 4:t + 1]).sum() / max(1, vol[t - 4:t + 1].sum()),
            v30=vol[t - 29:t + 1].sum() / max(1, v.mean() * 30),
            rv30=np.nanstd(np.diff(c[t - 30:t + 1])) / A * 10,
            gap=(op - p['rth_close']) / A, onr=(f['on_hi'] - f['on_lo']) / A,
            pret=(p['rth_close'] - p['rth_open']) / A, prng=(p['rth_hi'] - p['rth_lo']) / A,
            ond=f['on_delta'] / max(1, f['on_vol']),
        )
        y = c[t + H] - px
        rows.append((d, t, x, y))
    return rows


def build():
    data = []
    for i, d in enumerate(fd):
        if d in atr and i > 0: data += feats(d, i)
    return data


def pnl(d, t, dr):
    g = G[d]; e = mkt(g, t, dr, 'p50', 0.35)
    return walk(g, t, dr, e, lambda j: None, None, t + H)[0]


if __name__ == '__main__':
    data = build()
    keys = list(data[0][2])
    X = np.array([[r[2][k] for k in keys] for r in data], float); X = np.nan_to_num(X)
    Y = np.array([r[3] > 0 for r in data]); D = np.array([r[0] for r in data])
    months = sorted(set(d[:7] for d in D))
    res = {m: {} for m in ['gbm', 'logit']}
    for m in months:
        tr = D < m + '-01'; te = np.array([d.startswith(m) for d in D])
        if len(set(D[tr])) < 250 or te.sum() == 0: continue
        models = {'gbm': HistGradientBoostingClassifier(max_depth=3, learning_rate=0.03, max_iter=200, min_samples_leaf=200, l2_regularization=1.0),
                  'logit': make_pipeline(StandardScaler(), LogisticRegression(C=0.05, max_iter=500))}
        for name, mdl in models.items():
            mdl.fit(X[tr], Y[tr]); pr = mdl.predict_proba(X[te])[:, 1]
            for k, ii in enumerate(np.where(te)[0]): res[name][(data[ii][0], data[ii][1])] = pr[k]
    out = {}
    for name in res:
        for th in [0.52, 0.55, 0.58, 0.60]:
            daily = {}
            n = 0
            for (d, t), pr in res[name].items():
                if pr >= th: dr = 1
                elif pr <= 1 - th: dr = -1
                else: continue
                daily[d] = daily.get(d, 0) + pnl(d, t, dr); n += 1
            alld = sorted(set(d for d, _ in res[name]))
            v = np.array([daily.get(d, 0) for d in alld])
            yrs = ' '.join(f"{y}:{np.mean([daily.get(d,0) for d in alld if d.startswith(y)]):+.1f}" for y in ['2025', '2026'])
            print(f"H{H} {name:5s} th{th}: trades {n:5d} days {len(alld)} {v.mean():+6.2f}/d t {v.mean()/v.std()*np.sqrt(len(v)):+.2f} [{yrs}]")
            out[f'{name}_{th}'] = daily
    json.dump(out, open(f'ml_wf_H{H}.json', 'w'))
