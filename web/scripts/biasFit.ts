/* ------------------------------------------------------------------ *
 * Bias fit study — the data decides the AI briefing's bias weights.
 *
 * Question: at each briefing timestamp, which lookahead-free tape
 * features predicted the next ~60-minute NQ move — and with what
 * weight? The fitted coefficients replace the hand-tuned systemVerdict
 * weights (see docs/research/BIAS_FIT.md).
 *
 * For every archived session (R2 read-through, like momentumStudy):
 *   features at T (knowable through bar T only):
 *     chgPct      NQ change vs the session-open close, %
 *     closePos    last close position inside the session range, %
 *     cumDelta    cumulative buy−sell, /1000
 *     realized    realized 1σ daily move from the last 30 closes, %
 *     htfD/htfW   daily/weekly swing structure from the PRIOR 65 RTH
 *                 sessions (−1 LH/LL · 0 CHOP · +1 HH/HL)
 *     esRs        ES chgPct − NQ chgPct (cross-market strength)
 *     esMiss      ES twin missing for this session
 *   label: NQ forward return over the slot's horizon (60 min, or to
 *   the 16:59 close for pre-close) → up/down direction.
 *
 * Fit: logistic regression (gradient descent, L2) on the first 70% of
 * sessions by date, evaluated strictly out-of-sample on the last 30%.
 * Reports per-feature weights + direction accuracy vs the always-up
 * baseline. No shuffle — walk-forward only.
 *
 *   node --import scripts/ts-loader.mjs scripts/biasFit.ts [--max N]
 *        [--no-es] [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates, cacheDir } from "../lib/archive";
import { loadEsMinutes } from "../lib/esJoin";
import { htfStructure } from "../lib/htfStructure";
import { realizedDailyBandPct } from "../lib/macroFmt";
import { etToEpoch, utcToEpoch } from "../lib/times";

/* ---------------- slots (briefing timestamps, session-minute offsets) ---------------- */

const SLOTS = [
  { key: "evening-open", offset: 5, horizon: 60 },
  { key: "pre-open", offset: 915, horizon: 60 },
  { key: "post-open", offset: 935, horizon: 60 },
  { key: "mid-morning", offset: 1050, horizon: 60 },
  { key: "midday", offset: 1170, horizon: 60 },
  { key: "pre-close", offset: 1325, horizon: 54 }, // → 16:59 close
] as const;

const FEATURES = ["chgPct", "closePos", "cumDelta", "realized", "htfD", "htfW", "esRs", "esMiss"] as const;
const ACTIVE_FEATS = ["chgPct", "closePos", "cumDelta", "realized", "htfD", "htfW"] as const;
const CONT = ["chgPct", "closePos", "cumDelta", "realized", "htfD", "htfW", "esRs"] as const;

type Sample = {
  date: string;
  slot: string;
  fwdPct: number;
  up: number;
  x: number[]; // [feat..., slot dummies...]
};

/* ---------------- helpers ---------------- */

const closeOf = (m: { o: number; c: number; high: number; low: number }) => (m.c > 0 ? m.c : (m.high + m.low) / 2);

function prevDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/* ---------------- feature extraction ---------------- */

type Feat = Record<(typeof FEATURES)[number], number>;

function rthSlice(minutes: { t: string; d: string; high: number; low: number }[], gapMin: number) {
  const lo = 930 - gapMin;
  const hi = 1320 - gapMin;
  const out: { t: string; high: number; low: number }[] = [];
  for (let i = Math.max(0, lo); i < Math.min(minutes.length, hi); i++) {
    const m = minutes[i];
    out.push({ t: `${m.d}T${m.t}:00`, high: m.high, low: m.low });
  }
  return out;
}

async function featuresAt(
  nq: { o: number; c: number; high: number; low: number; buy: number; sell: number }[],
  es: { mid: number }[] | null,
  idx: number,
  htf: { htfD: number; htfW: number },
): Promise<Feat> {
  const base = closeOf(nq[0]);
  const last = closeOf(nq[idx]);
  let hi = -Infinity;
  let lo = Infinity;
  let delta = 0;
  for (let i = 0; i <= idx; i++) {
    const m = nq[i];
    if (m.high > hi) hi = m.high;
    if (m.low < lo) lo = m.low;
    delta += m.buy - m.sell;
  }
  const closes = nq.slice(Math.max(0, idx - 29), idx + 1).map((m) => closeOf(m));
  let esRs = 0;
  let esMiss = 1;
  if (es && es.length > idx && es[0].mid > 0 && es[idx].mid > 0 && base > 0) {
    const esBase = es[0].mid;
    esRs = ((es[idx].mid - esBase) / esBase) * 100 - ((last - base) / base) * 100;
    esMiss = 0;
  }
  return {
    chgPct: base > 0 ? ((last - base) / base) * 100 : 0,
    closePos: hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50,
    cumDelta: delta / 1000,
    realized: realizedDailyBandPct(closes.map((c) => ({ c })), 30) ?? 0,
    htfD: htf.htfD,
    htfW: htf.htfW,
    esRs,
    esMiss,
  };
}

/* ---------------- model ---------------- */

function fitLogistic(X: number[][], y: number[], lr = 0.15, epochs = 400, l2 = 1e-4): number[] {
  const n = X.length;
  const d = X[0].length;
  const w = new Array<number>(d).fill(0);
  for (let e = 0; e < epochs; e++) {
    const g = new Array<number>(d).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sigmoid(dot(w, X[i]));
      const err = p - y[i];
      for (let j = 0; j < d; j++) g[j] += err * X[i][j];
    }
    for (let j = 0; j < d; j++) {
      w[j] -= lr * (g[j] / n + l2 * w[j]);
    }
  }
  return w;
}

const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

/* ---------------- main ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; noEs: boolean; dump?: string } = { noEs: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--no-es") o.noEs = true;
    else if (a === "--dump") o.dump = argv[++i];
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv);
  console.log(`biasFit: archive cache ${cacheDir()}`);
  let dates = await archiveDates({ source: "manifest" });
  dates.sort();
  if (o.max) dates = dates.slice(-o.max);
  console.log(`biasFit: ${dates.length} sessions, slots ${SLOTS.map((s) => s.key).join("/")}`);

  /* rolling prior-RTH structure (strictly before the session in question) */
  const rthWindow: { t: string; high: number; low: number }[] = [];
  const rthPerDate = new Map<string, { t: string; high: number; low: number }[]>();
  const samples: Sample[] = [];
  let sessionsWithEs = 0;

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date, { withOhlc: true });
    if (!minutes || minutes.length < 60) continue;
    const startEpoch = etToEpoch("18:00", prevDay(date));
    const firstEpoch = utcToEpoch(minutes[0].t, minutes[0].d);
    const gapMin = Math.round((firstEpoch - startEpoch) / 60_000);
    if (Math.abs(gapMin) > 720) continue; // misaligned file — skip

    /* HTF from prior sessions only (window BEFORE this date) */
    let htfD = 0;
    let htfW = 0;
    if (rthWindow.length >= 500) {
      const s = htfStructure(rthWindow);
      htfD = s.daily === "HH/HL" ? 1 : s.daily === "LH/LL" ? -1 : 0;
      htfW = s.weekly === "HH/HL" ? 1 : s.weekly === "LH/LL" ? -1 : 0;
    }

    let es: { mid: number }[] | null = null;
    if (!o.noEs) {
      try {
        const esM = await loadEsMinutes(date);
        if (esM && esM.length > 60) {
          sessionsWithEs++;
          es = esM.map((m) => ({ mid: m.mid }));
        }
      } catch {
        es = null;
      }
    }

    for (const slot of SLOTS) {
      const idx = slot.offset - gapMin;
      const end = idx + slot.horizon;
      if (idx < 0 || end >= minutes.length) continue;
      const f = await featuresAt(minutes, es, idx, { htfD, htfW });
      const fwdPct = ((closeOf(minutes[end]) - closeOf(minutes[idx])) / closeOf(minutes[idx])) * 100;
      const active = o.noEs ? ACTIVE_FEATS : [...FEATURES];
      const x = [...active.map((k) => f[k]), ...SLOTS.map((s) => (s.key === slot.key ? 1 : 0))];
      samples.push({ date, slot: slot.key, fwdPct, up: fwdPct > 0 ? 1 : 0, x });
    }

    /* after using the window: append THIS session's RTH slice for future days */
    const slice = rthSlice(minutes, gapMin);
    if (slice.length > 100) {
      rthPerDate.set(date, slice);
      rthWindow.push(...slice);
      if (rthPerDate.size > 65) {
        const oldest = rthPerDate.keys().next().value!;
        const drop = rthPerDate.get(oldest)!;
        rthPerDate.delete(oldest);
        rthWindow.splice(0, drop.length);
      }
    }
  }

  console.log(`biasFit: ${samples.length} samples (${sessionsWithEs} sessions with ES twin)`);

  /* temporal split: first 70% of DATES train, rest test */
  const byDate = new Map<string, Sample[]>();
  for (const s of samples) {
    const arr = byDate.get(s.date) ?? [];
    arr.push(s);
    byDate.set(s.date, arr);
  }
  const dSorted = [...byDate.keys()].sort();
  const cut = Math.floor(dSorted.length * 0.7);
  const trainDates = new Set(dSorted.slice(0, cut));
  const train: Sample[] = [];
  const test: Sample[] = [];
  for (const s of samples) (trainDates.has(s.date) ? train : test).push(s);
  console.log(`biasFit: train ${train.length} / test ${test.length} samples`);

  /* standardize continuous features with train stats */
  const contN = o.noEs ? ACTIVE_FEATS.length : CONT.length;
  const means = new Array<number>(contN).fill(0);
  const stds = new Array<number>(contN).fill(1);
  for (const s of train) {
    for (let j = 0; j < contN; j++) means[j] += s.x[j] / train.length;
  }
  for (const s of train) {
    for (let j = 0; j < contN; j++) stds[j] += (s.x[j] - means[j]) ** 2 / train.length;
  }
  for (let j = 0; j < contN; j++) stds[j] = Math.sqrt(stds[j]) || 1;
  const z = (x: number[]) => x.map((v, j) => (j < contN ? (v - means[j]) / stds[j] : v));

  const Xtr = train.map((s) => z(s.x));
  const Xte = test.map((s) => z(s.x));
  const w = fitLogistic(Xtr, train.map((s) => s.up));

  const predict = (X: number[][], samplesArr: Sample[], label: string) => {
    const y = samplesArr.map((s) => s.up);
    let correct = 0;
    let upN = 0;
    let meanUp = 0;
    let meanDown = 0;
    let nUp = 0;
    let nDown = 0;
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(dot(w, X[i]));
      const pred = p > 0.5 ? 1 : 0;
      if (pred === y[i]) correct++;
      if (pred === 1) {
        meanUp += samplesArr[i].fwdPct;
        nUp++;
      } else {
        meanDown += samplesArr[i].fwdPct;
        nDown++;
      }
      upN += y[i];
    }
    const baseline = Math.max(upN, X.length - upN) / X.length;
    console.log(
      `${label}: direction acc ${((correct / X.length) * 100).toFixed(1)}% · always-up baseline ${(baseline * 100).toFixed(1)}% · ` +
        `predUp mean ${((meanUp / (nUp || 1)) * 100).toFixed(2)}bp (n=${nUp}) · predDown ${((meanDown / (nDown || 1)) * 100).toFixed(2)}bp (n=${nDown})`,
    );
  };
  predict(Xtr, train, "train");
  predict(Xte, test, "TEST ");

  /* coefficients */
  console.log("\ncoefficients (standardized continuous + slot dummies):");
  const names = o.noEs ? [...ACTIVE_FEATS, ...SLOTS.map((s) => s.key)] : [...CONT, "esMiss", ...SLOTS.map((s) => s.key)];
  for (let j = 0; j < names.length; j++) {
    console.log(`  ${names[j].padEnd(14)} ${w[j] >= 0 ? "+" : ""}${w[j].toFixed(3)}`);
  }

  /* per-slot test accuracy */
  console.log("\nper-slot TEST accuracy / n / mean |fwd|:");
  for (const slot of SLOTS) {
    const sub = test.filter((s) => s.slot === slot.key);
    if (!sub.length) continue;
    let correct = 0;
    let abs = 0;
    for (let i = 0; i < sub.length; i++) {
      const si = test.indexOf(sub[i]);
      if (sigmoid(dot(w, Xte[si])) > 0.5 === (sub[i].up === 1)) correct++;
      abs += Math.abs(sub[i].fwdPct);
    }
    console.log(`  ${slot.key.padEnd(14)} ${((correct / sub.length) * 100).toFixed(1)}% · n=${String(sub.length).padStart(4)} · mean|fwd| ${((abs / sub.length) * 100).toFixed(2)}bp`);
  }

  /* threshold sweep — do the model's CONFIDENT calls beat coin-flip?
   * (this decides the chop band for systemVerdict) */
  console.log("\nthreshold sweep on TEST (score = p − 0.5; only calls outside the band):");
  for (const tau of [0.01, 0.02, 0.03, 0.05, 0.10]) {
    let calls = 0;
    let correct = 0;
    let upCalls = 0;
    let upCorrect = 0;
    for (let i = 0; i < Xte.length; i++) {
      const p = sigmoid(dot(w, Xte[i]));
      const s = p - 0.5;
      const dir = s > tau ? 1 : s < -tau ? 0 : null;
      if (dir === null) continue;
      calls++;
      if (dir === test[i].up) correct++;
      if (dir === 1) {
        upCalls++;
        if (test[i].up === 1) upCorrect++;
      }
    }
    console.log(
      `  τ=${tau.toFixed(2)}: calls ${calls}/${Xte.length} (${((calls / Xte.length) * 100).toFixed(0)}%)` +
        ` · acc ${calls ? ((correct / calls) * 100).toFixed(1) : "—"}%` +
        ` · up-acc ${upCalls ? ((upCorrect / upCalls) * 100).toFixed(1) : "—"}%`,
    );
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify({ means, stds, weights: w, names, testStats: { n: test.length } }),
      "utf8",
    );
    console.log(`\ndumped → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error("biasFit failed:", e);
  process.exit(1);
});
