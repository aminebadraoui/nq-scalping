"""True Tradovate 1-min OHLCV on the same 1380-minute grid (m=0 = 18:00 ET)."""
import json, glob, os, numpy as np, pickle
D='/mnt/user-data/uploads/Scalping/gcdata/data/ohlc_hist'; PK='/home/claude/research/ogrid.pkl'; NM=1380
def build():
    G={}
    for f in sorted(glob.glob(D+'/*_ETH.json')):
        d=os.path.basename(f)[:10]; js=json.load(open(f)); b=js['bars']
        if len(b)<600: continue
        g={k:np.full(NM,np.nan) for k in 'ohlcv'}
        for x in b:
            t=((int(x['t'][11:13])+1)%24)*60+int(x['t'][14:16]); m=(t-1080)%1440
            if m<NM:
                g['o'][m]=x['o'];g['h'][m]=x['h'];g['l'][m]=x['l'];g['c'][m]=x['c'];g['v'][m]=x['v']
        G[d]=g
    pickle.dump(G,open(PK,'wb')); return G
def load(): return pickle.load(open(PK,'rb')) if os.path.exists(PK) else build()
if __name__=='__main__':
    G=build(); print(len(G), min(G), max(G))
    import grid; F=grid.load(); n=0; bad=0
    for d in G:
        if d in F:
            a=G[d]['h']; b=F[d]['hi']; m=~(np.isnan(a)|np.isnan(b)); n+=m.sum(); bad+=(np.abs(a[m]-b[m])>0.01).sum()
    print('high mismatch', bad, 'of', n)
