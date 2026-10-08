/* ------------------------------------------------------------------ *
 * RTH limit-entry redesign — train/OOS validation (research input).
 *
 * Disciplines the drift-aware optimizer's surviving candidates with the
 * rthOptimizer protocol: train window (< split) constrained selection
 * (eval PASS + PF ≥ 1.2 + dd bound), out-of-sample check (≥ split),
 * year stability, cost ladder, and the live 3-cards/day cap variant.
 *
 * Universe: detectSoftMomentum (RTH family), resting-limit entries at
 * the signal price (fill-or-expire, TTL 5 bars), brackets at the
 * signal's absolute levels, drift-free fills (limits fill at/better),
 * $1.90/RT fees, $100-budget sizing, eval account sim.
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --import ../scripts/ts-loader.mjs ./scripts/rthLimitValidation.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { stopCrossedAtDispatch } from "../lib/crossTrade";

const CONCURRENCY = 8;
const HORIZON = 60;
const TTL = 5;
const RISK_BUDGET = 100;
const SPLIT = "2026-01-01";
/** crossed-stop dispatch gate (2026-10-08 naked-position incident): the
 *  live fix skips a limit card whose OSO stop sits on the marketable side
 *  of the tape at dispatch — Tradovate rejects that stop (InvalidPrice)
 *  and the entry then fills naked. Dispatch tape proxy = the next-bar
 *  mid (the study's own drift measurement bar). */
const XGATE = true;

const STOPS = [0.5, 0.75, 1.0];
const TARGETS = [1.5, 2.0, 2.5, 3.0];
const CAPS = ["all", "3/day"];

type Config = { s: number; t: number; cap: string };
type Trade = { date: string; pnl: number; risk: number };

const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

function scoreConfig(minutes: MomMinute[], sigs: MomentumSignal[], date: string, c: Config): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  let cardCount = 0;
  const ordered = [...sigs].sort((a, b) => a.entryIdx - b.entryIdx);
  for (const s of ordered) {
    if (c.cap === "3/day" && cardCount >= 3) continue;
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const risk = s.risk * c.s;
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * c.t;
    if (!(dir > 0 ? stop < s.entry && s.entry < target : target < s.entry && s.entry < stop)) continue;

    // crossed-stop dispatch gate (the live fix): the card is sent and
    // skipped when the dispatch tape sits beyond the OSO stop — consumes
    // the day cap exactly like the live path (recorded as a skip).
    const nb = minutes[s.entryIdx + 1];
    if (XGATE && nb && stopCrossedAtDispatch(s.dir, stop, midOf(nb)) === true) {
      cardCount++;
      continue;
    }

    // resting limit at the signal entry — fill-or-expire within TTL bars
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + TTL);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      const touched = dir > 0 ? b.low <= s.entry : b.high >= s.entry;
      if (!touched) continue;
      fillBar = j;
      const open = openOf(b);
      fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
      break;
    }
    cardCount++; // the card is consumed whether or not the limit fills
    if (fillBar < 0) continue;

    const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
    let exit = closeOf(minutes[end]);
    for (let j = fillBar + 1; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) {
        exit = stop;
        break;
      }
      if (dir > 0 ? b.high >= target : b.low <= target) {
        exit = target;
        break;
      }
    }
    out.push({ date, pnl: (exit - fill) * dir, risk });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

function usdSim(trades: Trade[], feeRt: number) {
  const rows = trades.map((t) => {
    const contracts = Math.max(1, Math.min(30, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnl, riskPts: t.risk, pnlUsd: t.pnl * contracts * 2 - contracts * feeRt };
  });
  const d = dollarize(rows.map((r) => ({ date: r.date, pnlPts: r.pnlPts, riskPts: r.riskPts })));
  const acc = simulateAccount(d, "eval");
  const netUsd = rows.reduce((a, r) => a + r.pnlUsd, 0);
  let peak = 0;
  let maxDD = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  return { netUsd, maxDD, passed: acc.breachDay === null, line: accountLine(acc) };
}

function stats(ts: Trade[]) {
  const wins = ts.filter((t) => t.pnl > 0);
  const losses = ts.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    n: ts.length,
    wr: ts.length ? (wins.length / ts.length) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    net: ts.reduce((a, t) => a + t.pnl, 0),
  };
}

async function main() {
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const combos: Config[] = [];
  for (const s of STOPS) for (const t of TARGETS) for (const cap of CAPS) combos.push({ s, t, cap });
  const perCombo: Trade[][] = combos.map(() => []);
  console.log(`replaying ${dates.length} sessions × ${combos.length} configs…`);

  let i = 0;
  const t0 = Date.now();
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      const sigs = detectSoftMomentum(minutes, SOFT_PROD);
      for (let c = 0; c < combos.length; c++) perCombo[c].push(...scoreConfig(minutes, sigs, date, combos[c]));
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  type Row = { c: Config; train: ReturnType<typeof usdSim>; trainSt: ReturnType<typeof stats>; oos: ReturnType<typeof usdSim>; oosSt: ReturnType<typeof stats> };
  const rows: Row[] = [];
  for (let c = 0; c < combos.length; c++) {
    const train = perCombo[c].filter((t) => t.date < SPLIT);
    const oos = perCombo[c].filter((t) => t.date >= SPLIT);
    if (!train.length || !oos.length) continue;
    rows.push({ c: combos[c], train: usdSim(train, 1.9), trainSt: stats(train), oos: usdSim(oos, 1.9), oosSt: stats(oos) });
  }

  const qualified = rows.filter(
    (r) => r.train.passed && r.trainSt.pf >= 1.2 && r.train.maxDD >= -1900,
  );
  qualified.sort((a, b) => b.train.netUsd - a.train.netUsd);
  console.log("=== TRAIN-QUALIFIED CONFIGS (train < 2026-01-01: PASS + PF≥1.2 + dd≥−1900) ===");
  for (const r of qualified) {
    console.log(
      `s${r.c.s.toFixed(2)} t${r.c.t.toFixed(2)} ${r.c.cap.padEnd(5)} | train n=${String(r.trainSt.n).padStart(5)} wr=${r.trainSt.wr.toFixed(1).padStart(5)}% pf=${r.trainSt.pf.toFixed(2).padStart(5)} $${r.train.netUsd.toFixed(0).padStart(8)} dd $${r.train.maxDD.toFixed(0).padStart(6)} · ` +
        `OOS n=${String(r.oosSt.n).padStart(4)} wr=${r.oosSt.wr.toFixed(1).padStart(5)}% pf=${r.oosSt.pf.toFixed(2).padStart(5)} $${r.oos.netUsd.toFixed(0).padStart(7)} dd $${r.oos.maxDD.toFixed(0).padStart(6)} ${r.oos.passed ? "PASS" : "BREACH"}`,
    );
  }
  console.log(`qualified: ${qualified.length} / ${rows.length}\n`);

  console.log("=== YEAR STABILITY (top-4 qualified by train net) ===");
  for (const r of qualified.slice(0, 4)) {
    const byYear = ["2024", "2025", "2026"].map((y) => {
      const yy = perCombo[combos.indexOf(r.c)].filter((t) => t.date.startsWith(y));
      if (!yy.length) return `${y}: —`;
      const st = stats(yy);
      const sm = usdSim(yy, 1.9);
      return `${y}: n=${st.n} wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} $${sm.netUsd.toFixed(0)} ${sm.passed ? "PASS" : "BREACH"}`;
    });
    console.log(`s${r.c.s} t${r.c.t} ${r.c.cap} | ${byYear.join(" · ")}`);
  }

  console.log("\n=== COST LADDER (top-4 qualified, fee sensitivity) ===");
  for (const fee of [1.4, 1.9, 2.4]) {
    console.log(`--- $${fee.toFixed(1)}/RT ---`);
    for (const r of qualified.slice(0, 4)) {
      const ts = perCombo[combos.indexOf(r.c)];
      const all = usdSim(ts, fee);
      console.log(
        `s${r.c.s} t${r.c.t} ${r.c.cap.padEnd(5)} | $${all.netUsd.toFixed(0).padStart(8)} dd $${all.maxDD.toFixed(0).padStart(6)} ${all.passed ? "PASS" : "BREACH"}`,
      );
    }
  }

  console.log("\n=== TTL SENSITIVITY (top qualified config) ===");
  if (qualified.length) {
    const best = qualified[0];
    for (const ttl of [3, 5, 10]) {
      const ts: Trade[] = [];
      const c = { ...best.c };
      for (const date of dates) {
        const minutes = await loadSessionMinutes(date, { withOhlc: true });
        if (!minutes) continue;
        const sigs = detectSoftMomentum(minutes, SOFT_PROD);
        const prev = scoreConfig;
        ts.push(...scoreConfigTtl(minutes, sigs, date, c, ttl));
        void prev;
      }
      const st = stats(ts);
      const sm = usdSim(ts, 1.9);
      console.log(`TTL ${ttl} | n=${st.n} wr=${st.wr.toFixed(1)}% pf=${st.pf.toFixed(2)} | $${sm.netUsd.toFixed(0)} dd $${sm.maxDD.toFixed(0)} ${sm.passed ? "PASS" : "BREACH"}`);
    }
  }
}

/** same as scoreConfig with an explicit TTL */
function scoreConfigTtl(minutes: MomMinute[], sigs: MomentumSignal[], date: string, c: Config, ttlBars: number): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  let cardCount = 0;
  for (const s of [...sigs].sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (c.cap === "3/day" && cardCount >= 3) continue;
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const risk = s.risk * c.s;
    const stop = s.entry - dir * risk;
    const target = s.entry + dir * risk * c.t;
    if (!(dir > 0 ? stop < s.entry && s.entry < target : target < s.entry && s.entry < stop)) continue;
    // crossed-stop dispatch gate (mirrors scoreConfig)
    const nb2 = minutes[s.entryIdx + 1];
    if (XGATE && nb2 && stopCrossedAtDispatch(s.dir, stop, midOf(nb2)) === true) {
      cardCount++;
      continue;
    }
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + ttlBars);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      const touched = dir > 0 ? b.low <= s.entry : b.high >= s.entry;
      if (!touched) continue;
      fillBar = j;
      const open = openOf(b);
      fill = dir > 0 ? Math.min(open, s.entry) : Math.max(open, s.entry);
      break;
    }
    cardCount++;
    if (fillBar < 0) continue;
    const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
    let exit = closeOf(minutes[end]);
    for (let j = fillBar + 1; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) {
        exit = stop;
        break;
      }
      if (dir > 0 ? b.high >= target : b.low <= target) {
        exit = target;
        break;
      }
    }
    out.push({ date, pnl: (exit - fill) * dir, risk });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
