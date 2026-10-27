import os
HERE = os.environ.get('WORK_DIR', os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
import numpy as np, json, random, subprocess
from sim import simulate
Z=np.load(os.path.join(HERE, 'sessions.npz')); dates=list(Z['dates'])
random.seed(1); cases=[]; res=[]
bars={}
for d in random.sample(dates,5):
    S={k:Z[f'{d}|{k}'] for k in ['hi','lo','buy','sell']}
    bars[d]=[{'high':float(S['hi'][i]),'low':float(S['lo'][i]),'buy':float(S['buy'][i]),'sell':float(S['sell'][i])} for i in range(len(S['hi']))]
    for _ in range(400):
        i=random.randrange(20,len(S['hi'])-5); dd=random.choice([1,-1]); kind=random.choice(['market','limit','stop'])
        mid=(S['hi'][i]+S['lo'][i])/2; off=random.choice([0,1,2,4])
        price=None if kind=='market' else round((mid - dd*off if kind=='limit' else mid + dd*off)*4)/4
        sp=random.choice([2,3.5,6]); tp=random.choice([2,4,8]); ttl=random.choice([3,9])
        r=simulate(S,i,dd,kind,price,ttl,sp,tp,hold=30)
        cases.append({'d':d,'i':i,'dir':dd,'kind':kind,'price':price,'ttl':ttl,'sp':sp,'tp':tp}); res.append(r)
json.dump({'bars':bars,'cases':cases},open(os.path.join(HERE, 'parity_in.json'),'w'))
out=subprocess.run(['node','--import',os.path.join(REPO, 'scripts/ts-loader.mjs'),os.path.join(os.path.dirname(os.path.abspath(__file__)), 'parity.ts')],capture_output=True,text=True,cwd=os.path.join(REPO, 'web'),env={**os.environ,'PARITY_IN':os.path.join(HERE, 'parity_in.json')})
ts=json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout else print(out.stderr[-2000:])
bad=0
for c,a,b in zip(cases,res,ts):
    ah=a['hit'] if a else None; bh=b['hit'] if b else None
    ok = ah==bh and (ah in (None,'nofill') or abs(a['net']-b['netPts'])<1e-9)
    if not ok:
        bad+=1
        if bad<5: print(c,a,b)
print('cases',len(cases),'mismatch',bad)
