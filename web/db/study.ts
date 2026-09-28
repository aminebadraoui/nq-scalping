/* ---------------------------------------------------------------------------
 * Strategy study: does the playbook survive contact with our own data?
 *
 *   node --import ../scripts/ts-loader.mjs ./db/study.ts
 *
 * Uses the SAME engine as the dashboard (lib/gcdata.ts) so the signals are
 * exactly the ones the checklist shows. For every reclaim (the trigger) we walk
 * forward and measure whether +1R or −1R was touched first, then split the
 * results by the conditions the strategy claims matter:
 *
 *   location   — at an LVN edge from the profile stack (≤ 2.5 pt)
 *   mechanism  — absorption within ±3 bars and 3 pt of the reclaim
 *   fuel       — the matching CVD divergence (D2 for longs / D4 for shorts)
 *   stacked    — all three together (the "+3 required" case)
 *
 * Honest caveats, printed with the results: perfect fills at the bar close, no
 * fees/slippage, overlapping trades, and only the sessions we have collected.
 * ------------------------------------------------------------------------- */
import { analyze, extractFootprint, computeSheet, type AlertEvent, type AbsorbEvent } from "../lib/gcdata.ts";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SESSION = "ETH" as const;
const EXPECTED_ETH_MINUTES = 1380; // 18:00 -> 16:59 New York

/**
 * Discover analysable sessions instead of hardcoding a handful of dates.
 *
 * The vendor retains the most recent ~10 sessions in full but older dates come
 * back SPARSE — the session still spans the full clock while minutes are
 * missing from the middle. A gap fabricates "no break in N bars" and truncates
 * forward walks, so a partial day is not a smaller sample, it is a wrong one.
 * Only sessions holding every expected minute are used.
 */
function discoverDates() {
  const root = path.resolve(import.meta.dirname, "..", "..");
  const dir = process.env.GC_DATA_DIR || path.join(root, "gcdata", "data");
  const dates: string[] = [];
  const skipped: string[] = [];
  for (const f of readdirSync(dir)) {
    const m = /^(\d{4}-\d{2}-\d{2})_ETH\.json$/.exec(f);
    if (!m) continue;
    let candles: { t: string }[] = [];
    try {
      candles = JSON.parse(readFileSync(path.join(dir, f), "utf8")).candles ?? [];
    } catch {
      continue;
    }
    const ts = candles.map((c) => c.t).sort();
    let usable = candles.length >= 1360;
    if (usable) {
      const base = Number(ts[0].slice(8, 10));
      const mins = ts.map((t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) + (Number(t.slice(8, 10)) - base) * 1440);
      let maxgap = 0;
      for (let i = 1; i < mins.length; i++) maxgap = Math.max(maxgap, mins[i] - mins[i - 1]);
      usable = mins[0] % 1440 >= 1020 && mins[0] % 1440 <= 1035 && mins[mins.length - 1] % 1440 === 959 && maxgap <= 5;
    }
    if (usable) dates.push(m[1]);
    else skipped.push(`${m[1]} (${candles.length}/${EXPECTED_ETH_MINUTES} minutes)`);
  }
  return { dates: dates.sort(), skipped: skipped.sort() };
}

const DISCOVERED = discoverDates();
const DATES = DISCOVERED.dates;
const LOOKAHEAD = 60; // bars to walk forward
const TICK = 0.25;
const EDGE_TOL = 2.5; // pts — "at" an LVN edge
const ABS_BARS = 3;
const ABS_PTS = 3;
const DIV_BARS = 10;
const BASE_R = 1; // 1R target / 1R risk for the headline test

type Trade = {
  date: string;
  t: string;
  dir: "long" | "short";
  entry: number;
  stop: number;
  r: number;
  outcome: "win" | "loss" | "open";
  mfeR: number;
  maeR: number;
  atEdge: boolean;
  hasAbs: boolean;
  hasDiv: boolean;
  vwapSide: "above" | "below";
  hourET: number;
};

function parseZones(sheet: Awaited<ReturnType<typeof computeSheet>>): [number, number][] {
  const out: [number, number][] = [];
  for (const p of Object.values(sheet.profiles)) {
    if (!p) continue;
    for (const z of p.LVNs ?? []) {
      const [a, b] = z.split("–").map((x) => parseFloat(x.replace(/,/g, "")));
      if (Number.isFinite(a) && Number.isFinite(b)) out.push([a, b]);
    }
  }
  return out;
}

/** feed clock (US Central) HH:mm → ET hour, for the session-hour split */
function etHour(t: string): number {
  const h = Number(t.slice(0, 2));
  return (h + 1) % 24;
}

type FpMinutes = NonNullable<Awaited<ReturnType<typeof extractFootprint>>>["minutes"];
type Sheet = Awaited<ReturnType<typeof computeSheet>>;

const fpCache = new Map<string, FpMinutes>();
const sheetCache = new Map<string, Sheet>();

async function main() {
  const trades: Trade[] = [];
  let minutesTotal = 0;

  console.log(
    `Analysable sessions: ${DATES.length} complete ETH days (${DATES[0]} .. ${DATES[DATES.length - 1]})` +
      (DISCOVERED.skipped.length
        ? `\nExcluded as partially retained (a gap would fabricate structure): ${DISCOVERED.skipped.length} days — ${DISCOVERED.skipped.slice(0, 8).join(", ")}${DISCOVERED.skipped.length > 8 ? " ..." : ""}`
        : ""),
  );

  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    const an = await analyze(date, SESSION, undefined, undefined, 4);
    if (!fp || !an) {
      console.log(`skip ${date}: no data`);
      continue;
    }
    fpCache.set(date, fp.minutes);
    const sheet = await computeSheet(date);
    sheetCache.set(date, sheet);
    const zones = parseZones(sheet);
    const m = fp.minutes;
    minutesTotal += m.length;

    const hi = m.map((x) => x.high);
    const lo = m.map((x) => x.low);
    const mid = m.map((x) => (x.high + x.low) / 2);

    // ── reclaims, recomputed to capture the CONFIRMATION bar (the tradable
    //    moment) rather than the break bar the analyzer reports ──────────────
    let runLo = Infinity;
    let runHi = -Infinity;
    const reclaims: { i: number; dir: "low" | "high"; extreme: number }[] = [];
    for (let i = 1; i < m.length; i++) {
      const pl = Math.min(runLo, lo[i - 1]);
      const ph = Math.max(runHi, hi[i - 1]);
      runLo = pl;
      runHi = ph;
      if (lo[i] <= pl - TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] > pl) {
            reclaims.push({ i: j, dir: "low", extreme: pl });
            break;
          }
        }
      }
      if (hi[i] >= ph + TICK) {
        for (let j = i + 1; j < Math.min(m.length, i + 3); j++) {
          if (mid[j] < ph) {
            reclaims.push({ i: j, dir: "high", extreme: ph });
            break;
          }
        }
      }
    }

    const absorption = (an.absorption ?? []) as AbsorbEvent[];
    const divs = (an.alerts ?? []).filter((a: AlertEvent) => a.kind === "DIVERGENCE_D2" || a.kind === "DIVERGENCE_D4");

    for (const r of reclaims) {
      const bar = m[r.i];
      const entry = bar.c > 0 ? bar.c : mid[r.i];
      const dir: "long" | "short" = r.dir === "low" ? "long" : "short";
      // mechanical stop: 2 ticks beyond the failed extreme
      const stop = dir === "long" ? r.extreme - 2 * TICK : r.extreme + 2 * TICK;
      const rPts = Math.abs(entry - stop);
      if (!(rPts > 0)) continue;

      let outcome: Trade["outcome"] = "open";
      let mfe = 0;
      let mae = 0;
      for (let k = r.i + 1; k < Math.min(m.length, r.i + 1 + LOOKAHEAD); k++) {
        const moveUp = hi[k] - entry;
        const moveDn = entry - lo[k];
        const fav = dir === "long" ? moveUp : moveDn;
        const adv = dir === "long" ? moveDn : moveUp;
        mfe = Math.max(mfe, fav / rPts);
        mae = Math.max(mae, adv / rPts);
        // pessimistic: if both levels are inside the same bar, the stop is hit first
        const hitStop = dir === "long" ? lo[k] <= stop : hi[k] >= stop;
        const hitTarget = dir === "long" ? hi[k] >= entry + BASE_R * rPts : lo[k] <= entry - BASE_R * rPts;
        if (hitStop) {
          outcome = "loss";
          break;
        }
        if (hitTarget) {
          outcome = "win";
          break;
        }
      }

      const atEdge = zones.some(([a, b]) => entry >= a - EDGE_TOL && entry <= b + EDGE_TOL);
      const absIdx = absorption.find(
        (a) =>
          Math.abs(Number(a.t.slice(0, 2)) * 60 + Number(a.t.slice(3, 5)) - (Number(bar.t.slice(0, 2)) * 60 + Number(bar.t.slice(3, 5)))) <=
            ABS_BARS && Math.abs(a.price - entry) <= ABS_PTS,
      );
      const wantKind = dir === "long" ? "DIVERGENCE_D2" : "DIVERGENCE_D4";
      const hasDiv = divs.some((d) => {
        if (d.kind !== wantKind) return false;
        const dm = Number(d.t.slice(0, 2)) * 60 + Number(d.t.slice(3, 5));
        const bm = Number(bar.t.slice(0, 2)) * 60 + Number(bar.t.slice(3, 5));
        return bm - dm >= 0 && bm - dm <= DIV_BARS;
      });

      trades.push({
        date,
        t: bar.t,
        dir,
        entry,
        stop,
        r: rPts,
        outcome,
        mfeR: mfe,
        maeR: mae,
        atEdge,
        hasAbs: !!absIdx,
        hasDiv,
        vwapSide: entry >= an.vwap ? "above" : "below",
        hourET: etHour(bar.t),
      });
    }
  }

  // ── report ─────────────────────────────────────────────────────────────
  const stat = (rows: Trade[], label: string) => {
    const closed = rows.filter((x) => x.outcome !== "open");
    const wins = closed.filter((x) => x.outcome === "win").length;
    const wr = closed.length ? (wins / closed.length) * 100 : 0;
    // expectancy in R for a 1R target / 1R risk
    const exp = closed.length ? (wins * BASE_R - (closed.length - wins)) / closed.length : 0;
    const med = (a: number[]) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
    console.log(
      `  ${label.padEnd(34)} n=${String(rows.length).padStart(4)}  closed=${String(closed.length).padStart(4)}  win=${wr.toFixed(1).padStart(5)}%  exp=${exp >= 0 ? "+" : ""}${exp.toFixed(3)}R  medMFE=${med(rows.map((x) => x.mfeR)).toFixed(2)}R  medMAE=${med(rows.map((x) => x.maeR)).toFixed(2)}R  medRisk=${med(rows.map((x) => x.r)).toFixed(2)}pt`,
    );
  };

  console.log(`\nStrategy study — ${SESSION} sessions ${DATES[0]} … ${DATES.at(-1)} (${minutesTotal.toLocaleString()} minutes)`);
  console.log(`Reclaims (the trigger), entry at the confirmation close, ${BASE_R}R target / ${BASE_R}R stop, ${LOOKAHEAD}-bar window\n`);

  stat(trades, "ALL reclaims");
  stat(trades.filter((x) => x.atEdge), "at an LVN edge (location)");
  stat(trades.filter((x) => !x.atEdge), "not at an edge");
  stat(trades.filter((x) => x.hasAbs), "with absorption (mechanism)");
  stat(trades.filter((x) => !x.hasAbs), "without absorption");
  stat(trades.filter((x) => x.hasDiv), "with matching divergence (fuel)");
  stat(trades.filter((x) => !x.hasDiv), "without divergence");
  console.log("");
  stat(trades.filter((x) => x.atEdge && x.hasAbs), "edge + absorption (2 required)");
  stat(trades.filter((x) => x.atEdge && x.hasAbs && x.hasDiv), "edge + absorption + div (all)");
  stat(trades.filter((x) => x.atEdge && !x.hasAbs && !x.hasDiv), "edge only");
  stat(trades.filter((x) => !x.atEdge && !x.hasAbs), "no location, no mechanism");

  // direction + session-hour splits
  console.log("");
  for (const d of ["long", "short"] as const) stat(trades.filter((x) => x.dir === d), `direction: ${d}`);
  const hours = [...new Set(trades.map((x) => x.hourET))].sort((a, b) => a - b);
  for (const h of hours) {
    const rows = trades.filter((x) => x.hourET === h);
    if (rows.length >= 8) stat(rows, `entry hour (NY) ${String(h).padStart(2, "0")}:00`);
  }

  // ── baseline: entries every 30th bar with the same stop geometry ────────
  const randomish: Trade[] = [];
  for (const date of DATES) {
    const fp = await extractFootprint(date, SESSION);
    if (!fp) continue;
    const m = fp.minutes;
    for (let i = 60; i < m.length - LOOKAHEAD; i += 30) {
      const entry = m[i].c > 0 ? m[i].c : (m[i].high + m[i].low) / 2;
      const dir: "long" | "short" = i % 60 === 0 ? "long" : "short";
      const stop = dir === "long" ? entry - 8 * TICK : entry + 8 * TICK;
      const rPts = Math.abs(entry - stop);
      let outcome: Trade["outcome"] = "open";
      let mfe = 0;
      let mae = 0;
      for (let k = i + 1; k < Math.min(m.length, i + 1 + LOOKAHEAD); k++) {
        const fav = (dir === "long" ? m[k].high - entry : entry - m[k].low) / rPts;
        const adv = (dir === "long" ? entry - m[k].low : m[k].high - entry) / rPts;
        mfe = Math.max(mfe, fav);
        mae = Math.max(mae, adv);
        const hitStop = dir === "long" ? m[k].low <= stop : m[k].high >= stop;
        const hitTarget = dir === "long" ? m[k].high >= entry + rPts : m[k].low <= entry - rPts;
        if (hitStop) { outcome = "loss"; break; }
        if (hitTarget) { outcome = "win"; break; }
      }
      randomish.push({ date, t: m[i].t, dir, entry, stop, r: rPts, outcome, mfeR: mfe, maeR: mae, atEdge: false, hasAbs: false, hasDiv: false, vwapSide: "above", hourET: 0 });
    }
  }
  console.log("");
  stat(randomish, "BASELINE (every 30th bar, same stop)");
  // ── what target does the signal actually support? ─────────────────────
  const sweepTarget = (rows: Trade[], mult: number, stopTicks: number) => {
    const res: Trade[] = [];
    for (const t of rows) {
      const stop = t.dir === "long" ? t.entry - stopTicks * TICK : t.entry + stopTicks * TICK;
      const rPts = Math.abs(t.entry - stop);
      let outcome: Trade["outcome"] = "open";
      const fp = fpCache.get(t.date);
      if (!fp) continue;
      const idx = fp.findIndex((x) => x.t === t.t);
      if (idx < 0) continue;
      for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
        const hitStop = t.dir === "long" ? fp[k].low <= stop : fp[k].high >= stop;
        const hitTarget = t.dir === "long" ? fp[k].high >= t.entry + mult * rPts : fp[k].low <= t.entry - mult * rPts;
        if (hitStop) { outcome = "loss"; break; }
        if (hitTarget) { outcome = "win"; break; }
      }
      res.push({ ...t, r: rPts, outcome });
    }
    const closed = res.filter((x) => x.outcome !== "open");
    const wins = closed.filter((x) => x.outcome === "win").length;
    const exp = closed.length ? (wins * mult - (closed.length - wins)) / closed.length : 0;
    const wr = closed.length ? (wins / closed.length) * 100 : 0;
    return { wr, exp, n: closed.length };
  };

  console.log("\nTarget / stop sweep  (expectancy in R, win rate)");
  for (const stopTicks of [2, 4, 8]) {
    const line: string[] = [];
    for (const mult of [1, 1.5, 2, 3]) {
      const r = sweepTarget(trades, mult, stopTicks);
      line.push(`${mult}R: ${r.exp >= 0 ? "+" : ""}${r.exp.toFixed(2)}R @ ${r.wr.toFixed(0)}%`);
    }
    console.log(`  stop ${String(stopTicks).padStart(2)} ticks (${(stopTicks * TICK).toFixed(2)} pt)   ${line.join("   ")}`);
  }

  // ── does the trade actually reach the nearest POC (the stated target)? ──
  console.log("\nPOC-as-target test: share of reclaims that touch the nearest profile POC before the stop");
  let reached = 0;
  let tested = 0;
  for (const t of trades) {
    const sheet = sheetCache.get(t.date);
    const fp = fpCache.get(t.date);
    if (!sheet || !fp) continue;
    const pocs: number[] = [];
    for (const p of Object.values(sheet.profiles)) if (p?.POC) pocs.push(parseFloat(String(p.POC).replace(/,/g, "")));
    if (!pocs.length) continue;
    const stop = t.dir === "long" ? t.entry - 2 * TICK : t.entry + 2 * TICK;
    const target = pocs.sort((a, b) => Math.abs(a - t.entry) - Math.abs(b - t.entry))[0];
    const idx = fp.findIndex((x) => x.t === t.t);
    if (idx < 0) continue;
    tested++;
    for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
      const hitStop = t.dir === "long" ? fp[k].low <= stop : fp[k].high >= stop;
      const hitPoc = t.dir === "long" ? fp[k].high >= target : fp[k].low <= target;
      if (hitStop) break;
      if (hitPoc) { reached++; break; }
    }
  }
  console.log(`  ${((reached / Math.max(1, tested)) * 100).toFixed(1)}%  (${reached}/${tested} reclaims reached the nearest POC before the stop)`);

  // ── per-session consistency (is a bucket real, or one lucky day?) ──────
  console.log("\nPer-session consistency of the two claims");
  for (const date of DATES) {
    const rows = trades.filter((x) => x.date === date);
    const edge = rows.filter((x) => x.atEdge);
    const div = rows.filter((x) => x.hasDiv);
    const rate = (r: Trade[]) => {
      const c = r.filter((x) => x.outcome !== "open");
      return c.length ? `${((c.filter((x) => x.outcome === "win").length / c.length) * 100).toFixed(0)}% (n=${c.length})` : "—";
    };
    console.log(`  ${date}   all ${rate(rows).padEnd(12)} at-edge ${rate(edge).padEnd(12)} w/divergence ${rate(div)}`);
  }

  // ── why the POC target fails: how far away is it? ──────────────────────
  const dists: number[] = [];
  const risks: number[] = [];
  for (const t of trades) {
    const sheet = sheetCache.get(t.date);
    if (!sheet) continue;
    const pocs: number[] = [];
    for (const p of Object.values(sheet.profiles)) if (p?.POC) pocs.push(parseFloat(String(p.POC).replace(/,/g, "")));
    if (!pocs.length) continue;
    const target = pocs.sort((a, b) => Math.abs(a - t.entry) - Math.abs(b - t.entry))[0];
    dists.push(Math.abs(target - t.entry));
    risks.push(t.r);
  }
  const q = (a: number[], f: number) => { const s2 = [...a].sort((x, y) => x - y); return s2.length ? s2[Math.min(s2.length - 1, Math.floor(f * s2.length))] : NaN; };
  console.log(
    `\nDistance to nearest POC vs trade risk:\n` +
      `  POC distance   med ${q(dists, 0.5).toFixed(2)} pt   p25 ${q(dists, 0.25).toFixed(2)}   p75 ${q(dists, 0.75).toFixed(2)}\n` +
      `  trade risk     med ${q(risks, 0.5).toFixed(2)} pt   p25 ${q(risks, 0.25).toFixed(2)}   p75 ${q(risks, 0.75).toFixed(2)}\n` +
      `  median reward:risk to POC = ${(q(dists, 0.5) / Math.max(0.01, q(risks, 0.5))).toFixed(2)}R`,
  );

  // ── does the evening-hours effect survive per session? ─────────────────
  console.log("\nEvening-hours claim (entries 18:00-21:00 NY) per session");
  for (const date of DATES) {
    const rows = trades.filter((x) => x.date === date);
    const eve = rows.filter((x) => x.hourET >= 18 && x.hourET < 21);
    const rest = rows.filter((x) => !(x.hourET >= 18 && x.hourET < 21));
    const rate = (r: Trade[]) => {
      const c = r.filter((x) => x.outcome !== "open");
      if (!c.length) return "—";
      const w = c.filter((x) => x.outcome === "win").length;
      return `${((w / c.length) * 100).toFixed(0)}% (n=${c.length})`;
    };
    console.log(`  ${date}   evening ${rate(eve).padEnd(12)}  rest of session ${rate(rest)}`);
  }

  // ── which target is actually reachable: POC, session VWAP, or the nearer? ──
  // The POC turned out to be ~9R away. VWAP is the other magnet the research
  // names, and it is usually much closer. Only targets in the trade's own
  // direction count: for a long, a level above the entry.
  type Cand = { name: string; price: number };
  const rows: { name: string; dist: number[]; rr: number[]; hits: number; n: number; validSkip: number }[] = [
    { name: "nearest POC (in direction)", dist: [], rr: [], hits: 0, n: 0, validSkip: 0 },
    { name: "session VWAP (in direction)", dist: [], rr: [], hits: 0, n: 0, validSkip: 0 },
    { name: "nearer of POC / VWAP", dist: [], rr: [], hits: 0, n: 0, validSkip: 0 },
  ];
  const rowOf = (name: string) => rows.find((r) => r.name === name)!;
  let vwapWrongSide = 0;
  let vwapAtEntry = 0;
  let vwapWon = 0;
  let bothPresent = 0;
  let onlyVwap = 0;

  for (const t of trades) {
    const fp = fpCache.get(t.date);
    const sheet = sheetCache.get(t.date);
    if (!fp || !sheet) continue;
    const idx = fp.findIndex((x) => x.t === t.t);
    if (idx < 0) continue;

    // cumulative session VWAP the trader can actually see at this bar (HLC3)
    let num = 0;
    let den = 0;
    for (let k = 0; k <= idx; k++) {
      const b = fp[k];
      const v = (b.buy ?? 0) + (b.sell ?? 0);
      num += ((b.high + b.low + (b.c > 0 ? b.c : (b.high + b.low) / 2)) / 3) * v;
      den += v;
    }
    const vwap = den > 0 ? num / den : 0;
    const long = t.dir === "long";
    const ahead = (px: number) => (long ? px > t.entry : px < t.entry);

    const pocs: number[] = [];
    for (const pr of Object.values(sheet.profiles)) if (pr?.POC) pocs.push(parseFloat(String(pr.POC).replace(/,/g, "")));
    const pocAhead = pocs.filter(ahead).sort((a, b) => Math.abs(a - t.entry) - Math.abs(b - t.entry))[0];

    const vwapAhead = vwap > 0 && ahead(vwap) ? vwap : null;
    if (vwap > 0 && !ahead(vwap)) vwapWrongSide++;
    if (vwap > 0 && Math.abs(vwap - t.entry) <= 0.5) vwapAtEntry++;

    const cands: Cand[] = [];
    if (pocAhead !== undefined) cands.push({ name: "nearest POC (in direction)", price: pocAhead });
    if (vwapAhead !== null) cands.push({ name: "session VWAP (in direction)", price: vwapAhead });
    if (cands.length === 2) {
      const near = Math.abs(cands[0].price - t.entry) <= Math.abs(cands[1].price - t.entry) ? cands[0] : cands[1];
      cands.push({ name: "nearer of POC / VWAP", price: near.price });
      bothPresent++;
      if (near.name.startsWith("session VWAP")) vwapWon++;
    } else if (vwapAhead !== null) onlyVwap++;

    for (const c of cands) {
      const row = rowOf(c.name);
      const dist = Math.abs(c.price - t.entry);
      const rr = dist / Math.max(0.01, t.r);
      let hit = false;
      for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
        const b = fp[k];
        const hitStop = long ? b.low <= t.stop : b.high >= t.stop;
        const hitTgt = long ? b.high >= c.price : b.low <= c.price;
        if (hitStop) break;
        if (hitTgt) {
          hit = true;
          break;
        }
      }
      row.dist.push(dist);
      row.rr.push(rr);
      row.n++;
      if (hit) row.hits++;
    }
  }

  // ── true (untruncated) excursion: break ONLY on the stop ───────────────
  // The headline medMFE above is capped by the 1R target break, so it cannot
  // say how far winners run. This walks the full window stopping only at the
  // stop, which is the honest basis for choosing a target multiple.
  const trueMfe: number[] = [];
  const trueMae: number[] = [];
  for (const t of trades) {
    const fp = fpCache.get(t.date);
    if (!fp) continue;
    const idx = fp.findIndex((x) => x.t === t.t);
    if (idx < 0) continue;
    const long = t.dir === "long";
    let mfe = 0;
    let mae = 0;
    for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
      const b = fp[k];
      // pessimistic ordering, identical to every other test here: the stop is
      // resolved BEFORE the bar's favourable excursion is credited
      if (long ? b.low <= t.stop : b.high >= t.stop) break;
      mfe = Math.max(mfe, (long ? b.high - t.entry : t.entry - b.low) / t.r);
      mae = Math.max(mae, (long ? t.entry - b.low : b.high - t.entry) / t.r);
    }
    trueMfe.push(mfe);
    trueMae.push(mae);
  }
  // ── index integrity: does findIndex(t) land on the trade's own bar? ────
  let mismatch = 0;
  let dupT = 0;
  let oneRTargetFirst = 0;
  let checked = 0;
  for (const t of trades) {
    const fp = fpCache.get(t.date);
    if (!fp) continue;
    const idx = fp.findIndex((x) => x.t === t.t);
    if (idx < 0) continue;
    const b = fp[idx];
    if (Math.abs((b.c > 0 ? b.c : (b.high + b.low) / 2) - t.entry) > 0.01) mismatch++;
    if (fp.filter((x) => x.t === t.t).length > 1) dupT++;
    checked++;
    // 1R-first using THIS index, same ordering as the reach test
    const long = t.dir === "long";
    for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
      const x = fp[k];
      if (long ? x.low <= t.stop : x.high >= t.stop) break;
      if (long ? x.high >= t.entry + t.r : x.low <= t.entry - t.r) { oneRTargetFirst++; break; }
    }
  }
  console.log(
    `\nIndex integrity: ${checked} trades resolved, ${mismatch} entry mismatches, ${dupT} duplicate timestamps` +
      `\n  1R-target-first recomputed from findIndex(t): ${((oneRTargetFirst / Math.max(1, checked)) * 100).toFixed(1)}%  (headline says 41.0%)`,
  );

  const pct = (a: number[], f: number) => q(a, f).toFixed(2);
  console.log(
    `\nTrue excursion in R, untruncated (break only on the stop) — how far price really travels\n` +
      `  MFE   p25 ${pct(trueMfe, 0.25)}   med ${pct(trueMfe, 0.5)}   p75 ${pct(trueMfe, 0.75)}   p90 ${pct(trueMfe, 0.9)}\n` +
      `  share reaching 1R ${((trueMfe.filter((x) => x >= 1).length / trueMfe.length) * 100).toFixed(0)}%` +
      `  2R ${((trueMfe.filter((x) => x >= 2).length / trueMfe.length) * 100).toFixed(0)}%` +
      `  3R ${((trueMfe.filter((x) => x >= 3).length / trueMfe.length) * 100).toFixed(0)}%` +
      `  5R ${((trueMfe.filter((x) => x >= 5).length / trueMfe.length) * 100).toFixed(0)}%` +
      `  10R ${((trueMfe.filter((x) => x >= 10).length / trueMfe.length) * 100).toFixed(0)}%`,
  );

  // ── per-trade expectancy for each candidate target (no median shortcut) ──
  console.log("\nExpectancy per trade for each target rule (stop = technical invalidation)");
  const pooled: { name: string; exp: number; n: number; wr: number }[] = [];
  for (const r of rows) {
    let sum = 0;
    let n = 0;
    let hits = 0;
    for (const t of trades) {
      const fp = fpCache.get(t.date);
      const sheet = sheetCache.get(t.date);
      if (!fp || !sheet) continue;
      const idx = fp.findIndex((x) => x.t === t.t);
      if (idx < 0) continue;
      const long = t.dir === "long";
      let num = 0;
      let den = 0;
      for (let k = 0; k <= idx; k++) {
        const b = fp[k];
        const v = (b.buy ?? 0) + (b.sell ?? 0);
        num += ((b.high + b.low + (b.c > 0 ? b.c : (b.high + b.low) / 2)) / 3) * v;
        den += v;
      }
      const vwap = den > 0 ? num / den : 0;
      const ahead = (px: number) => (long ? px > t.entry : px < t.entry);
      const pocs: number[] = [];
      for (const pr of Object.values(sheet.profiles)) if (pr?.POC) pocs.push(parseFloat(String(pr.POC).replace(/,/g, "")));
      const pocAhead = pocs.filter(ahead).sort((a, b) => Math.abs(a - t.entry) - Math.abs(b - t.entry))[0];
      const vwapAhead = vwap > 0 && ahead(vwap) ? vwap : null;
      let target: number | null = null;
      if (r.name === "nearest POC (in direction)") target = pocAhead ?? null;
      else if (r.name === "session VWAP (in direction)") target = vwapAhead;
      else if (pocAhead !== undefined && vwapAhead !== null)
        target = Math.abs(pocAhead - t.entry) <= Math.abs(vwapAhead - t.entry) ? pocAhead : vwapAhead;
      else target = pocAhead ?? vwapAhead ?? null;
      if (target === null) continue;
      const rr = Math.abs(target - t.entry) / Math.max(0.01, t.r);
      let hit = false;
      for (let k = idx + 1; k < Math.min(fp.length, idx + 1 + LOOKAHEAD); k++) {
        const b = fp[k];
        if (long ? b.low <= t.stop : b.high >= t.stop) break;
        if (long ? b.high >= target : b.low <= target) { hit = true; break; }
      }
      n++;
      if (hit) hits++;
      sum += hit ? rr : -1;
    }
    if (n) pooled.push({ name: r.name, exp: sum / n, n, wr: (hits / n) * 100 });
  }
  for (const p2 of pooled) console.log(`  ${p2.name.padEnd(30)} ${p2.exp >= 0 ? "+" : ""}${p2.exp.toFixed(2)}R   hit ${p2.wr.toFixed(1)}%   n=${p2.n}`);

  console.log("\nTarget reachability — target touched before the stop, and what it is worth");
  console.log("  target                          n    medDist  medR:R   reached   expectancy if taken");
  for (const r of rows) {
    const reach = r.n ? (r.hits / r.n) * 100 : 0;
    const med = q(r.rr, 0.5);
    const exp = (reach / 100) * med - (1 - reach / 100);
    const med2 = r.dist.length ? q(r.dist, 0.5).toFixed(2) : "—";
    console.log(
      `  ${r.name.padEnd(30)} ${String(r.n).padStart(3)}   ${String(med2).padStart(6)}   ${med.toFixed(2).padStart(5)}   ` +
        `${reach.toFixed(1).padStart(5)}%   ${exp >= 0 ? "+" : ""}${exp.toFixed(2)}R`,
    );
  }
  console.log(
    `\n  VWAP wins the "nearer" contest in ${vwapWon}/${bothPresent} trades where both levels exist (${((vwapWon / Math.max(1, bothPresent)) * 100).toFixed(0)}%)` +
      `\n  trades with no in-direction POC where VWAP is the only candidate: ${onlyVwap}` +
      `\n  VWAP behind the entry (not a target in the trade's direction): ${vwapWrongSide}/${trades.length} trades` +
      `\n  entry within 0.5 pt of VWAP (target already achieved): ${vwapAtEntry}/${trades.length}`,
  );

  console.log(
    `\nCaveats: perfect fills at bar close, no fees/slippage, overlapping trades, ${DATES.length} sessions only.` +
      `\nEvery threshold in the system is still a hypothesis until the journal has 100+ tagged samples.`,
  );
}

await main();
