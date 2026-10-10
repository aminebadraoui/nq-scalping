/* ------------------------------------------------------------------ *
 * Bias time-of-day study — at which session clock-time is the DAILY
 * BIAS call most accurate?
 *
 * Hypothesis under test: information accumulates through the session
 * (London < NY open < NY afternoon), so a direction call made later in
 * the day should be more accurate than an earlier one. Falsifiable:
 * fit the same lookahead-free feature set at every start time and
 * compare OUT-OF-SAMPLE direction accuracy across start times.
 *
 * Two labels per start time (same idx, different horizons):
 *   rem    direction from close(T) to the session close (16:59 ET) —
 *          "the daily bias call" (shrinking horizon; reported).
 *   fwd60  direction over the next 60 minutes (fixed horizon) — the
 *          control that separates "more information" from "shorter
 *          horizon is easier".
 *
 * Features (identical for every start time, known through bar T):
 *   chgPct (vs session open) · closePos (in session range) ·
 *   cumDelta (÷1000) · realized 1σ (30 closes) · htfD/htfW (swing
 *   structure from the PRIOR 65 RTH sessions — strictly lookahead-free).
 *
 * Model: per-start-time logistic regression (L2, gradient descent),
 * train on the first 70% of DATES, evaluate on the last 30% — no
 * shuffle, standardized with train stats (the biasFit discipline).
 * Reported per start time: n, test acc, always-up baseline, momentum
 * rule (sign chgPct), mean |rem|%, τ=0.10 tail (calls% + acc), Wilson
 * 95% CI on acc, train acc (overfit gap). Group verdicts (overnight /
 * NY open / midday / late) aggregated over test samples.
 *
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/biasTimeOfDay.ts [--max N] [--dump out.json]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates, cacheDir } from "../lib/archive";
import { htfStructure } from "../lib/htfStructure";
import { realizedDailyBandPct } from "../lib/macroFmt";
import { etToEpoch, utcToEpoch } from "../lib/times";
import { wilson95 } from "../lib/backtestEngine";

/* ---------------- start times (ET clock, session-minute offsets from 18:00 ET) ---------------- */

type Slot = { key: string; offset: number; group: string };
const SLOTS: Slot[] = [
  { key: "18:05", offset: 5, group: "overnight" },
  { key: "19:05", offset: 65, group: "overnight" },
  { key: "20:05", offset: 125, group: "overnight" },
  { key: "21:05", offset: 185, group: "overnight" },
  { key: "22:05", offset: 245, group: "overnight" },
  { key: "23:05", offset: 305, group: "overnight" },
  { key: "00:05", offset: 365, group: "overnight" },
  { key: "01:05", offset: 425, group: "overnight" },
  { key: "02:05", offset: 485, group: "overnight" },
  { key: "03:05", offset: 545, group: "overnight" },
  { key: "04:05", offset: 605, group: "overnight" },
  { key: "05:05", offset: 665, group: "overnight" },
  { key: "06:05", offset: 725, group: "overnight" },
  { key: "07:05", offset: 785, group: "overnight" },
  { key: "08:05", offset: 845, group: "overnight" },
  { key: "09:05", offset: 905, group: "nyOpen" },
  { key: "09:15P", offset: 915, group: "nyOpen" }, // pre-open (briefing)
  { key: "09:35", offset: 935, group: "nyOpen" }, // post-open (briefing)
  { key: "10:05", offset: 965, group: "nyOpen" },
  { key: "11:05", offset: 1025, group: "midday" },
  { key: "11:30M", offset: 1050, group: "midday" }, // mid-morning (briefing)
  { key: "12:05", offset: 1085, group: "midday" },
  { key: "13:05", offset: 1145, group: "midday" },
  { key: "13:30D", offset: 1170, group: "midday" }, // midday (briefing)
  { key: "14:05", offset: 1205, group: "late" },
  { key: "16:05", offset: 1325, group: "late" }, // pre-close (briefing)
];

const FEATURES = ["chgPct", "closePos", "cumDelta", "realized", "htfD", "htfW"] as const;

type Sample = {
  date: string;
  slot: string;
  remUp: number; // remainder-of-session direction
  remPct: number; // remainder move, % (for mean |rem|)
  fwdUp: number | null; // next-60-min direction (null when < 60 min left)
  x: number[];
};

/* ---------------- helpers ---------------- */

const closeOf = (m: { o: number; c: number; high: number; low: number }) => (m.c > 0 ? m.c : (m.high + m.low) / 2);

function prevDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);

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
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + l2 * w[j]);
  }
  return w;
}

/** Wilson 95% CI on acc = k/n now comes from the engine's wilson95
 *  (returns percent bounds). NOTE: the previous local implementation
 *  divided the interval by the Wilson denominator twice, under-stating
 *  the CI width; the engine's canonical formula is used now. */

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

/* ---------------- main ---------------- */

async function main() {
  const args = process.argv;
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : undefined;
  const dumpIdx = args.indexOf("--dump");
  const dumpPath = dumpIdx >= 0 ? args[dumpIdx + 1] : undefined;

  console.log(`biasTimeOfDay: archive cache ${cacheDir()}`);
  let dates = await archiveDates({ source: "manifest" });
  dates.sort();
  if (max) dates = dates.slice(-max);
  console.log(`biasTimeOfDay: ${dates.length} sessions, ${SLOTS.length} start times`);

  const rthWindow: { t: string; high: number; low: number }[] = [];
  const rthPerDate = new Map<string, { t: string; high: number; low: number }[]>();
  const samplesBySlot = new Map<string, Sample[]>();
  for (const s of SLOTS) samplesBySlot.set(s.key, []);

  for (const date of dates) {
    const minutes = await loadSessionMinutes(date, { withOhlc: true });
    if (!minutes || minutes.length < 60) continue;
    const startEpoch = etToEpoch("18:00", prevDay(date));
    const firstEpoch = utcToEpoch(minutes[0].t, minutes[0].d);
    const gapMin = Math.round((firstEpoch - startEpoch) / 60_000);
    if (Math.abs(gapMin) > 720) continue;

    let htfD = 0;
    let htfW = 0;
    if (rthWindow.length >= 500) {
      const s = htfStructure(rthWindow);
      htfD = s.daily === "HH/HL" ? 1 : s.daily === "LH/LL" ? -1 : 0;
      htfW = s.weekly === "HH/HL" ? 1 : s.weekly === "LH/LL" ? -1 : 0;
    }

    for (const slot of SLOTS) {
      const idx = slot.offset - gapMin;
      if (idx < 0 || idx >= minutes.length - 31) continue; // need ≥30 min remainder

      /* features known through bar idx (same definitions as biasFit) */
      const base = closeOf(minutes[0]);
      const last = closeOf(minutes[idx]);
      let hi = -Infinity;
      let lo = Infinity;
      let delta = 0;
      for (let i = 0; i <= idx; i++) {
        const m = minutes[i];
        if (m.high > hi) hi = m.high;
        if (m.low < lo) lo = m.low;
        delta += m.buy - m.sell;
      }
      const closes = minutes.slice(Math.max(0, idx - 29), idx + 1).map((m) => closeOf(m));
      const chgPct = base > 0 ? ((last - base) / base) * 100 : 0;
      const closePos = hi > lo ? ((last - lo) / (hi - lo)) * 100 : 50;
      const cumDelta = delta / 1000;
      const realized = realizedDailyBandPct(closes.map((c) => ({ c })), 30) ?? 0;
      const x = [chgPct, closePos, cumDelta, realized, htfD, htfW];

      /* labels */
      const endClose = closeOf(minutes[minutes.length - 1]);
      const remPct = ((endClose - last) / last) * 100;
      const fwd = idx + 60 < minutes.length ? ((closeOf(minutes[idx + 60]) - last) / last) * 100 : null;

      samplesBySlot.get(slot.key)!.push({
        date,
        slot: slot.key,
        remUp: remPct > 0 ? 1 : 0,
        remPct,
        fwdUp: fwd == null ? null : fwd > 0 ? 1 : 0,
        x,
      });
    }

    /* rolling HTF window (strictly prior sessions) */
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

  /* ---- per-start-time fit + evaluation (rem and fwd60) ---- */
  type Row = {
    slot: Slot;
    n: number;
    remTestN: number;
    remAcc: number | null;
    remBase: number | null;
    remMom: number | null;
    remLift: number | null;
    remTailCalls: number;
    remTailAcc: number | null;
    meanAbsRem: number;
    fwdAcc: number | null;
    fwdBase: number | null;
    trainAcc: number | null;
  };
  const rows: Row[] = [];
  const dump: Record<string, unknown> = {};

  for (const slot of SLOTS) {
    const all = samplesBySlot.get(slot.key)!;
    if (all.length < 60) {
      rows.push({ slot, n: all.length, remTestN: 0, remAcc: null, remBase: null, remMom: null, remLift: null, remTailCalls: 0, remTailAcc: null, meanAbsRem: 0, fwdAcc: null, fwdBase: null, trainAcc: null });
      continue;
    }
    const byDate = new Map<string, Sample[]>();
    for (const s of all) {
      const arr = byDate.get(s.date) ?? [];
      arr.push(s);
      byDate.set(s.date, arr);
    }
    const dSorted = [...byDate.keys()].sort();
    const cut = Math.floor(dSorted.length * 0.7);
    const trainDates = new Set(dSorted.slice(0, cut));
    const train: Sample[] = [];
    const test: Sample[] = [];
    for (const s of all) (trainDates.has(s.date) ? train : test).push(s);
    if (train.length < 100 || test.length < 50) {
      rows.push({ slot, n: all.length, remTestN: test.length, remAcc: null, remBase: null, remMom: null, remLift: null, remTailCalls: 0, remTailAcc: null, meanAbsRem: 0, fwdAcc: null, fwdBase: null, trainAcc: null });
      continue;
    }

    /* standardize with train stats */
    const d = FEATURES.length;
    const means = new Array<number>(d).fill(0);
    const stds = new Array<number>(d).fill(1);
    for (const s of train) for (let j = 0; j < d; j++) means[j] += s.x[j] / train.length;
    for (const s of train) for (let j = 0; j < d; j++) stds[j] += (s.x[j] - means[j]) ** 2 / train.length;
    for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]) || 1;
    const z = (x: number[]) => x.map((v, j) => (v - means[j]) / stds[j]);

    const fitEval = (label: "remUp" | "fwdUp") => {
      const tr = train.filter((s) => s[label] != null);
      const te = test.filter((s) => s[label] != null);
      if (tr.length < 100 || te.length < 50) return null;
      const w = fitLogistic(tr.map((s) => z(s.x)), tr.map((s) => s[label] as number));
      let correct = 0;
      let upN = 0;
      for (const s of te) {
        const p = sigmoid(dot(w, z(s.x)));
        if (p > 0.5 === (s[label] === 1)) correct++;
        upN += s[label] as number;
      }
      const acc = correct / te.length;
      const base = Math.max(upN, te.length - upN) / te.length;
      /* momentum rule on the same test set */
      let momCorrect = 0;
      for (const s of te) if ((s.x[0] > 0 ? 1 : 0) === s[label]) momCorrect++;
      return { acc, base, mom: momCorrect / te.length, w, te, upShare: upN / te.length };
    };

    const rem = fitEval("remUp");
    const fwd = fitEval("fwdUp");

    /* τ=0.10 tail on rem */
    let tailCalls = 0;
    let tailCorrect = 0;
    if (rem) {
      for (const s of rem.te) {
        const p = sigmoid(dot(rem.w, z(s.x)));
        const sc = p - 0.5;
        if (sc > 0.1 || sc < -0.1) {
          tailCalls++;
          if ((p > 0.5 ? 1 : 0) === s.remUp) tailCorrect++;
        }
      }
    }

    /* train acc (overfit gap) */
    let trainAcc: number | null = null;
    if (rem) {
      let c = 0;
      for (const s of train) {
        const p = sigmoid(dot(rem.w, z(s.x)));
        if (p > 0.5 === (s.remUp === 1)) c++;
      }
      trainAcc = c / train.length;
    }

    const meanAbsRem = all.reduce((s, x) => s + Math.abs(x.remPct), 0) / all.length;
    rows.push({
      slot,
      n: all.length,
      remTestN: rem?.te.length ?? test.length,
      remAcc: rem?.acc ?? null,
      remBase: rem?.base ?? null,
      remMom: rem?.mom ?? null,
      remLift: rem ? rem.acc - rem.base : null,
      remTailCalls: tailCalls,
      remTailAcc: tailCalls ? tailCorrect / tailCalls : null,
      meanAbsRem,
      fwdAcc: fwd?.acc ?? null,
      fwdBase: fwd?.base ?? null,
      trainAcc,
    });
    dump[slot.key] = {
      n: all.length,
      ...(rem && { remTestN: rem.te.length, remAcc: rem.acc, remBase: rem.base, remMom: rem.mom, remUpShare: rem.upShare }),
      meanAbsRem,
      ...(fwd && { fwdTestN: fwd.te.length, fwdAcc: fwd.acc, fwdBase: fwd.base }),
    };
  }

  /* ---- print ---- */
  const pct = (v: number | null, d = 1) => (v == null ? "  — " : (v * 100).toFixed(d) + "%");
  console.log("\nstart time | n   | rem-acc (CI95)      | base  | lift  | mom   | τ.10 calls/acc | mean|rem| | fwd60-acc | fwd-base | train-acc");
  console.log("-----------+-----+---------------------+-------+-------+-------+----------------+-----------+-----------+----------+----------");
  for (const r of rows) {
    const ci = r.remAcc != null && r.remTestN > 0 ? wilson95(Math.round(r.remAcc * r.remTestN), r.remTestN) : null;
    const ciS = ci ? `±${((ci[1] - ci[0]) / 2).toFixed(1)}` : "—";
    const tailPct = r.remTestN ? (r.remTailCalls / r.remTestN) * 100 : 0;
    console.log(
      `${r.slot.key.padEnd(9)} | ${String(r.n).padStart(3)} | ${pct(r.remAcc).padStart(6)} (${ciS.padStart(4)}) | ${pct(r.remBase).padStart(5)} | ${r.remLift == null ? "  — " : (r.remLift >= 0 ? "+" : "") + (r.remLift * 100).toFixed(1).padStart(5) + "%"} | ${pct(r.remMom, 1).padStart(5)} | ${String(r.remTailCalls).padStart(3)}/${String(r.n).padStart(3)} ${pct(r.remTailAcc).padStart(5)} | ${r.meanAbsRem.toFixed(2).padStart(7)}% | ${pct(r.fwdAcc).padStart(6)} | ${pct(r.fwdBase).padStart(5)} | ${pct(r.trainAcc).padStart(5)}`,
    );
  }

  /* ---- group verdicts (rem label, test samples) ---- */
  console.log("\ngroup (rem label, pooled test samples):");
  for (const group of ["overnight", "nyOpen", "midday", "late"]) {
    const slots = SLOTS.filter((s) => s.group === group);
    let k = 0;
    let n = 0;
    let upN = 0;
    for (const slot of slots) {
      const d = dump[slot.key] as { remTestN?: number; remAcc?: number; remUpShare?: number };
      if (!d?.remTestN) continue;
      k += Math.round(d.remAcc! * d.remTestN);
      n += d.remTestN;
      upN += (d.remUpShare ?? 0.5) * d.remTestN;
    }
    if (!n) continue;
    const acc = k / n;
    const base = Math.max(upN / n, 1 - upN / n);
    const ci = wilson95(k, n);
    const label = group === "overnight" ? "overnight 18:05–08:05 ET" : group === "nyOpen" ? "NY open 09:05–10:05 ET" : group === "midday" ? "midday 11:05–13:30 ET" : "late 14:05–16:05 ET";
    console.log(`  ${label.padEnd(26)} n=${String(n).padStart(4)}  acc ${pct(acc)} [${ci[0].toFixed(1)}%–${ci[1].toFixed(1)}%]  base ${pct(base)}  lift ${(acc - base) >= 0 ? "+" : ""}${((acc - base) * 100).toFixed(1)}%`);
  }

  if (dumpPath) {
    await fs.writeFile(dumpPath, JSON.stringify(dump, null, 2), "utf8");
    console.log(`\ndumped → ${dumpPath}`);
  }
}

main().catch((e) => {
  console.error("biasTimeOfDay failed:", e);
  process.exit(1);
});
