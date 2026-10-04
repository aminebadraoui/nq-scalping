/* ------------------------------------------------------------------ *
 * SIZING OPTIMIZER — the full campaign: grid-search STOP × TARGET ×
 * TIME-EXIT × SIZE on the training window (everything before --split),
 * select under constraints (eval PASS, bounded drawdown, plateau
 * discipline), then verify OUT-OF-SAMPLE on the test window and layer
 * the regime-conditional rules on top. No vetoes anywhere — every
 * variant trades the same signals, only the parameters change.
 *
 * Features per session (lookahead-free, from prior sessions only):
 * realized-vol tercile · prior-day VIX close tercile · daily/weekly
 * swing structure (lib/htfStructure) · COT spec positioning (publish-
 * joined) · 2s10s sign + 10y 3m change (daily Treasury CSVs).
 *
 * Run from web/ (env: GC_REMOTE_URL):
 *   node --import tests/ts-loader.mjs ./scripts/sizingOptimizer.ts \
 *        [--split 2026-01-01] [--dump out.json] [--max N]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import path from "node:path";
import { dollarize, simulateAccount, accountLine } from "../lib/propAccount";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { detectMomentum, detectExpansionScalp, closeOf, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { htfStructure } from "../lib/htfStructure";
import { parseTreasuryCsv, spread210, spread103m } from "../lib/bonds";

const CONCURRENCY = 8;
const COST_PTS = 0.5;
const RTH_OPEN = "08:30";
const RTH_CLOSE = "15:00";

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { split: string; dump?: string; max?: number } = { split: "2026-01-01" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--max") o.max = Number(argv[++i]);
  }
  return o;
}

/* ---------------- loaders (same as volSizingStudy) --------------- */

async function loadVix(): Promise<Map<string, number> | null> {
  const url = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv";
  const cacheFile = path.join(process.cwd(), "..", "gcdata", "data", "vix_history.csv");
  let text = "";
  try {
    text = await fs.readFile(cacheFile, "utf8");
  } catch {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, text);
    } catch {
      return null;
    }
  }
  const map = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split(",");
    if (!/^\d{2}\/\d{2}\/\d{4}$/.test(cells[0] ?? "")) continue;
    const [m, d, y] = cells[0].split("/").map(Number);
    const v = Number(cells[4]);
    if (!Number.isFinite(v)) continue;
    map.set(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, v);
  }
  return map.size > 0 ? map : null;
}

type CotRow = { pub: string; net: number; oi: number };

async function loadCot(): Promise<CotRow[] | null> {
  const url =
    "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$order=report_date_as_yyyy_mm_dd%20DESC&$limit=250&$where=" +
    encodeURIComponent('market_and_exchange_names like "%NASDAQ-100 Consolidated%"');
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = JSON.parse(await res.text()) as { report_date_as_yyyy_mm_dd?: string; noncomm_positions_long_all?: string; noncomm_positions_short_all?: string; open_interest_all?: string }[];
    const out: CotRow[] = [];
    for (const r of rows) {
      const d = String(r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
      const l = Number(r.noncomm_positions_long_all);
      const sh = Number(r.noncomm_positions_short_all);
      const oi = Number(r.open_interest_all);
      if (!Number.isFinite(l) || !Number.isFinite(sh) || !Number.isFinite(oi) || oi <= 0) continue;
      const [y, m, dd] = d.split("-").map(Number);
      out.push({ pub: new Date(Date.UTC(y, m - 1, dd + 3)).toISOString().slice(0, 10), net: l - sh, oi });
    }
    return out.sort((a, b) => (a.pub < b.pub ? -1 : 1));
  } catch {
    return null;
  }
}

type TsyRow = { day: string; s210: number | null };

async function loadTreasury(): Promise<TsyRow[] | null> {
  try {
    const texts = await Promise.all(
      [2023, 2024, 2025, 2026].map((y) =>
        fetch(
          `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) },
        ).then(async (r) => (r.ok ? await r.text() : "")),
      ),
    );
    const rows: TsyRow[] = [];
    for (const t of texts) for (const c of parseTreasuryCsv(t)) rows.push({ day: c.date, s210: spread210(c) });
    rows.sort((a, b) => (a.day < b.day ? -1 : 1));
    return rows.length > 200 ? rows : null;
  } catch {
    return null;
  }
}

/* ---------------- scoring (parameterized) ------------------------- */

type Trade = {
  date: string;
  dir: "long" | "short";
  entry: number;
  risk: number;
  pnl: number;
  volT: "LOW" | "MID" | "HIGH" | null;
  vixT: "LOW" | "MID" | "HIGH" | null;
  agreeD: boolean | null;
  cotPct52: number | null;
  cotWow: number | null;
  s210Pos: boolean | null;
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, stopMult: number, targetMult: number, timeExit: number): Trade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk * targetMult;
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + timeExit);
  if (start > end) return null;
  let hit: "target" | "stop" | "time" = "time";
  let exit = closeOf(minutes[end]);
  for (let j = start; j <= end; j++) {
    const b = minutes[j];
    const stopHit = dir > 0 ? b.low <= stop : b.high >= stop;
    const tgtHit = dir > 0 ? b.high >= target : b.low <= target;
    if (stopHit) {
      hit = "stop";
      exit = stop;
      break;
    }
    if (tgtHit) {
      hit = "target";
      exit = target;
      break;
    }
  }
  void hit;
  return {
    date,
    dir: sig.dir,
    entry,
    risk,
    pnl: (exit - entry) * dir - COST_PTS,
    volT: null,
    vixT: null,
    agreeD: null,
    cotPct52: null,
    cotWow: null,
    s210Pos: null,
  };
}

function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number, targetMult: number, timeExit: number): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const sig of signals) {
    if (sig.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, sig, date, stopMult, targetMult, timeExit);
    if (!sc) continue;
    out.push(sc);
    openUntil = sig.entryIdx + timeExit;
  }
  return out;
}

/* ---------------- stats ---------------- */

function stats(trades: { pnl: number; risk: number }[]) {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return { n, wr: n ? (wins.length / n) * 100 : 0, pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0, netPts: trades.reduce((a, t) => a + t.pnl, 0), expR: n ? trades.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0 };
}

function sim(trades: Trade[], sizeMult: number) {
  const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl * sizeMult, riskPts: t.risk })));
  const acc = simulateAccount(d, "eval");
  let peak = 0;
  let maxDD = 0;
  for (const day of acc.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  const net = d.reduce((a, t) => a + t.pnl, 0);
  return { net, maxDD, passed: acc.breachDay === null, line: accountLine(acc), days: acc.days.length };
}

/* ---------------- main ---------------- */

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let dates = await archiveDates();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  const vixMap = await loadVix();
  const cot = await loadCot();
  const tsy = await loadTreasury();
  const vixCloses = vixMap ? [...vixMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v) : [];
  console.log(`sessions ${dates.length} · split ${o.split} · vix=${vixMap?.size ?? 0} · cot=${cot?.length ?? 0} · tsy=${tsy?.length ?? 0}`);

  const STOPS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
  const TARGETS = [1.25, 1.5, 1.75, 2.0, 2.25, 2.5, 3.0];
  const TIMES = [45, 60, 75, 90];
  const SIZES = [2.0, 2.5, 3.0, 3.5, 4.0];

  const combos = [...STOPS.flatMap((s) => TARGETS.flatMap((t) => TIMES.map((x) => ({ s, t, x })))), { s: 1.0, t: 1.0, x: 60 }]; // base reference stays in the grid
  const perCombo: Trade[][] = combos.map(() => []);

  const dailyBars: { day: string; high: number; low: number }[] = [];
  const realVols: number[] = [];
  const volTercileOf = () => {
    if (realVols.length < 5) return null as "LOW" | "MID" | "HIGH" | null;
    const last = realVols[realVols.length - 1];
    const pct = realVols.filter((x) => x <= last).length / realVols.length;
    return pct < 0.33 ? "LOW" : pct < 0.66 ? "MID" : "HIGH";
  };
  const vixTercileOf = (date: string) => {
    if (!vixMap) return null as "LOW" | "MID" | "HIGH" | null;
    const prior = [...vixMap.keys()].filter((d) => d < date).sort();
    const v = prior.length ? vixMap.get(prior[prior.length - 1])! : null;
    if (v == null) return null;
    const pct = vixCloses.filter((x) => x <= v).length / vixCloses.length;
    return pct < 0.33 ? "LOW" : pct < 0.66 ? "MID" : "HIGH";
  };
  const cotFeatures = (date: string) => {
    if (!cot) return { pct52: null as number | null, wow: null as number | null };
    const eligible = cot.filter((r) => r.pub < date);
    const last = eligible[eligible.length - 1];
    if (!last) return { pct52: null, wow: null };
    const w52 = eligible.slice(-52);
    return {
      pct52: w52.length >= 10 ? Math.round((w52.filter((r) => r.net <= last.net).length / w52.length) * 100) : null,
      wow: eligible[eligible.length - 2] ? last.net - eligible[eligible.length - 2].net : null,
    };
  };
  const s210Of = (date: string) => {
    if (!tsy) return null as boolean | null;
    const prior = tsy.filter((r) => r.day < date);
    const last = prior[prior.length - 1];
    return last && last.s210 != null ? last.s210 > 0 : null;
  };

  const t0 = Date.now();
  let i = 0;
  let loaded = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      loaded++;
      const rth = minutes.filter((m) => m.t >= RTH_OPEN && m.t <= RTH_CLOSE);
      const feats = {
        volT: volTercileOf(),
        vixT: vixTercileOf(date),
        agreeD: null as boolean | null,
        cotPct52: cotFeatures(date).pct52,
        cotWow: cotFeatures(date).wow,
        s210Pos: s210Of(date),
      };
      if (dailyBars.length >= 30) {
        const st = htfStructure(dailyBars.map((b) => ({ t: `${b.day}T12:00:00`, high: b.high, low: b.low })));
        feats.agreeD = st.daily === "HH/HL" ? true : st.daily === "LH/LL" ? false : null;
      }
      const raw = [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)];
      for (let c = 0; c < combos.length; c++) {
        const { s, t, x } = combos[c];
        const trades = scoreSequential(minutes, raw, date, s, t, x);
        for (const tr of trades) {
          tr.volT = feats.volT;
          tr.vixT = feats.vixT;
          tr.agreeD = feats.agreeD;
          tr.cotPct52 = feats.cotPct52;
          tr.cotWow = feats.cotWow;
          tr.s210Pos = feats.s210Pos;
        }
        perCombo[c].push(...trades);
      }
      if (rth.length > 50) {
        dailyBars.push({ day: date, high: Math.max(...rth.map((m) => m.high)), low: Math.min(...rth.map((m) => m.low)) });
        const mids = rth.map((m) => (m.high + m.low) / 2);
        const rets: number[] = [];
        for (let k = 1; k < mids.length; k++) rets.push(Math.log(mids[k] / mids[k - 1]));
        const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
        const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
        realVols.push(Math.sqrt(variance) * Math.sqrt(390) * 100);
      }
    }
    i += CONCURRENCY;
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} sessions scored`);

  const baseIdx = combos.findIndex((c) => c.s === 1.0 && c.t === 1.0 && c.x === 60);
  const trainAll = perCombo[baseIdx].filter((t) => t.date < o.split);
  const testAll = perCombo[baseIdx].filter((t) => t.date >= o.split);
  const baseTrain = sim(trainAll, 1.0);
  const baseTest = sim(testAll, 1.0);
  console.log(`\nbase s1.0/t1.0/x60: train ${baseTrain.line} · test ${baseTest.line}`);
  console.log(`base nets: train $${baseTrain.net.toFixed(0)} (dd ${baseTrain.maxDD}) · test $${baseTest.net.toFixed(0)} (dd ${baseTest.maxDD})`);

  /* ---- grid evaluation on TRAIN ---- */
  type Row = { s: number; t: number; x: number; sz: number; pf: number; net: number; dd: number; pass: boolean; score: number };
  const rows: Row[] = [];
  for (let c = 0; c < combos.length; c++) {
    const train = perCombo[c].filter((tr) => tr.date < o.split);
    const st = stats(train);
    for (const sz of SIZES) {
      const sm = sim(train, sz);
      const ok = sm.passed && st.pf >= 2.86 * 0.9 && sm.maxDD >= -1.25 * Math.abs(baseTrain.maxDD) - 250;
      rows.push({ s: combos[c].s, t: combos[c].t, x: combos[c].x, sz, pf: st.pf, net: sm.net, dd: sm.maxDD, pass: ok, score: ok ? sm.net : -Infinity });
    }
  }
  rows.sort((a, b) => b.score - a.score);
  console.log("\n=== TOP 12 CONFIGS ON TRAIN (eval net, constrained: PF≥2.57, dd ≤ 1.25×base) ===");
  for (const r of rows.slice(0, 12)) {
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | pf ${r.pf.toFixed(2)} | net $${r.net.toFixed(0).padStart(7)} | dd $${r.dd.toFixed(0).padStart(6)} | ${r.pass ? "✓" : "✗"}`);
  }

  /* ---- top-5 picks → out-of-sample ---- */
  console.log("\n=== TOP-5 OUT-OF-SAMPLE (test window) ===");
  for (const r of rows.slice(0, 5)) {
    const c = combos.findIndex((x) => x.s === r.s && x.t === r.t && x.x === r.x);
    const test = perCombo[c].filter((tr) => tr.date >= o.split);
    const st = stats(test);
    const sm = sim(test, r.sz);
    console.log(`s${r.s} t${r.t} x${r.x} sz${r.sz} | test n=${st.n} pf=${st.pf.toFixed(2)} net=$${sm.net.toFixed(0)} dd=$${sm.maxDD.toFixed(0)} ${sm.line}`);
  }

  /* ---- conditional layers on the best pick ---- */
  const best = rows[0];
  const bestIdx = combos.findIndex((x) => x.s === best.s && x.t === best.t && x.x === best.x);
  const conds: { name: string; sizeFor: (tr: Trade) => number; stopFor: (tr: Trade) => number }[] = [
    { name: "uniform best", sizeFor: () => 1, stopFor: () => 1 },
    { name: "×0.75 when 2s10s inverted", sizeFor: (tr) => (tr.s210Pos === false ? 0.75 : 1), stopFor: () => 1 },
    { name: "×1.25 when 2s10s positive", sizeFor: (tr) => (tr.s210Pos === true ? 1.25 : 1), stopFor: () => 1 },
    { name: "×0.75 when COT crowded", sizeFor: (tr) => (tr.cotPct52 != null && tr.cotPct52 >= 90 ? 0.75 : 1), stopFor: () => 1 },
    { name: "×0.75 high vol + ×1.25 low vol", sizeFor: (tr) => (tr.volT === "HIGH" ? 0.75 : tr.volT === "LOW" ? 1.25 : 1), stopFor: () => 1 },
    { name: "2s10s size + COT crowded cut", sizeFor: (tr) => (tr.s210Pos === false ? 0.75 : 1) * (tr.cotPct52 != null && tr.cotPct52 >= 90 ? 0.75 : 1), stopFor: () => 1 },
  ];
  console.log("\n=== CONDITIONAL LAYERS ON THE BEST PICK (train / test) ===");
  for (const cd of conds) {
    const mk = (tr: Trade) => ({ ...tr, pnl: tr.pnl * cd.sizeFor(tr) * best.sz });
    const trn = perCombo[bestIdx].filter((t) => t.date < o.split).map(mk);
    const tst = perCombo[bestIdx].filter((t) => t.date >= o.split).map(mk);
    const a = sim(trn, 1);
    const b = sim(tst, 1);
    console.log(`${cd.name.padEnd(30)} | train $${a.net.toFixed(0).padStart(7)} dd $${a.maxDD.toFixed(0).padStart(6)} ${a.line} | test $${b.net.toFixed(0).padStart(7)} dd $${b.maxDD.toFixed(0).padStart(6)} ${b.line}`);
  }

  if (o.dump) {
    await fs.writeFile(o.dump, JSON.stringify(rows.slice(0, 60), null, 1));
    console.log(`\ndumped top 60 → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
