"""Edge families v3 (rules fixed a priori from the literature; honest walker).
Grid minute m: 930 = 09:30 ET bar, 1319 = 15:59 ET bar. Per-day net pts, 1 MNQ."""
import numpy as np
from grid import load, mkt, close, walk, TICK, SLIP, FEE
from lib2 import G, DATES, F, ok, rth_open, rep, RTH0, RTH_END


def cl(g, j): return close(g, j)


def ib_ranges():
    return {d: F[d]['ib_hi'] - F[d]['ib_lo'] for d in DATES if d in F}


# ---------- F1: Dalton 80% rule ----------
def va80(brackets=2, last_entry=1170, stop_mode='struct', bias=0.35):
    out = {}
    for i, d in enumerate(DATES):
        if i == 0 or DATES[i - 1] not in F: continue
        p = F[DATES[i - 1]]; g = G[d]
        if not ok(g, RTH0 - 1): continue
        vah, val = p['rth_vah'], p['rth_val']
        op = rth_open(g)
        if val <= op <= vah or vah - val < 10: out[d] = 0.0; continue
        dr = -1 if op > vah else 1          # opened above → short back through VA
        inside = 0; res = 0.0; seg_hi = -1e9; seg_lo = 1e9
        for b0 in range(RTH0, last_entry, 30):
            seg = [j for j in range(b0, b0 + 30) if ok(g, j)]
            if not seg: break
            e = seg[-1]
            c = cl(g, e)
            if val < c < vah:
                inside += 1
                seg_hi = max(seg_hi, np.nanmax(g['hi'][b0:b0 + 30])); seg_lo = min(seg_lo, np.nanmin(g['lo'][b0:b0 + 30]))
            else:
                inside = 0; seg_hi = -1e9; seg_lo = 1e9
            if inside >= brackets:
                en = mkt(g, e, dr, 'p50', bias)
                if stop_mode == 'struct':
                    st = seg_hi + TICK if dr < 0 else seg_lo - TICK
                else:
                    st = (vah + 0.25 * (vah - val)) if dr < 0 else (val - 0.25 * (vah - val))
                tgt = val if dr < 0 else vah
                if (en - st) * dr <= 2 or (tgt - en) * dr <= 2: break
                res = walk(g, e, dr, en, lambda j: st, tgt, RTH_END)[0]
                break
        out[d] = res
    return out


# ---------- F2/F3: failed auction at a reference extreme ----------
def failed_auction(ref='prev', window=(930, 1109), confirm=5, min_poke=2, target='poc', bias=0.35):
    """price pokes beyond the ref high (low) by ≥min_poke ticks, then within
    `confirm` bars closes back inside → fade to the target; stop = the
    session extreme beyond + tick; one trade/day; flat 15:59"""
    out = {}
    for i, d in enumerate(DATES):
        if i == 0 or DATES[i - 1] not in F or d not in F: continue
        p = F[DATES[i - 1]]; g = G[d]; f = F[d]
        if ref == 'prev': H, L, T = p['rth_hi'], p['rth_lo'], p['rth_poc']
        else: H, L, T = f['on_hi'], f['on_lo'], (p['rth_poc'] if target == 'poc' else (f['on_hi'] + f['on_lo']) / 2)
        res = 0.0
        poke = None   # (dir_of_fade, bar, extreme)
        ext_hi = -1e9; ext_lo = 1e9
        for j in range(window[0], window[1]):
            if not ok(g, j): continue
            ext_hi = max(ext_hi, g['hi'][j]); ext_lo = min(ext_lo, g['lo'][j])
            if poke is None:
                if j == RTH0 and (rth_open(g) > H or rth_open(g) < L):
                    break  # opened outside: not a poke, skip the day
                if g['hi'][j] >= H + min_poke * TICK: poke = (-1, j)
                elif g['lo'][j] <= L - min_poke * TICK: poke = (1, j)
                continue
            dr, pj = poke
            if j - pj > confirm: poke = None; continue
            c = cl(g, j)
            if (dr < 0 and c < H) or (dr > 0 and c > L):
                en = mkt(g, j, dr, 'p50', bias)
                st = ext_hi + TICK if dr < 0 else ext_lo - TICK
                tgt = T
                if (en - st) * dr <= 2 or (tgt - en) * dr <= 4: break
                res = walk(g, j, dr, en, lambda jj: st, tgt, RTH_END)[0]
                break
        out[d] = res
    return out


# ---------- F4: narrow-IB breakout (Dalton: narrow IB → range extension) ----------
def ib_break(narrow=0.7, last=1259, stop='mid', only_narrow=True):
    out = {}
    ibr = ib_ranges()
    for i, d in enumerate(DATES):
        if i < 20 or d not in F: continue
        prior = [ibr[x] for x in DATES[i - 20:i] if x in ibr]
        if len(prior) < 15: continue
        f = F[d]; g = G[d]
        r = f['ib_hi'] - f['ib_lo']
        if only_narrow and r >= narrow * np.mean(prior): out[d] = 0.0; continue
        H, L = f['ib_hi'], f['ib_lo']; res = 0.0
        for j in range(990, last):
            if not ok(g, j): continue
            up = g['hi'][j] >= H + TICK; dn = g['lo'][j] <= L - TICK
            if up and dn: break
            if up or dn:
                dr = 1 if up else -1
                trig = H + TICK if up else L - TICK
                op = cl(g, j - 1) if ok(g, j - 1) else trig
                en = (max(trig, op) if dr > 0 else min(trig, op)) + dr * SLIP
                st = (H + L) / 2 if stop == 'mid' else (L - TICK if dr > 0 else H + TICK)
                # fill bar: stop first
                if (g['lo'][j] <= st) if dr > 0 else (g['hi'][j] >= st):
                    res = (st - dr * SLIP - en) * dr - FEE
                else:
                    res = walk(g, j, dr, en, lambda jj: st, None, RTH_END)[0]
                break
        out[d] = res
    return out


# ---------- F8: last-half-hour momentum (Baltussen et al. 2021 / Gao 2018) ----------
def last_half(entry=1289, minsig=0.0, bias=0.0):
    """sign of the 09:30→15:29 return; trade 15:30 open → 15:59 close"""
    out = {}
    for d in DATES:
        g = G[d]
        if not (ok(g, RTH0 - 1) and ok(g, entry) and ok(g, RTH_END)): continue
        op = rth_open(g); c = cl(g, entry)
        r = c / op - 1
        if abs(r) <= minsig: out[d] = 0.0; continue
        dr = 1 if r > 0 else -1
        en = mkt(g, entry, dr, 'p50', bias)
        out[d] = walk(g, entry, dr, en, lambda j: None, None, RTH_END)[0]
    return out


# ---------- F7: VWAP reversion on balance days ----------
def vwap_revert(k_in=2.0, k_stop=3.0, start=1020, last=1259, bias=0.35):
    """balance day = open inside the prior VA and 11:00 price still inside it.
    Fade a close ≥ k_in·sd from RTH VWAP back to VWAP; stop at k_stop·sd."""
    out = {}
    for i, d in enumerate(DATES):
        if i == 0 or DATES[i - 1] not in F: continue
        p = F[DATES[i - 1]]; g = G[d]
        if not ok(g, RTH0 - 1) or not ok(g, start): continue
        op = rth_open(g)
        if not (p['rth_val'] <= op <= p['rth_vah'] and p['rth_val'] <= cl(g, start) <= p['rth_vah']):
            out[d] = 0.0; continue
        idx = np.arange(RTH0, RTH_END + 1)
        vol = np.nan_to_num(g['buy'][idx] + g['sell'][idx])
        pp = np.where(np.isnan(g['poc'][idx]), (g['hi'][idx] + g['lo'][idx]) / 2, g['poc'][idx])
        pp = np.where(np.isnan(pp), op, pp)
        cv = np.cumsum(vol); vw = np.cumsum(pp * vol) / np.maximum(1, cv)
        var = np.cumsum(vol * pp ** 2) / np.maximum(1, cv) - vw ** 2
        sd = np.sqrt(np.maximum(var, 0))
        res = 0.0
        for j in range(start, last):
            m = j - RTH0
            if not ok(g, j) or sd[m] < 5: continue
            c = cl(g, j); z = (c - vw[m]) / sd[m]
            if abs(z) >= k_in:
                dr = -1 if z > 0 else 1
                en = mkt(g, j, dr, 'p50', bias)
                st = vw[m] + (-dr) * k_stop * sd[m]
                tgt = vw[m]
                res = walk(g, j, dr, en, lambda jj: st, tgt, RTH_END)[0]
                break
        out[d] = res
    return out


if __name__ == '__main__':
    import json
    R = {}
    def go(name, o): R[name] = o; rep(name, o)
    go('va80 2br struct', va80())
    go('va80 1br struct', va80(brackets=1))
    go('va80 2br wide', va80(stop_mode='wide'))
    go('failed auction prev 5b poc', failed_auction('prev'))
    go('failed auction prev 15b poc', failed_auction('prev', confirm=15))
    go('failed auction ON 5b', failed_auction('on'))
    go('failed auction ON 15b', failed_auction('on', confirm=15))
    go('IB narrow0.7 break mid-stop', ib_break())
    go('IB narrow0.7 break far-stop', ib_break(stop='far'))
    go('IB all break mid-stop', ib_break(only_narrow=False))
    go('last half hour', last_half())
    go('last half hour |r|>0.5%', last_half(minsig=0.005))
    go('vwap revert balance 2/3', vwap_revert())
    go('vwap revert balance 1.5/2.5', vwap_revert(1.5, 2.5))
    json.dump(R, open('/home/claude/research/lib3.json', 'w'))
