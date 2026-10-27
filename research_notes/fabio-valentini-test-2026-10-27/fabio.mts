/* Fabio Valentini's two auction-market models, made testable on the
 * footprint archive with HONEST fills (lib/honestFill.ts).
 *
 * Common: market state + location (LVN of a leg's volume profile) +
 * aggression (one-sided flow / stacked imbalances on the bar at the LVN).
 * Entry: a STOP order one tick past the aggression bar (the fill is
 * exact — no close is needed), stop 2 ticks beyond the aggression bar
 * ("beyond the aggressive print"), target = a POC (balance) or the leg
 * extreme, or fixed R. One position at a time.
 *
 * TREND (NY 9:30–16:00 ET): impulse leg = lowest low → highest high
 *   (long) inside the last 60 bars, ≥ M·ATR, ended ≤ 20 bars ago;
 *   pullback ≥ 30% of the leg; LVN = a price in the leg's middle 60%
 *   whose profile volume ≤ 30% of the leg's median per-price volume;
 *   trigger = a bar whose low reaches the highest LVN below the market
 *   (without breaking more than 0.5 ATR through) with buy aggression.
 *   Target "poc": the POC of the 60 bars BEFORE the leg (previous
 *   balance) when it is beyond entry by ≥ 1R, else the leg extreme.
 * MEAN REVERSION (all hours outside 9:30–16:00 ET, or all): balance =
 *   prior session value area (70%) + POC; a break above VAH (below VAL)
 *   that is reclaimed (a bar fully back inside); reclaim leg = break
 *   extreme → reclaim bar; LVN of that leg; trigger = a later bar that
 *   pulls back into the LVN with sell (buy) aggression. Target = prior
 *   session POC.
 * Output: one line per config with train(<2025) / val(2025) / test(2026). */
import { readFileSync, readdirSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { simulateHonest, type FillBar } from "../../web/lib/honestFill.ts";

const ARCH = process.env.ARCHIVE_DIR ?? `${process.env.HOME}/.cache/nq-archive`;
const TICK = 0.25;
type Bar = FillBar & { high: number; low: number; buy: number; sell: number; t: number; lv: Map<number, [number, number]> };

function load(file: string): Bar[] {
  const j = JSON.parse(gunzipSync(readFileSync(file)).toString("utf8"));
  return (j.candles ?? []).map((c: any) => {
    const hh = Number(c.t.slice(11, 13)), mm = Number(c.t.slice(14, 16));
    const lv = new Map<number, [number, number]>();
    for (const [p, v] of Object.entries(c.levels ?? {}) as [string, any][]) lv.set(Number(p) / 100, [v[1], v[2]]);
    return { high: c.high / 100, low: c.low / 100, buy: c.buy, sell: c.sell, t: ((hh + 1) % 24) * 60 + mm, lv };
  });
}

function profile(b: Bar[], a: number, z: number): Map<number, number> {
  const m = new Map<number, number>();
  for (let k = a; k <= z; k++) for (const [p, [bb, ss]] of b[k].lv) m.set(p, (m.get(p) ?? 0) + bb + ss);
  return m;
}
const pocOf = (m: Map<number, number>) => { let bp = NaN, bv = -1; for (const [p, v] of m) if (v > bv) { bv = v; bp = p; } return bp; };
function valueArea(m: Map<number, number>): { vah: number; val: number; poc: number } {
  const ps = [...m.keys()].sort((x, y) => x - y);
  const tot = [...m.values()].reduce((s, v) => s + v, 0);
  const poc = pocOf(m);
  let lo = ps.indexOf(poc), hi = lo, acc = m.get(poc) ?? 0;
  while (acc < 0.7 * tot && (lo > 0 || hi < ps.length - 1)) {
    const up = hi < ps.length - 1 ? m.get(ps[hi + 1])! : -1;
    const dn = lo > 0 ? m.get(ps[lo - 1])! : -1;
    if (up >= dn) { hi++; acc += up; } else { lo--; acc += dn; }
  }
  return { vah: ps[hi], val: ps[lo], poc };
}
/** LVN prices of a leg profile within the leg's middle band */
function lvns(m: Map<number, number>, lo: number, hi: number): number[] {
  const vals = [...m.values()].filter((v) => v > 0).sort((x, y) => x - y);
  if (vals.length < 8) return [];
  const med = vals[Math.floor(vals.length / 2)];
  const r = hi - lo;
  const out: number[] = [];
  for (let p = lo + 0.2 * r; p <= hi - 0.2 * r; p += TICK) {
    const q = Math.round(p / TICK) * TICK;
    if ((m.get(q) ?? 0) <= 0.3 * med) out.push(q);
  }
  return out;
}
function stacked(bar: Bar, dir: 1 | -1): number {
  const ps = [...bar.lv.keys()].sort((x, y) => x - y);
  let n = 0;
  for (let k = 1; k < ps.length; k++) {
    if (dir > 0) { const b = bar.lv.get(ps[k])![0], s = bar.lv.get(ps[k - 1])![1]; if (b >= 3 && b >= 3 * Math.max(1, s)) n++; }
    else { const s = bar.lv.get(ps[k - 1])![1], b = bar.lv.get(ps[k])![0]; if (s >= 3 && s >= 3 * Math.max(1, b)) n++; }
  }
  return n;
}
function aggressive(bar: Bar, dir: 1 | -1, share: number, stk: number): boolean {
  const v = bar.buy + bar.sell;
  if (!(v > 0)) return false;
  const sh = dir > 0 ? bar.buy / v : bar.sell / v;
  return sh >= share && stacked(bar, dir) >= stk;
}

type Cfg = { model: "trend" | "mr"; M: number; share: number; stk: number; tgt: "poc" | "3R" | "ext"; win: "ny" | "offny" | "all" };
type Trade = { date: string; dir: 1 | -1; net: number; risk: number; hit: string; fb: boolean };

function runSession(b: Bar[], date: string, prev: Bar[] | null, c: Cfg): Trade[] {
  const n = b.length;
  const rng = b.map((x) => x.high - x.low);
  const out: Trade[] = [];
  let busy = -1;
  const inWin = (t: number) => c.win === "all" || (c.win === "ny" ? t >= 570 && t < 960 : !(t >= 570 && t < 960));
  // mean-reversion balance from the prior session
  let va: { vah: number; val: number; poc: number } | null = null;
  if (c.model === "mr") {
    if (!prev || prev.length < 60) return out;
    va = valueArea(profile(prev, 0, prev.length - 1));
  }
  const brk: { up: number; dn: number } = { up: -1, dn: -1 }; // index of the break extreme
  const recl: { up: number; dn: number } = { up: -1, dn: -1 }; // reclaim bar index
  for (let i = 60; i < n - 2; i++) {
    let atr = 0; for (let k = i - 13; k <= i; k++) atr += rng[k]; atr /= 14;
    if (!(atr > 0)) continue;
    const sigs: { dir: 1 | -1; target: number }[] = [];
    if (c.model === "trend") {
      if (!inWin(b[i].t) || i <= busy) continue;
      for (const dir of [1, -1] as const) {
        // impulse leg in the last 60 bars
        let a = i - 60, z = a;
        if (dir > 0) {
          for (let k = i - 60; k <= i; k++) if (b[k].low < b[a].low) a = k;
          z = a; for (let k = a; k <= i; k++) if (b[k].high > b[z].high) z = k;
        } else {
          for (let k = i - 60; k <= i; k++) if (b[k].high > b[a].high) a = k;
          z = a; for (let k = a; k <= i; k++) if (b[k].low < b[z].low) z = k;
        }
        const lo = dir > 0 ? b[a].low : b[z].low, hi = dir > 0 ? b[z].high : b[a].high;
        const leg = hi - lo;
        if (z <= a || z >= i || i - z > 20 || leg < c.M * atr) continue;
        // pullback ≥ 30% of the leg, not beyond its origin
        const pull = dir > 0 ? hi - b[i].low : b[i].high - lo;
        if (pull < 0.3 * leg || pull >= leg) continue;
        const prof = profile(b, a, z);
        const L = lvns(prof, lo, hi);
        // first LVN the pullback meets: highest below the pre-bar price (long)
        const ref = dir > 0 ? Math.min(...b.slice(z, i).map((x) => x.low)) : Math.max(...b.slice(z, i).map((x) => x.high));
        const cand = dir > 0 ? L.filter((p) => p < ref).sort((x, y) => y - x)[0] : L.filter((p) => p > ref).sort((x, y) => x - y)[0];
        if (cand === undefined) continue;
        const touched = dir > 0 ? b[i].low <= cand + TICK && b[i].low >= cand - 0.5 * atr : b[i].high >= cand - TICK && b[i].high <= cand + 0.5 * atr;
        if (!touched || !aggressive(b[i], dir, c.share, c.stk)) continue;
        const prevPoc = a - 60 >= 0 ? pocOf(profile(b, a - 60, a - 1)) : NaN;
        const ext = dir > 0 ? hi : lo;
        sigs.push({ dir, target: c.tgt === "ext" ? ext : c.tgt === "poc" ? (Number.isFinite(prevPoc) ? prevPoc : ext) : NaN });
      }
    } else {
      const v = va!;
      // track breaks and reclaims
      if (b[i].high > v.vah && (brk.up < 0 || b[i].high > b[brk.up].high)) { brk.up = i; recl.up = -1; }
      if (b[i].low < v.val && (brk.dn < 0 || b[i].low < b[brk.dn].low)) { brk.dn = i; recl.dn = -1; }
      if (brk.up >= 0 && recl.up < 0 && b[i].high < v.vah) recl.up = i;
      if (brk.dn >= 0 && recl.dn < 0 && b[i].low > v.val) recl.dn = i;
      if (!inWin(b[i].t) || i <= busy) continue;
      for (const dir of [-1, 1] as const) {
        const e = dir < 0 ? brk.up : brk.dn, r = dir < 0 ? recl.up : recl.dn;
        if (e < 0 || r < 0 || i <= r || i - e > 90) continue; // "don't take the first move back"
        const lo = dir < 0 ? Math.min(...b.slice(e, r + 1).map((x) => x.low)) : b[e].low;
        const hi = dir < 0 ? b[e].high : Math.max(...b.slice(e, r + 1).map((x) => x.high));
        if (hi - lo < 2 * atr) continue;
        const L = lvns(profile(b, e, r), lo, hi);
        if (!L.length) continue;
        // the pullback into the reclaim leg: for a short, price rises back into the leg's LVN
        const cand = dir < 0 ? L.filter((p) => p > b[r].high).sort((x, y) => x - y)[0] ?? L.sort((x, y) => y - x)[0]
          : L.filter((p) => p < b[r].low).sort((x, y) => y - x)[0] ?? L.sort((x, y) => x - y)[0];
        const touched = dir < 0 ? b[i].high >= cand - TICK && b[i].high < (dir < 0 ? v.vah : v.val) + 0.5 * atr : b[i].low <= cand + TICK && b[i].low > v.val - 0.5 * atr;
        if (!touched || !aggressive(b[i], dir, c.share, c.stk)) continue;
        sigs.push({ dir, target: c.tgt === "3R" ? NaN : v.poc });
      }
    }
    for (const s of sigs) {
      const trig = s.dir > 0 ? b[i].high + TICK : b[i].low - TICK;
      const stopPrice = s.dir > 0 ? b[i].low - 2 * TICK : b[i].high + 2 * TICK;
      const risk = Math.abs(trig - stopPrice);
      let target = s.target;
      if (!Number.isFinite(target) || (target - trig) * s.dir < risk) target = trig + s.dir * 3 * risk;
      const r = simulateHonest(b, { dir: s.dir, signalIdx: i, entry: { kind: "stop", price: trig, ttlBars: 2 }, stopPts: risk, targetPts: Math.abs(target - trig), holdBars: 120 });
      if (!r || !r.filled) continue;
      out.push({ date, dir: s.dir, net: r.netPts, risk: r.risk, hit: r.hit, fb: r.hit === "stop" && r.exitIdx === r.fillIdx });
      busy = r.exitIdx;
      break;
    }
    if (c.model === "mr" && out.length && busy >= i) {
      // a completed setup is consumed
      brk.up = brk.dn = recl.up = recl.dn = -1;
    }
  }
  return out;
}

const files = readdirSync(ARCH).filter((f) => /^\d{4}-\d\d-\d\d_ETH\.json\.gz$/.test(f)).sort();
const sessions: [string, Bar[]][] = files.map((f) => [f.slice(0, 10), load(path.join(ARCH, f))]);
const cfgs: Cfg[] = [];
for (const M of [4, 6]) for (const share of [0.55, 0.6]) for (const stk of [0, 2]) for (const tgt of ["poc", "3R", "ext"] as const) cfgs.push({ model: "trend", M, share, stk, tgt, win: "ny" });
for (const share of [0.55, 0.6]) for (const stk of [0, 2]) for (const tgt of ["poc", "3R"] as const) for (const win of ["offny", "all"] as const) cfgs.push({ model: "mr", M: 0, share, stk, tgt, win });

const fmt = (t: Trade[], days: number) => {
  if (!t.length) return "n=0";
  const net = t.map((x) => x.net), w = net.filter((x) => x > 0).reduce((a, b) => a + b, 0), l = -net.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  const R = t.map((x) => x.net / x.risk); const mR = R.reduce((a, b) => a + b, 0) / R.length;
  const sd = Math.sqrt(R.reduce((a, b) => a + (b - mR) ** 2, 0) / Math.max(1, R.length - 1));
  const fbs = t.filter((x) => x.fb).length;
  return `fillbarStops=${(100 * fbs / t.length).toFixed(0)}% n=${String(t.length).padStart(4)} /day=${(t.length / days).toFixed(2)} WR=${(100 * net.filter((x) => x > 0).length / t.length).toFixed(1)}% exp=${(net.reduce((a, b) => a + b, 0) / t.length).toFixed(2).padStart(6)}pt R/tr=${mR.toFixed(3)} t=${(mR / (sd || 1) * Math.sqrt(R.length)).toFixed(2)} PF=${(l > 0 ? w / l : 99).toFixed(2)}`;
};
const days = (y: (d: string) => boolean) => sessions.filter(([d]) => y(d)).length;
const isTr = (d: string) => d < "2025-01-01", isVa = (d: string) => d >= "2025-01-01" && d < "2026-01-01", isTe = (d: string) => d >= "2026-01-01";
const SHOW_TEST = process.argv.includes("--final");
for (const c of cfgs) {
  const all: Trade[] = [];
  for (let k = 0; k < sessions.length; k++) all.push(...runSession(sessions[k][1], sessions[k][0], k > 0 ? sessions[k - 1][1] : null, c));
  const name = `${c.model} M=${c.M} sh=${c.share} stk=${c.stk} tgt=${c.tgt} win=${c.win}`.padEnd(46);
  let line = `${name} TRAIN ${fmt(all.filter((t) => isTr(t.date)), days(isTr))} | VAL ${fmt(all.filter((t) => isVa(t.date)), days(isVa))}`;
  if (SHOW_TEST) line += ` | TEST ${fmt(all.filter((t) => isTe(t.date)), days(isTe))}`;
  console.log(line);
}
