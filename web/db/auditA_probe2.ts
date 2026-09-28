/* ---------------------------------------------------------------------------
 * AUDIT A / part 2 — targeted falsification experiments.
 * Read-only; creates nothing but this file.
 *
 *   cd web && node --import ../scripts/ts-loader.mjs ./db/auditA_probe2.ts
 *
 * K: the clean/ambiguous exclusion is keyed on a NON-UNIQUE key
 * L: entries that open at or through their own stop (impossible trades)
 * M: entry-price definition tested on the subset where the true close exists
 * N: LVN zones from a fully causal stack (developing + prior sessions)
 * O: why the stop-width sweep returns identical numbers for 2..12 ticks
 * P: every headline claim restated on the per-sample clean set
 * ------------------------------------------------------------------------- */
import { analyze, extractFootprint, computeSheet, stats, type AlertEvent, type FootprintMinute } from "../lib/gcdata.ts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SESSION = "ETH" as const;
const EXPECTED = 1380;
const TICK = 0.25;
const LOOKAHEAD = 60;
const EDGE_TOL = 2.5;
const ABS_BARS = 3;
const ABS_PTS = 3;
const DIV_BARS = 10;
const ROW_TICKS = 4;

const q = (a: number[], f: number) => {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
const p1 = (x: number) => (Number.isFinite(x) ? x.toFixed(1) : "—");
const pct = (a: number[], f: number) => (a.length ? q(a, f).toFixed(2) : "—");

function dataDir() {
  const root = path.resolve(import.meta.dirname, "..", "..");
  return process.env.GC_DATA_DIR || path.join(root, "gcdata", "data");
}
function discoverDates() {
  const dir = dataDir();
  const dates: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})_ETH\.json$/.exec(f);
    if (!m) continue;
    try {
      const j = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
      if ((j.candles ?? []).length >= EXPECTED) dates.push(m[1]);
    } catch {}
  }
  return dates.sort();
}
function allDatesWith(suffix: "ETH" | "RTH") {
  const dir = dataDir();
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = new RegExp(`^(\\d{4}-\\d{2}-\\d{2})_${suffix}\\.json$`).exec(f);
    if (m) out.push(m[1]);
  }
  return out.sort();
}
function zonesFromMinutes(minutes: FootprintMinute[], upto: number, rowTicks = ROW_TICKS): [number, number][] {
  const rows = new Map<number, { buy: number; sell: number }>();
  for (let i = 0; i <= upto && i < minutes.length; i++) {
    for (const l of minutes[i].levels) {
      const cents = Math.round(l.price * 100);
      const bucket = Math.round(cents / (25 * rowTicks)) * 25 * rowTicks;
      const r = rows.get(bucket) ?? { buy: 0, sell: 0 };
      r.buy += l.buy;
      r.sell += l.sell;
      rows.set(bucket, r);
    }
  }
  const s = stats(rows);
  if (!s) return [];
  return s.lvns.slice(0, 10).map(([a, b]) => [a / 100, b / 100] as [number, number]);
}

type S = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  extreme: number;
  risk: number;
  win: boolean;
  hourET: number;
  atEdge: boolean;
  atEdgeCausal: boolean;
  atEdgeRT: boolean;
  hasClose: boolean;
  entryVwap: number;
  entryMid: number;
  barHigh: number;
  barLow: number;
  distVwapPts: number;
  distVwapR: number;
  sweepDepthR: number;
  sweepWickPts: number;
  idx: number;
  amb: boolean;
  key: string;
  invalid: boolean;
  wrongSideOfExtreme: boolean;
  snapshot: string;
};

async function main() {
  const DATES = discoverDates();
  const ethDates = allDatesWith("ETH");
  const rthDates = allDatesWith("RTH");
  const prevOf = (list: string[], d: string) => [...list].reverse().find((x) => x < d) ?? null;
  const samples: S[] = [];
  const fpCache = new Map<string, FootprintMinute[]>();
  const priorZones = new Map<string, [number, number][]>();

  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    const an = await analyze(date, SESSION, undefined, undefined, 4);
    if (!fp || !an) continue;
    const sheet = await computeSheet(date);
    const m = fp.minutes;
    fpCache.set(date, m);

    // fully-causal prior-session stack: previous session's ETH + previous RTH
    if (!priorZones.has(date)) {
      const z: [number, number][] = [];
      const pe = prevOf(ethDates, date);
      const pr = prevOf(rthDates, date);
      if (pe) {
        const f = await extractFootprint(pe, "ETH");
        if (f) z.push(...zonesFromMinutes(f.minutes, f.minutes.length - 1));
      }
      if (pr) {
        const f = await extractFootprint(pr, "RTH");
        if (f) z.push(...zonesFromMinutes(f.minutes, f.minutes.length - 1));
      }
      priorZones.set(date, z);
    }

    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);
    const vol = m.map((x) => (x.buy ?? 0) + (x.sell ?? 0));
    const medVol = q(vol, 0.5) || 1;

    const vwap: number[] = [];
    {
      let num = 0;
      let den = 0;
      for (let i = 0; i < m.length; i++) {
        const b = m[i];
        const v = (b.buy ?? 0) + (b.sell ?? 0);
        num += ((b.high + b.low + (b.c > 0 ? b.c : (b.high + b.low) / 2)) / 3) * v;
        den += v;
        vwap.push(den > 0 ? num / den : 0);
      }
    }

    const zones: [number, number][] = [];
    for (const p of Object.values(sheet.profiles)) {
      if (!p) continue;
      for (const z of (p as { LVNs?: string[] }).LVNs ?? []) {
        const [a, b] = String(z).split("–").map((x) => parseFloat(x.replace(/,/g, "")));
        if (Number.isFinite(a) && Number.isFinite(b)) zones.push([Math.min(a, b), Math.max(a, b)]);
      }
    }

    const absorption = (an.absorption ?? []) as { t: string; price: number }[];
    const divs = (an.alerts ?? []).filter((a: AlertEvent) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");
    const minuteOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

    let runLo = Infinity;
    let runHi = -Infinity;
    const reclaims: { i: number; dir: "low" | "high"; extreme: number; breakBar: number }[] = [];
    for (let i = 1; i < m.length; i++) {
      const pl = Math.min(runLo, lo[i - 1]);
      const ph = Math.max(runHi, hi[i - 1]);
      runLo = pl;
      runHi = ph;
      if (lo[i] <= pl - TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] > pl) { reclaims.push({ i: j, dir: "low", extreme: pl, breakBar: i }); break; }
        }
      }
      if (hi[i] >= ph + TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] < ph) { reclaims.push({ i: j, dir: "high", extreme: ph, breakBar: i }); break; }
        }
      }
    }

    for (const r of reclaims) {
      const bar = m[r.i];
      const entry = bar.c > 0 ? bar.c : mid[r.i];
      const dir: "long" | "short" = r.dir === "low" ? "long" : "short";
      const stop = dir === "long" ? r.extreme - 2 * TICK : r.extreme + 2 * TICK;
      const risk = Math.abs(entry - stop);
      if (!(risk > 0)) continue;
      const long = dir === "long";

      let win = false;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        if (long ? lo[k] <= stop : hi[k] >= stop) break;
        if (long ? hi[k] >= entry + risk : lo[k] <= entry - risk) { win = true; break; }
      }

      const nb = m[r.i + 1];
      const tgt = long ? entry + risk : entry - risk;
      const amb = !!nb && (long ? nb.low <= stop : nb.high >= stop) && (long ? nb.high >= tgt : nb.low <= tgt);

      const atEdge = zones.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      const cz = zonesFromMinutes(m, r.i);
      const atEdgeCausal = cz.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      const rz = [...cz, ...(priorZones.get(date) ?? [])];
      const atEdgeRT = rz.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);

      const w = vwap[r.i] || entry;
      void absorption;
      void divs;
      void minuteOf;
      void medVol;

      samples.push({
        date, t: bar.t, dir, entry, stop, extreme: r.extreme, risk, win,
        hourET: (Number(bar.t.slice(0, 2)) + 1) % 24,
        atEdge, atEdgeCausal, atEdgeRT,
        hasClose: bar.c > 0, entryVwap: bar.vwap, entryMid: mid[r.i],
        barHigh: bar.high, barLow: bar.low,
        distVwapPts: Math.abs(entry - w),
        distVwapR: Math.abs(entry - w) / risk,
        sweepDepthR: Math.abs(mid[r.breakBar] - r.extreme) / risk,
        sweepWickPts: r.dir === "low" ? r.extreme - lo[r.breakBar] : hi[r.breakBar] - r.extreme,
        idx: r.i, amb, key: `${date}|${bar.t}|${dir}`,
        invalid: long ? entry <= stop : entry >= stop,
        wrongSideOfExtreme: long ? entry < r.extreme : entry > r.extreme,
        snapshot: `brkBar=${r.breakBar} ext=${r.extreme.toFixed(2)} c=${bar.c.toFixed(2)} mid=${mid[r.i].toFixed(2)} vwapBar=${bar.vwap.toFixed(2)} lo=${bar.low.toFixed(2)} hi=${bar.high.toFixed(2)} risk=${risk.toFixed(2)}`,
      });
    }
  }

  const c = (rows: S[], keep: (s: S) => boolean = () => true) => {
    const r = rows.filter(keep);
    const w = r.filter((s) => s.win).length;
    return { n: r.length, wins: w, wr: r.length ? (w / r.length) * 100 : 0 };
  };
  const L = (label: string, x: { n: number; wins: number; wr: number }) =>
    `  ${label.padEnd(42)} n=${String(x.n).padStart(4)}  win=${p1(x.wr).padStart(5)}%`;

  console.log(`AUDIT A / part 2 — sessions ${DATES.length}  samples ${samples.length}`);
  const CLEAN = samples.filter((s) => !s.amb);
  const AMB = samples.filter((s) => s.amb);

  // ── K. key aliasing ─────────────────────────────────────────────────────
  console.log("\n=== K. The clean/ambiguous exclusion key (refine.ts:661) is NOT unique ===");
  const byKey = new Map<string, S[]>();
  for (const s of samples) {
    const a = byKey.get(s.key) ?? [];
    a.push(s);
    byKey.set(s.key, a);
  }
  const collided = [...byKey.entries()].filter(([, v]) => v.length > 1);
  const collidedSamples = collided.reduce((a, [, v]) => a + v.length, 0);
  console.log(`  distinct keys=${byKey.size}  samples=${samples.length}  keys with >1 sample=${collided.length}  samples sharing a key=${collidedSamples}`);
  const disagree = collided.filter(([, v]) => new Set(v.map((x) => x.amb)).size > 1);
  console.log(`  colliding key groups whose members DISAGREE on ambiguity: ${disagree.length} (${disagree.reduce((a, [, v]) => a + v.length, 0)} samples)`);
  for (const [k, v] of collided.slice(0, 6)) {
    console.log(`    key ${k}: ${v.length} samples`);
    for (const s of v) console.log(`      amb=${String(s.amb).padEnd(5)} win=${String(s.win).padEnd(5)} ${s.snapshot}`);
  }
  const keyClean = samples.filter((s) => {
    const g = byKey.get(s.key)!;
    return !g.some((x) => x.amb);
  });
  const keyAmb = samples.filter((s) => {
    const g = byKey.get(s.key)!;
    return g.some((x) => x.amb);
  });
  console.log(L("refine's key-based CLEAN (claim 1: 379/52.2%)", c(keyClean)));
  console.log(L("PER-SAMPLE clean (correct classification)", c(CLEAN)));
  console.log(L("PER-SAMPLE ambiguous (all are forced losses)", c(AMB)));
  console.log(`  refine's reported "ambiguous trades excluded: ${samples.length - keyClean.length} of ${samples.length}"; true per-sample count: ${AMB.length}`);
  console.log(`  ambiguous samples ADMITTED into refine's clean cohort: ${keyClean.filter((s) => s.amb).length}`);
  console.log(`  clean samples WRONGLY dropped from refine's clean cohort: ${samples.filter((s) => !s.amb).length - CLEAN.length} (dropped via key) -> ${CLEAN.length - keyClean.length}`);

  // ── L. impossible entries ───────────────────────────────────────────────
  console.log("\n=== L. Entries at/through their own stop (structural stop is beaten at the entry price) ===");
  console.log(L("all samples", c(samples)));
  console.log(L("entry at or through the stop", c(samples, (s) => s.invalid)));
  console.log(L("entry valid side of the stop", c(samples, (s) => !s.invalid)));
  console.log(`  of the invalid ones, ${samples.filter((s) => s.invalid && s.hasClose).length} use a real OHLC close and ${samples.filter((s) => s.invalid && !s.hasClose).length} use a midpoint`);
  console.log(L("entry on the WRONG SIDE of the failed extreme", c(samples, (s) => s.wrongSideOfExtreme)));
  console.log(L("entry correct side of the failed extreme", c(samples, (s) => !s.wrongSideOfExtreme)));
  console.log(`  wrong-side-of-extreme split: RTH ${samples.filter((s) => s.wrongSideOfExtreme && s.hourET >= 9 && s.hourET < 16).length}/${samples.filter((s) => s.hourET >= 9 && s.hourET < 16).length} vs overnight ${samples.filter((s) => s.wrongSideOfExtreme && !(s.hourET >= 9 && s.hourET < 16)).length}/${samples.filter((s) => !(s.hourET >= 9 && s.hourET < 16)).length}`);
  for (const s of samples.filter((x) => x.invalid).slice(0, 8)) console.log(`    invalid: ${s.date} ${s.t} ${s.dir} win=${s.win} | ${s.snapshot}`);

  // ── M. entry definition with a known true close ─────────────────────────
  console.log("\n=== M. Entry-price definition, measured where the true close IS known (RTH bars, n=121) ===");
  const rth = samples.filter((s) => s.hasClose);
  const walk = (s: S, entry: number) => {
    const long = s.dir === "long";
    const risk = Math.abs(entry - s.stop);
    if (!(risk > 0)) return false;
    const m = fpCache.get(s.date)!;
    for (let k = s.idx + 1; k < Math.min(m.length, s.idx + 1 + LOOKAHEAD); k++) {
      if (long ? m[k].low <= s.stop : m[k].high >= s.stop) return false;
      if (long ? m[k].high >= entry + risk : m[k].low <= entry - risk) return true;
    }
    return false;
  };
  const show = (label: string, pick: (s: S) => number) => {
    const rows = rth.map((s) => ({ s, win: walk(s, pick(s)) }));
    const w = rows.filter((r) => r.win).length;
    const a = rth.map((s) => Math.abs(pick(s) - s.entry));
    console.log(`  entry = ${label.padEnd(28)} win=${p1((w / rows.length) * 100).padStart(5)}%  mean|entry-close|=${(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2)}pt  med=${pct(a, 0.5)}pt`);
  };
  console.log(`  RTH samples where the true close exists: ${rth.length}`);
  show("true OHLC close (refine)", (s) => s.entry);
  show("bar MIDPOINT (what refine uses elsewhere)", (s) => s.entryMid);
  show("bar single-print VWAP", (s) => s.entryVwap);
  console.log("  |true close - midpoint| vs |true close - barVWAP| (which proxy is the close?):");
  console.log(`    |c - mid|  med=${pct(rth.map((s) => Math.abs(s.entry - s.entryMid)), 0.5)}pt   |c - vwap| med=${pct(rth.map((s) => Math.abs(s.entry - s.entryVwap)), 0.5)}pt`);
  const closer = rth.filter((s) => Math.abs(s.entry - s.entryVwap) < Math.abs(s.entry - s.entryMid)).length;
  console.log(`    barVWAP is closer to the true close than the midpoint in ${closer}/${rth.length} RTH bars (${((closer / rth.length) * 100).toFixed(0)}%)`);
  // same comparison on the claim cohorts, using midpoint-for-all vs vwap-for-all
  const swap = (mode: "refine" | "vwap" | "mid") => {
    return samples.map((s) => {
      const entry = mode === "refine" ? s.entry : mode === "vwap" ? (s.hasClose ? s.entry : s.entryVwap) : s.entryMid;
      return { s, win: walk(s, entry) };
    });
  };
  for (const mode of ["refine", "vwap", "mid"] as const) {
    const rows = swap(mode);
    const cl = rows.filter((r) => !r.s.amb);
    const sub = (label: string, keep: (r: (typeof rows)[number]) => boolean) => {
      const r = cl.filter(keep);
      const w = r.filter((x) => x.win).length;
      return `${label} ${p1(r.length ? (w / r.length) * 100 : 0)}% (n=${r.length})`;
    };
    console.log(`  [${mode}]  ${sub("LVN", (r) => r.s.atEdge)} | ${sub("notLVN", (r) => !r.s.atEdge)} | ${sub("eve", (r) => r.s.hourET >= 18 && r.s.hourET < 21)} | ${sub("notEve", (r) => !(r.s.hourET >= 18 && r.s.hourET < 21))} | ${sub("nearVWAP", (r) => r.s.distVwapPts < 50)} | ${sub("farVWAP", (r) => r.s.distVwapPts >= 50)} | ${sub("LVN+near+eve", (r) => r.s.atEdge && r.s.distVwapPts < 50 && r.s.hourET >= 18 && r.s.hourET < 21)}`);
  }

  // ── N. causal zone stack ────────────────────────────────────────────────
  console.log("\n=== N. LVN zones from a fully causal stack (developing session + prior sessions) ===");
  // VALIDATION: zonesFromMinutes(bars 0..last) must reproduce computeSheet's
  // own full-session profile (P2), otherwise the causal test is measuring a
  // different extractor and proves nothing.
  let exactSessions = 0;
  let zoneMisses = 0;
  let zoneTotal = 0;
  for (const date of DATES) {
    const f = fpCache.get(date);
    if (!f) continue;
    const mine = zonesFromMinutes(f, f.length - 1).map(([a, b]) => `${a.toFixed(2)}-${b.toFixed(2)}`).sort();
    const sheet = await computeSheet(date);
    const p2 = ((sheet.profiles.P2_full_session as { LVNs?: string[] } | null)?.LVNs ?? [])
      .map((z) => {
        const [a, b] = z.split("–").map((x) => parseFloat(x.replace(/,/g, "")));
        return `${Math.min(a, b).toFixed(2)}-${Math.max(a, b).toFixed(2)}`;
      })
      .sort();
    if (mine.join("|") === p2.join("|")) exactSessions++;
    const s2 = new Set(p2);
    for (const m of mine) { zoneTotal++; if (!s2.has(m)) zoneMisses++; }
  }
  console.log(`  VALIDATION: my causal extractor over ALL bars reproduces computeSheet's P2_full_session zones exactly in ${exactSessions}/${DATES.length} sessions (${zoneMisses} mismatched zones of ${zoneTotal})`);
  console.log(`  prior-zone pools present for ${priorZones.size}/${DATES.length} sessions; sizes: ${[...priorZones.values()].map((z) => z.length).join(",")}`);
  console.log(L("LEAKY atEdge (refine, all 6 sheet profiles)", c(samples, (s) => s.atEdge)));
  console.log(L("  complement", c(samples, (s) => !s.atEdge)));
  console.log(L("CAUSAL atEdge (bars 0..entry only)", c(samples, (s) => s.atEdgeCausal)));
  console.log(L("  complement", c(samples, (s) => !s.atEdgeCausal)));
  console.log(L("REAL-TIME STACK atEdge (developing+prior)", c(samples, (s) => s.atEdgeRT)));
  console.log(L("  complement", c(samples, (s) => !s.atEdgeRT)));
  console.log("  --- on the per-sample clean set ---");
  console.log(L("CLEAN leaky atEdge", c(CLEAN, (s) => s.atEdge)));
  console.log(L("CLEAN complement", c(CLEAN, (s) => !s.atEdge)));
  console.log(L("CLEAN real-time-stack atEdge", c(CLEAN, (s) => s.atEdgeRT)));
  console.log(L("CLEAN complement", c(CLEAN, (s) => !s.atEdgeRT)));
  const both = CLEAN.filter((s) => s.atEdge && s.atEdgeRT).length;
  const onlyLeak = CLEAN.filter((s) => s.atEdge && !s.atEdgeRT).length;
  const onlyRT = CLEAN.filter((s) => !s.atEdge && s.atEdgeRT).length;
  console.log(`  clean: both=${both}  leaky-only=${onlyLeak}  real-time-only=${onlyRT}`);
  console.log(L("CLEAN leaky-only cohort", c(CLEAN, (s) => s.atEdge && !s.atEdgeRT)));
  console.log(L("CLEAN real-time-only cohort", c(CLEAN, (s) => !s.atEdge && s.atEdgeRT)));
  console.log(L("CLEAN LVN+nearVWAP+eve (leaky)", c(CLEAN, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));
  console.log(L("CLEAN RTstack+nearVWAP+eve", c(CLEAN, (s) => s.atEdgeRT && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));

  // ── O. stop-width sweep degeneracy ──────────────────────────────────────
  console.log("\n=== O. refine.ts stop-width sweep (lines 531-568): why is it flat for 2..12 ticks? ===");
  const bestKeep = (s: S) => s.atEdge && s.distVwapR < 10 && s.sweepDepthR < 0.3;
  console.log(`  cohort "LVN + VWAP<10R + shallow" = ${samples.filter(bestKeep).length} samples (refine prints n=18)`);
  for (const ticks of [2, 4, 8, 16]) {
    let n = 0;
    let wins = 0;
    for (const s of samples.filter(bestKeep)) {
      const m = fpCache.get(s.date)!;
      const long = s.dir === "long";
      const risk = s.risk - 2 * TICK + ticks * TICK;
      const stop = long ? s.entry - risk : s.entry + risk;
      let won = false;
      for (let k = s.idx + 1; k < Math.min(m.length, s.idx + 1 + LOOKAHEAD); k++) {
        if (long ? m[k].low <= stop : m[k].high >= stop) break;
        if (long ? m[k].high >= s.entry + risk : m[k].low <= s.entry - risk) { won = true; break; }
      }
      n++;
      if (won) wins++;
    }
    console.log(`    stop ${String(ticks).padStart(2)} ticks: n=${n} win=${p1((wins / Math.max(1, n)) * 100)}%`);
  }
  const firstN = new Map<number, number>();
  for (const s of samples) {
    const m = fpCache.get(s.date)!;
    const long = s.dir === "long";
    let decided = -1;
    for (let k = s.idx + 1; k < Math.min(m.length, s.idx + 1 + LOOKAHEAD); k++) {
      const hitStop = long ? m[k].low <= s.stop : m[k].high >= s.stop;
      const hitTgt = long ? m[k].high >= s.entry + s.risk : m[k].low <= s.entry - s.risk;
      if (hitStop || hitTgt) { decided = k - s.idx; break; }
    }
    firstN.set(decided, (firstN.get(decided) ?? 0) + 1);
  }
  console.log("  bars from entry until the outcome is decided (bar 1 = the bar right after the confirmation bar):");
  for (const [k, v] of [...firstN.entries()].sort((a, b) => a[0] - b[0]).slice(0, 8)) {
    console.log(`    decided on forward bar ${String(k).padStart(2)}: ${String(v).padStart(3)} samples (${((v / samples.length) * 100).toFixed(1)}%)`);
  }
  console.log(`  samples never decided inside 60 bars: ${firstN.get(-1) ?? 0}`);
  const firstBarWin = samples.filter((s) => {
    const m = fpCache.get(s.date)!;
    const long = s.dir === "long";
    const b = m[s.idx + 1];
    if (!b) return false;
    return long ? b.high >= s.entry + s.risk : b.low <= s.entry - s.risk;
  }).length;
  console.log(`  trades whose 1R target is already inside the FIRST forward bar: ${firstBarWin}/${samples.length} (${((firstBarWin / samples.length) * 100).toFixed(1)}%)`);

  // ── P. all claims on the per-sample clean set ───────────────────────────
  console.log("\n=== P. Headline claims restated on the CORRECT per-sample clean set ===");
  const base = c(CLEAN);
  console.log(L("baseline (claim 1 says 52.2%, n=379)", base));
  const contrast = (label: string, a: ReturnType<typeof c>, b: ReturnType<typeof c>) =>
    console.log(`  ${label.padEnd(34)} ${p1(a.wr)}% (n=${a.n}) vs ${p1(b.wr)}% (n=${b.n})  diff=${(a.wr - b.wr) >= 0 ? "+" : ""}${(a.wr - b.wr).toFixed(1)}pt`);
  contrast("claim 2 LVN edge", c(CLEAN, (s) => s.atEdge), c(CLEAN, (s) => !s.atEdge));
  contrast("claim 3 evening 18-21", c(CLEAN, (s) => s.hourET >= 18 && s.hourET < 21), c(CLEAN, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  contrast("claim 4 near VWAP <50pt", c(CLEAN, (s) => s.distVwapPts < 50), c(CLEAN, (s) => s.distVwapPts >= 50));
  console.log(L("claim 5 LVN+nearVWAP+eve (says 74.4%, n=39)", c(CLEAN, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));
  console.log("  same claims on RAW samples (no exclusion):");
  contrast("claim 2 raw", c(samples, (s) => s.atEdge), c(samples, (s) => !s.atEdge));
  contrast("claim 3 raw", c(samples, (s) => s.hourET >= 18 && s.hourET < 21), c(samples, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  contrast("claim 4 raw", c(samples, (s) => s.distVwapPts < 50), c(samples, (s) => s.distVwapPts >= 50));
  console.log(L("claim 5 raw", c(samples, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));
  console.log("  with the impossible entries removed AND the noise trades (entry on the wrong side of the extreme) removed:");
  const sane = CLEAN.filter((s) => !s.wrongSideOfExtreme);
  console.log(L("baseline (clean, sane entries)", c(sane)));
  contrast("claim 2", c(sane, (s) => s.atEdge), c(sane, (s) => !s.atEdge));
  contrast("claim 3", c(sane, (s) => s.hourET >= 18 && s.hourET < 21), c(sane, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  contrast("claim 4", c(sane, (s) => s.distVwapPts < 50), c(sane, (s) => s.distVwapPts >= 50));
  console.log(L("claim 5", c(sane, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));

  // ── Q. confounds between the filters themselves ─────────────────────────
  console.log("\n=== Q. Are the four filters independent evidence? ===");
  const hasCloseRate = (rows: S[], label: string) => {
    const wc = rows.filter((s) => s.hasClose).length;
    const mid = rows.filter((s) => !s.hasClose);
    console.log(`  ${label.padEnd(30)} n=${String(rows.length).padStart(3)}  withTrueClose=${String(wc).padStart(3)} (${((wc / Math.max(1, rows.length)) * 100).toFixed(0)}%)  midpoint-entry=${String(mid.length).padStart(3)}`);
    const w1 = rows.filter((s) => s.hasClose);
    if (w1.length) console.log(`      close-entry sub-cohort win=${p1((w1.filter((s) => s.win).length / w1.length) * 100)}% (n=${w1.length})   midpoint sub-cohort win=${p1((mid.filter((s) => s.win).length / Math.max(1, mid.length)) * 100)}% (n=${mid.length})`);
  };
  hasCloseRate(samples, "ALL");
  hasCloseRate(samples.filter((s) => s.atEdge), "at LVN edge");
  hasCloseRate(samples.filter((s) => !s.atEdge), "not at LVN edge");
  hasCloseRate(samples.filter((s) => s.distVwapPts < 50), "near VWAP <50pt");
  hasCloseRate(samples.filter((s) => s.distVwapPts >= 50), "far VWAP >=50pt");
  hasCloseRate(samples.filter((s) => s.hourET >= 18 && s.hourET < 21), "evening 18-21");
  hasCloseRate(samples.filter((s) => !(s.hourET >= 18 && s.hourET < 21)), "not evening");
  const sets: [string, (s: S) => boolean][] = [
    ["LVN", (s) => s.atEdge],
    ["nearVWAP<50", (s) => s.distVwapPts < 50],
    ["evening", (s) => s.hourET >= 18 && s.hourET < 21],
  ];
  console.log("  overlap matrix (clean set):");
  for (let i = 0; i < sets.length; i++) {
    for (let j = 0; j < sets.length; j++) {
      const r = CLEAN.filter((s) => sets[i][1](s) && sets[j][1](s));
      console.log(`    ${sets[i][0].padEnd(12)} & ${sets[j][0].padEnd(12)} = ${String(r.length).padStart(3)}`);
    }
  }
  const ev = CLEAN.filter((s) => s.hourET >= 18 && s.hourET < 21);
  console.log(`  of the ${ev.length} clean evening samples, ${ev.filter((s) => s.distVwapPts < 50).length} are also 'near VWAP' and ${ev.filter((s) => s.atEdge).length} are also 'at LVN edge'`);
  const nv = CLEAN.filter((s) => s.distVwapPts < 50);
  console.log(`  of the ${nv.length} clean near-VWAP samples, ${nv.filter((s) => s.hourET >= 18 && s.hourET < 21).length} are in the evening bucket (ET hour histogram: ${[...new Set(nv.map((s) => s.hourET))].sort((a, b) => a - b).join(",")})`);
  console.log(`  far-VWAP cohort ET hours: ${[...new Set(CLEAN.filter((s) => s.distVwapPts >= 50).map((s) => s.hourET))].sort((a, b) => a - b).join(",")}`);
  const idxOf = new Map(samples.map((s) => [s.key, s.idx]));
  void idxOf;
  console.log(`  entry-bar index (0..1379) medians: evening=${pct(ev.map((s) => s.idx), 0.5)}  nearVWAP=${pct(nv.map((s) => s.idx), 0.5)}  farVWAP=${pct(CLEAN.filter((s) => s.distVwapPts >= 50).map((s) => s.idx), 0.5)}  LVN=${pct(CLEAN.filter((s) => s.atEdge).map((s) => s.idx), 0.5)}`);
  // reclaim ordinal monotonicity
  let outOfOrder = 0;
  const perDate = new Map<string, S[]>();
  for (const s of samples) {
    const a = perDate.get(s.date) ?? [];
    a.push(s);
    perDate.set(s.date, a);
  }
  for (const [, v] of perDate) for (let i = 1; i < v.length; i++) if (v[i].idx < v[i - 1].idx) outOfOrder++;
  console.log(`  reclaim samples whose entry bar is EARLIER than the previous sample's entry bar (ordinal not chronological): ${outOfOrder}/${samples.length}`);
  // two-proportion tests on the corrected clean set
  const normTail = (z: number) => {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const d = 0.3989423 * Math.exp((-z * z) / 2);
    const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return z > 0 ? tail : 1 - tail;
  };
  const twoProp = (a: { n: number; wins: number }, b: { n: number; wins: number }, label: string) => {
    const p1_ = a.wins / a.n;
    const p2_ = b.wins / b.n;
    const pooled = (a.wins + b.wins) / (a.n + b.n);
    const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
    const z = (p1_ - p2_) / se;
    console.log(`  ${label.padEnd(36)} diff=${((p1_ - p2_) * 100).toFixed(1)}pt  z=${z.toFixed(2)}  two-sided p=${(2 * normTail(Math.abs(z))).toFixed(4)}`);
  };
  twoProp(c(CLEAN, (s) => s.atEdge), c(CLEAN, (s) => !s.atEdge), "LVN edge vs not (clean)");
  twoProp(c(CLEAN, (s) => s.hourET >= 18 && s.hourET < 21), c(CLEAN, (s) => !(s.hourET >= 18 && s.hourET < 21)), "evening vs rest (clean)");
  twoProp(c(CLEAN, (s) => s.distVwapPts < 50), c(CLEAN, (s) => s.distVwapPts >= 50), "near vs far VWAP (clean)");
  twoProp(c(CLEAN, (s) => s.atEdgeRT), c(CLEAN, (s) => !s.atEdgeRT), "REAL-TIME-stack LVN vs not (clean)");
  twoProp(c(CLEAN, (s) => s.atEdge), c(CLEAN, (s) => !s.atEdge), "  (leaky LVN for comparison)");

  // ── R. controlled tests: are the filters proxies for something else? ────
  console.log("\n=== R. Controlled tests ===");
  // R1 sanity: how many outcomes actually change with the entry convention?
  const flips = (mode: "vwap" | "mid") =>
    samples.filter((s) => {
      const e = mode === "vwap" ? (s.hasClose ? s.entry : s.entryVwap) : s.entryMid;
      return walk(s, e) !== walk(s, s.entry);
    }).length;
  console.log(`  outcomes that change when the entry price moves: vwap-vs-refine ${flips("vwap")}/449, mid-vs-refine ${flips("mid")}/449`);
  console.log(`  mean |mid - barVWAP| over all samples: ${(samples.reduce((a, s) => a + Math.abs(s.entryMid - s.entryVwap), 0) / samples.length).toFixed(3)}pt`);
  const lvnClean = CLEAN.filter((s) => s.atEdge);
  const lvnFlip = lvnClean.filter((s) => walk(s, s.hasClose ? s.entry : s.entryVwap) !== walk(s, s.entry)).length;
  console.log(`  LVN-edge clean cohort: outcomes that change under the vwap entry: ${lvnFlip}/${lvnClean.length}`);

  // R2: is "near VWAP" just "early session / no OHLC"?
  const overnightOnly = CLEAN.filter((s) => s.hourET >= 18 || s.hourET < 8);
  console.log(`  overnight-only clean subset n=${overnightOnly.length}`);
  contrast("  claim4 near/far VWAP | overnight only", c(overnightOnly, (s) => s.distVwapPts < 50), c(overnightOnly, (s) => s.distVwapPts >= 50));
  contrast("  claim4 near/far VWAP | evening only", c(ev, (s) => s.distVwapPts < 50), c(ev, (s) => s.distVwapPts >= 50));
  const rthOnly = CLEAN.filter((s) => s.hourET >= 9 && s.hourET < 16);
  console.log(`  RTH-only clean subset n=${rthOnly.length}; near-VWAP n=${rthOnly.filter((s) => s.distVwapPts < 50).length}`);
  contrast("  claim4 near/far VWAP | evening excluded", c(CLEAN.filter((s) => !(s.hourET >= 18 && s.hourET < 21)), (s) => s.distVwapPts < 50), c(CLEAN.filter((s) => !(s.hourET >= 18 && s.hourET < 21)), (s) => s.distVwapPts >= 50));
  contrast("  claim3 evening vs rest | near-VWAP only", c(nv, (s) => s.hourET >= 18 && s.hourET < 21), c(nv, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  contrast("  claim3 eve vs overnight-non-eve", c(overnightOnly, (s) => s.hourET >= 18 && s.hourET < 21), c(overnightOnly, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  const trueClose = CLEAN.filter((s) => s.hasClose);
  console.log(`  clean samples with an OBSERVABLE entry price (true OHLC close): ${trueClose.length}/${CLEAN.length}; evening cohort ${ev.filter((s) => s.hasClose).length}/${ev.length}; claim-5 combo ${CLEAN.filter((s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21 && s.hasClose).length}/39`);
  // decisive controls: hold BOTH the entry convention (overnight) and the hour fixed
  const onNonEve = overnightOnly.filter((s) => !(s.hourET >= 18 && s.hourET < 21));
  console.log(`  overnight AND not-evening clean subset n=${onNonEve.length} (one entry convention, one hour regime)`);
  contrast("  claim4 near/far VWAP | overnight non-evening", c(onNonEve, (s) => s.distVwapPts < 50), c(onNonEve, (s) => s.distVwapPts >= 50));
  contrast("  claim2 LVN | overnight non-evening", c(onNonEve, (s) => s.atEdge), c(onNonEve, (s) => !s.atEdge));
  contrast("  claim2 RTstack LVN | overnight non-evening", c(onNonEve, (s) => s.atEdgeRT), c(onNonEve, (s) => !s.atEdgeRT));
  const eveSet = CLEAN.filter((s) => s.hourET >= 18 && s.hourET < 21);
  console.log(`  evening-only: LVN leg ${p1(c(eveSet, (s) => s.atEdge).wr)}% (n=${c(eveSet, (s) => s.atEdge).n}) vs not ${p1(c(eveSet, (s) => !s.atEdge).wr)}% (n=${c(eveSet, (s) => !s.atEdge).n}); near-VWAP ${p1(c(eveSet, (s) => s.distVwapPts < 50).wr)}% (n=${c(eveSet, (s) => s.distVwapPts < 50).n})`);
  console.log(`  claim5 combo legs: evening alone ${p1(c(eveSet, () => true).wr)}%, evening+LVN ${p1(c(eveSet, (s) => s.atEdge).wr)}% (n=${c(eveSet, (s) => s.atEdge).n}), evening+nearVWAP ${p1(c(eveSet, (s) => s.distVwapPts < 50).wr)}% (n=${c(eveSet, (s) => s.distVwapPts < 50).n}), all three ${p1(c(eveSet, (s) => s.atEdge && s.distVwapPts < 50).wr)}% (n=${c(eveSet, (s) => s.atEdge && s.distVwapPts < 50).n})`);
  console.log(`  evening + REAL-TIME-stack LVN: ${p1(c(eveSet, (s) => s.atEdgeRT).wr)}% (n=${c(eveSet, (s) => s.atEdgeRT).n}) vs evening without ${p1(c(eveSet, (s) => !s.atEdgeRT).wr)}% (n=${c(eveSet, (s) => !s.atEdgeRT).n})`);
  console.log(`  evening + RTstack LVN + nearVWAP: ${p1(c(eveSet, (s) => s.atEdgeRT && s.distVwapPts < 50).wr)}% (n=${c(eveSet, (s) => s.atEdgeRT && s.distVwapPts < 50).n})`);
  console.log(`  evening + CAUSAL(developing) LVN: ${p1(c(eveSet, (s) => s.atEdgeCausal).wr)}% (n=${c(eveSet, (s) => s.atEdgeCausal).n}) vs without ${p1(c(eveSet, (s) => !s.atEdgeCausal).wr)}% (n=${c(eveSet, (s) => !s.atEdgeCausal).n})`);

  // R3: every 3-hour ET window, ranked (is the evening window special?)
  console.log("  3-hour ET windows on the clean set (window start hour -> win rate):");
  const wins: { h: number; n: number; wr: number }[] = [];
  for (let h = 0; h < 24; h++) {
    const rows = CLEAN.filter((s) => {
      const rel = (s.hourET - h + 24) % 24;
      return rel < 3;
    });
    if (rows.length >= 30) wins.push({ h, n: rows.length, wr: (rows.filter((s) => s.win).length / rows.length) * 100 });
  }
  wins.sort((a, b) => b.wr - a.wr);
  wins.forEach((w, i) => console.log(`    rank ${String(i + 1).padStart(2)}  ET ${String(w.h).padStart(2, "0")}:00-${String((w.h + 3) % 24).padStart(2, "0")}:00  n=${String(w.n).padStart(3)}  win=${p1(w.wr)}%${w.h === 18 ? "   <-- the claimed window" : ""}`));
  compactWindows();
  function compactWindows() {
    for (const h of [17, 18, 19, 20, 21]) {
      const rows = CLEAN.filter((s) => {
        const rel = (s.hourET - h + 24) % 24;
        return rel < 3;
      });
      console.log(`    (all n) ET ${String(h).padStart(2, "0")}:00-${String((h + 3) % 24).padStart(2, "0")}:00 n=${String(rows.length).padStart(3)} win=${p1(rows.length ? (rows.filter((s) => s.win).length / rows.length) * 100 : 0)}%`);
    }
  }

  // R4: LVN edge within one entry convention only
  console.log("  claim2 LVN inside a single entry convention:");
  contrast("  leaky LVN | overnight-only", c(overnightOnly, (s) => s.atEdge), c(overnightOnly, (s) => !s.atEdge));
  contrast("  RT-stack LVN | overnight-only", c(overnightOnly, (s) => s.atEdgeRT), c(overnightOnly, (s) => !s.atEdgeRT));
  contrast("  leaky LVN | RTH-only", c(rthOnly, (s) => s.atEdge), c(rthOnly, (s) => !s.atEdge));
  const lvnMidWin = lvnClean.filter((s) => walk(s, s.hasClose ? s.entry : s.entryVwap)).length / Math.max(1, lvnClean.length) * 100;
  console.log(`  LVN clean cohort under the vwap entry: ${p1(lvnMidWin)}% (vs ${p1((lvnClean.filter((s) => s.win).length / lvnClean.length) * 100)}% under refine's entry)`);

  // ── S. does the exclusion catch EVERY convention-decided trade? ─────────
  console.log("\n=== S. The exclusion tests only the bar AFTER entry, not the DECIDING bar ===");
  type Decided = { s: S; k: number; both: boolean };
  const decided: Decided[] = [];
  for (const s of samples) {
    const m = fpCache.get(s.date)!;
    const long = s.dir === "long";
    const tgt = long ? s.entry + s.risk : s.entry - s.risk;
    let found: Decided | null = null;
    for (let k = s.idx + 1; k < Math.min(m.length, s.idx + 1 + LOOKAHEAD); k++) {
      const hitStop = long ? m[k].low <= s.stop : m[k].high >= s.stop;
      const hitTgt = long ? m[k].high >= tgt : m[k].low <= tgt;
      if (hitStop || hitTgt) {
        found = { s, k: k - s.idx, both: hitStop && hitTgt };
        break;
      }
    }
    if (found) decided.push(found);
  }
  const bothLater = decided.filter((d) => d.both && d.k > 1);
  console.log(`  trades decided on a bar that contains BOTH stop and target, on a bar AFTER the first: ${bothLater.length} (${((bothLater.length / samples.length) * 100).toFixed(1)}% of all samples)`);
  console.log(`  of those, ${bothLater.filter((d) => !d.s.amb).length} are still counted as "CLEAN" by refine.ts (its check only looks at the bar right after entry)`);
  const trulyClean = samples.filter((s) => {
    const d = decided.find((x) => x.s === s);
    return d ? !d.both : false;
  });
  console.log(L("refine CLEAN (per-sample)", c(CLEAN)));
  console.log(L("TRULY convention-free (deciding bar single-level)", c(trulyClean)));
  console.log(L("  residual convention-decided inside CLEAN", c(CLEAN.filter((s) => !trulyClean.includes(s)))));
  console.log("  claims restated on the truly convention-free set:");
  contrast("  claim 2 LVN", c(trulyClean, (s) => s.atEdge), c(trulyClean, (s) => !s.atEdge));
  contrast("  claim 3 evening", c(trulyClean, (s) => s.hourET >= 18 && s.hourET < 21), c(trulyClean, (s) => !(s.hourET >= 18 && s.hourET < 21)));
  contrast("  claim 4 nearVWAP", c(trulyClean, (s) => s.distVwapPts < 50), c(trulyClean, (s) => s.distVwapPts >= 50));
  console.log(L("  claim 5 LVN+near+eve", c(trulyClean, (s) => s.atEdge && s.distVwapPts < 50 && s.hourET >= 18 && s.hourET < 21)));

  // ── T. claim 6 on the clean set ─────────────────────────────────────────
  console.log("\n=== T. Claim 6: 'shallow sweep' retraction, re-tested on clean outcomes ===");
  const wicks = CLEAN.map((s) => Math.abs(s.entry > s.extreme ? s.entry - s.extreme : s.entry - s.extreme));
  void wicks;
  const cutsT = [0.25, 0.5, 0.75].map((f) => q(CLEAN.map((s) => s.sweepDepthR), f));
  const bT = [0, ...cutsT, Infinity];
  console.log(`  clean sweepDepthR quartile cuts: ${cutsT.map((x) => x.toFixed(2)).join(" / ")}`);
  for (let i = 0; i < 4; i++) {
    const r = CLEAN.filter((s) => s.sweepDepthR >= bT[i] && s.sweepDepthR < bT[i + 1]);
    console.log(`    ratio Q${i + 1} [${bT[i].toFixed(2)}..${bT[i + 1] === Infinity ? "inf" : bT[i + 1].toFixed(2)}] n=${String(r.length).padStart(3)} win=${p1(r.length ? (r.filter((s) => s.win).length / r.length) * 100 : 0)}%`);
  }
    const rcT = [0.25, 0.5, 0.75].map((f) => q(CLEAN.map((s) => s.risk), f));
  const rbT = [0, ...rcT, Infinity];
  console.log(`  clean risk quartile cuts: ${rcT.map((x) => x.toFixed(2)).join(" / ")}`);
  for (let i = 0; i < 4; i++) {
    const band = CLEAN.filter((s) => s.risk >= rbT[i] && s.risk < rbT[i + 1]);
    const med = q(band.map((s) => s.sweepDepthR), 0.5);
    const lo = c(band, (s) => s.sweepDepthR < med);
    const hi = c(band, (s) => s.sweepDepthR >= med);
    const medW = q(band.map((s) => Math.abs(s.entry - s.extreme) - Math.abs(s.entry - s.extreme)), 0.5);
    void medW;
    console.log(`    risk band Q${i + 1} [${rbT[i].toFixed(2)}..${rbT[i + 1] === Infinity ? "inf" : rbT[i + 1].toFixed(2)}] n=${String(band.length).padStart(3)}  ratio<med ${p1(lo.wr)}% (n=${lo.n})  ratio>=med ${p1(hi.wr)}% (n=${hi.n})  diff=${(lo.wr - hi.wr).toFixed(1)}pt`);
  }
  console.log("  risk deciles on clean (denominator only):");
  const kc = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((f) => q(CLEAN.map((s) => s.risk), f));
  const kbT = [0, ...kc, Infinity];
  for (let i = 0; i < 10; i++) {
    const r = CLEAN.filter((s) => s.risk >= kbT[i] && s.risk < kbT[i + 1]);
    if (r.length) console.log(`    risk D${i + 1} [${kbT[i].toFixed(2)}..${kbT[i + 1] === Infinity ? "inf" : kbT[i + 1].toFixed(2)}] n=${String(r.length).padStart(3)} win=${p1((r.filter((s) => s.win).length / r.length) * 100)}%`);
  }
  console.log("  penetration in ABSOLUTE points (the ratio's numerator) on clean, deciles:");
  const wqc = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((f) => q(CLEAN.map((s) => s.sweepWickPts), f));
  const wbT = [0, ...wqc, Infinity];
  for (let i = 0; i < 10; i++) {
    const r = CLEAN.filter((s) => s.sweepWickPts >= wbT[i] && s.sweepWickPts < wbT[i + 1]);
    if (r.length) console.log(`    wick D${i + 1} [${wbT[i].toFixed(2)}..${wbT[i + 1] === Infinity ? "inf" : wbT[i + 1].toFixed(2)}] n=${String(r.length).padStart(3)} win=${p1((r.filter((s) => s.win).length / r.length) * 100)}%`);
  }
}

await main();
