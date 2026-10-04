/* ------------------------------------------------------------------ *
 * Vol/structure SIZING study — never gate a trade; instead sweep how
 * STOP SIZE and CONTRACT SIZE respond to the macro regime.
 *
 * Replays the prod momentum detectors (flush + expansion) over the R2
 * archive, tags every session with LOOKAHEAD-FREE regime features:
 *   - volTercile  — realized vol of the PRIOR session (stdev of 1-min
 *                   mid log-returns over RTH × √390), percentile-ranked
 *                   over the trailing 30 sessions → LOW/MID/HIGH
 *   - vixTercile  — prior-day VIX close (CBOE VIX_History.csv joined
 *                   strictly before the session) → LOW/MID/HIGH
 *   - agreeD/W    — signal side vs daily/weekly swing structure
 *                   (lib/htfStructure) computed from prior sessions only
 *
 * The regime is a SESSION-level constant, so every stop/size variant is
 * scored once per session and minutes are dropped immediately (this is
 * also what keeps the 649-session run inside memory).
 *
 * Variants (no veto anywhere):
 *   A · uniform grid: stopMult {0.75,1.0,1.25,1.5} × sizeMult {0.5…2.0}
 *   B · realized-vol conditional stop + size by vol tercile
 *   C · structure-conditional size (daily, then daily+weekly)
 *   D · VIX-conditional stop + size by VIX tercile
 *
 * Contract math: dollarize() derives contracts from riskPts at a fixed
 * $170 budget; scaling pnlPts by sizeMult is exactly a sizeMult fill of
 * the same trade (the htfRegimeStudy convention).
 *
 * Run from web/ (env: GC_REMOTE_URL for the archive):
 *   node --import tests/ts-loader.mjs ./scripts/volSizingStudy.ts \
 *        [--max N] [--split 2026-01-01] [--dump out.json]
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
const HOLD_BARS = 60;
const RTH_OPEN = "08:30"; // feed clock (US Central) = 09:30 NY
const RTH_CLOSE = "15:00";

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split: string; dump?: string } = { split: "2026-01-01" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
  }
  return o;
}

/* ---------------- VIX history (PIT join) -------------------------- */

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
      console.log("vix history cached");
    } catch (e) {
      console.log(`vix history unavailable (${String(e)}) — VIX variants will be skipped`);
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

/* ---------------- COT (CFTC Socrata, weekly, publish-join) ------- */

type CotRow = {
  date: string; // report_date (Tuesday snapshot)
  pub: string; // approximated publish = report_date + 3d (Fri 15:30 rule)
  net: number; // noncomm long − short
  oi: number;
};

async function loadCot(): Promise<CotRow[] | null> {
  const url =
    "https://publicreporting.cftc.gov/resource/6dca-aqww.json?$order=report_date_as_yyyy_mm_dd%20DESC&$limit=250&$where=" +
    encodeURIComponent('market_and_exchange_names like "%NASDAQ-100 Consolidated%"');
  let text = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    console.log(`COT unavailable (${String(e)}) — COT variants will be skipped`);
    return null;
  }
  const rows = JSON.parse(text) as { report_date_as_yyyy_mm_dd?: string; noncomm_positions_long_all?: string; noncomm_positions_short_all?: string; open_interest_all?: string }[];
  const out: CotRow[] = [];
  for (const r of rows) {
    const d = String(r.report_date_as_yyyy_mm_dd ?? "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    const l = Number(r.noncomm_positions_long_all);
    const sh = Number(r.noncomm_positions_short_all);
    const oi = Number(r.open_interest_all);
    if (!Number.isFinite(l) || !Number.isFinite(sh) || !Number.isFinite(oi) || oi <= 0) continue;
    const [y, m, dd] = d.split("-").map(Number);
    const pub = new Date(Date.UTC(y, m - 1, dd + 3)).toISOString().slice(0, 10);
    out.push({ date: d, pub, net: l - sh, oi });
  }
  return out.sort((a, b) => (a.pub < b.pub ? -1 : 1));
}

/* ---------------- Treasury curve (daily CSVs 2023+) ------------- */

async function loadTreasury(): Promise<{ day: string; s210: number | null; s103m: number | null; y10: number | null }[] | null> {
  try {
    const years = [2023, 2024, 2025, 2026];
    const texts = await Promise.all(
      years.map((y) =>
        fetch(
          `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/${y}/all?type=daily_treasury_yield_curve&field_tdr_date_value=${y}&page&_format=csv`,
          { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(25_000) },
        ).then(async (r) => (r.ok ? await r.text() : "")),
      ),
    );
    const rows: { day: string; s210: number | null; s103m: number | null; y10: number | null }[] = [];
    for (const t of texts) {
      for (const c of parseTreasuryCsv(t)) {
        rows.push({ day: c.date, s210: spread210(c), s103m: spread103m(c), y10: c.y10 });
      }
    }
    rows.sort((a, b) => (a.day < b.day ? -1 : 1));
    if (rows.length < 200) throw new Error("treasury rows too few");
    return rows;
  } catch (e) {
    console.log(`treasury curve unavailable (${String(e)}) — rates variants skipped`);
    return null;
  }
}

/* ---------------- scoring ----------------------------------------- */

type ScoredTrade = {
  date: string;
  dir: "long" | "short";
  entry: number;
  risk: number;
  pnl: number;
  hit: "target" | "stop" | "time";
  volT: "LOW" | "MID" | "HIGH" | null;
  vixT: "LOW" | "MID" | "HIGH" | null;
  agreeD: boolean | null;
  agreeW: boolean | null;
  cotNetPct: number | null;
  cotPct52: number | null;
  cotWow: number | null;
  s210: number | null;
  s210Inverted: boolean | null;
  y10Chg3m: number | null;
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string, stopMult: number): ScoredTrade | null {
  const dir = sig.dir === "long" ? 1 : -1;
  const risk = sig.risk * stopMult;
  const entry = sig.entry;
  const stop = entry - dir * risk;
  const target = entry + dir * risk; // 1R of the (possibly new) stop
  if (!(risk > 0) || (dir > 0 && !(stop < entry && entry < target)) || (dir < 0 && !(target < entry && entry < stop))) return null;
  const start = sig.entryIdx + 1;
  const end = Math.min(minutes.length - 1, sig.entryIdx + HOLD_BARS);
  if (start > end) return null;
  let hit: ScoredTrade["hit"] = "time";
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
  return {
    date,
    dir: sig.dir,
    entry,
    risk,
    pnl: (exit - entry) * dir - COST_PTS,
    hit,
    volT: null,
    vixT: null,
    agreeD: null,
    agreeW: null,
    cotNetPct: null,
    cotPct52: null,
    cotWow: null,
    s210: null,
    s210Inverted: null,
    y10Chg3m: null,
  };
}

function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string, stopMult: number): ScoredTrade[] {
  const out: ScoredTrade[] = [];
  let openUntil = -1;
  for (const sig of signals) {
    if (sig.entryIdx <= openUntil) continue;
    const sc = scoreSignal(minutes, sig, date, stopMult);
    if (!sc) continue;
    out.push(sc);
    openUntil = sig.entryIdx + HOLD_BARS;
  }
  return out;
}

/* ---------------- stats ---------------- */

type Stats = { n: number; wr: number; pf: number; expR: number; netPts: number };

function stats(trades: { pnl: number; risk: number }[]): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  return {
    n,
    wr: n ? (wins.length / n) * 100 : 0,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    expR: n ? trades.reduce((a, t) => a + t.pnl / t.risk, 0) / n : 0,
    netPts: trades.reduce((a, t) => a + t.pnl, 0),
  };
}

function fmt(s: Stats): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return `n=${String(s.n).padStart(5)} wr=${s.wr.toFixed(1).padStart(5)}% pf=${pf.padStart(5)} expR=${s.expR.toFixed(2).padStart(5)} net=${s.netPts.toFixed(0).padStart(7)}pts`;
}

function acct(trades: { date: string; pnl: number; risk: number }[], split: string): string {
  const d = dollarize(trades.map((t) => ({ date: t.date, pnlPts: t.pnl, riskPts: t.risk })));
  const evalAll = simulateAccount(d, "eval");
  const fundedTest = simulateAccount(d.filter((t) => t.date >= split), "funded");
  let peak = 0;
  let maxDD = 0;
  for (const day of evalAll.days) {
    peak = Math.max(peak, day.equity);
    maxDD = Math.min(maxDD, day.equity - peak);
  }
  const net = d.reduce((a, t) => a + t.pnl, 0);
  return `net $${net.toFixed(0).padStart(7)} maxDD $${maxDD.toFixed(0).padStart(7)} · eval ${accountLine(evalAll)} · funded[test] ${accountLine(fundedTest)}`;
}

/* ---------------- main ---------------- */

type SessionRegime = {
  volT: ScoredTrade["volT"];
  vixT: ScoredTrade["vixT"];
  agreeD: boolean | null;
  agreeW: boolean | null;
  cotNetPct: number | null; // spec net % of OI (latest published report)
  cotPct52: number | null; // percentile of net over trailing 52 published reports
  cotWow: number | null; // WoW change in net (contracts)
  s210: number | null; // 2s10s in bp at prior close
  s210Inverted: boolean | null;
  y10Chg3m: number | null; // 10y change vs ~3 months prior, bp
};

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let dates = await archiveDates();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  const vixMap = await loadVix();
  const vixCloses = vixMap ? [...vixMap.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v) : [];
  const vixTercileOf = (date: string): "LOW" | "MID" | "HIGH" | null => {
    if (!vixMap) return null;
    const prior = [...vixMap.keys()].filter((d) => d < date).sort();
    const v = prior.length ? vixMap.get(prior[prior.length - 1])! : null;
    if (v == null) return null;
    const pct = vixCloses.filter((x) => x <= v).length / vixCloses.length;
    return pct < 0.33 ? "LOW" : pct < 0.66 ? "MID" : "HIGH";
  };
  const cot = await loadCot();
  const tsy = await loadTreasury();
  console.log(`replaying ${dates.length} sessions · split ${o.split} · vix=${vixMap ? vixMap.size : "missing"} · cot=${cot ? cot.length : "missing"} · tsy=${tsy ? tsy.length : "missing"}`);

  /* helper: latest COT published strictly before a session date */
  const cotFeatures = (date: string): { netPct: number | null; pct52: number | null; wow: number | null } => {
    if (!cot) return { netPct: null, pct52: null, wow: null };
    const eligible = cot.filter((r) => r.pub < date);
    const last = eligible[eligible.length - 1];
    if (!last) return { netPct: null, pct52: null, wow: null };
    const window52 = eligible.slice(-52);
    const below = window52.filter((r) => r.net <= last.net).length;
    const prev = eligible[eligible.length - 2];
    return {
      netPct: Math.round((last.net / last.oi) * 1000) / 10,
      pct52: window52.length >= 10 ? Math.round((below / window52.length) * 100) : null,
      wow: prev ? last.net - prev.net : null,
    };
  };
  const tsyFeatures = (date: string): { s210: number | null; inverted: boolean | null; y10Chg3m: number | null } => {
    if (!tsy) return { s210: null, inverted: null, y10Chg3m: null };
    const prior = tsy.filter((r) => r.day < date);
    const last = prior[prior.length - 1];
    if (!last) return { s210: null, inverted: null, y10Chg3m: null };
    const ref = prior[Math.max(0, prior.length - 1 - 63)];
    return {
      s210: last.s210,
      inverted: last.s210 == null ? null : last.s210 < 0,
      y10Chg3m: ref && last.y10 != null && ref.y10 != null ? Math.round((last.y10 - ref.y10) * 100) : null,
    };
  };

  /* stop variants — each is a function of the SESSION regime (constants) */
  type Variant = { name: string; stopFor: (r: SessionRegime) => number; sizeFor: (r: SessionRegime) => number };
  const variants: Variant[] = [
    { name: "s0.75", stopFor: () => 0.75, sizeFor: () => 1 },
    { name: "s1.0", stopFor: () => 1.0, sizeFor: () => 1 },
    { name: "s1.25", stopFor: () => 1.25, sizeFor: () => 1 },
    { name: "s1.5", stopFor: () => 1.5, sizeFor: () => 1 },
    { name: "stop×1.25 in HIGH vol", stopFor: (r) => (r.volT === "HIGH" ? 1.25 : 1.0), sizeFor: () => 1 },
    { name: "size by vol (L1.25/M1.0/H0.75)", stopFor: () => 1, sizeFor: (r) => (r.volT === "LOW" ? 1.25 : r.volT === "HIGH" ? 0.75 : 1.0) },
    { name: "both vol (stop+size)", stopFor: (r) => (r.volT === "HIGH" ? 1.25 : 1.0), sizeFor: (r) => (r.volT === "LOW" ? 1.25 : r.volT === "HIGH" ? 0.75 : 1.0) },
    { name: "size by daily structure", stopFor: () => 1, sizeFor: (r) => (r.agreeD === true ? 1.25 : r.agreeD === false ? 0.5 : 1.0) },
    {
      name: "size by daily+weekly structure",
      stopFor: () => 1,
      sizeFor: (r) => {
        const s = (r.agreeD === true ? 1 : r.agreeD === false ? -1 : 0) + (r.agreeW === true ? 1 : r.agreeW === false ? -1 : 0);
        return s >= 2 ? 1.5 : s <= -2 ? 0.5 : 1.0;
      },
    },
    { name: "stop×1.25 in HIGH vix", stopFor: (r) => (r.vixT === "HIGH" ? 1.25 : 1.0), sizeFor: () => 1 },
    { name: "size by vix (L1.25/M1.0/H0.75)", stopFor: () => 1, sizeFor: (r) => (r.vixT === "LOW" ? 1.25 : r.vixT === "HIGH" ? 0.75 : 1.0) },
    { name: "both vix (stop+size)", stopFor: (r) => (r.vixT === "HIGH" ? 1.25 : 1.0), sizeFor: (r) => (r.vixT === "LOW" ? 1.25 : r.vixT === "HIGH" ? 0.75 : 1.0) },
    { name: "size×0.75 when COT crowded (≥90th)", stopFor: () => 1, sizeFor: (r) => (r.cotPct52 != null && r.cotPct52 >= 90 ? 0.75 : 1.0) },
    { name: "size×1.25 when positioning RISING", stopFor: () => 1, sizeFor: (r) => (r.cotWow == null ? 1.0 : (r.cotWow >= 0 ? 1.25 : 1.0)) },
    { name: "size×1.25 when positioning FALLING", stopFor: () => 1, sizeFor: (r) => (r.cotWow == null ? 1.0 : (r.cotWow < 0 ? 1.25 : 1.0)) },
    { name: "stop×1.25 when 2s10s inverted", stopFor: (r) => (r.s210Inverted ? 1.25 : 1.0), sizeFor: () => 1 },
    { name: "size×1.25 when 2s10s positive", stopFor: () => 1, sizeFor: (r) => (r.s210 != null && r.s210 > 0 ? 1.25 : 1.0) },
    {
      name: "crowd+rates combo",
      stopFor: (r) => (r.s210Inverted ? 1.25 : 1.0),
      sizeFor: (r) => (r.cotPct52 != null && r.cotPct52 >= 90 ? 0.75 : 1.0),
    },
  ];

  const perVariant: ScoredTrade[][] = variants.map(() => []);
  const baseTrades: ScoredTrade[] = [];

  /* rolling prior-session state (strictly lookahead-free) */
  const dailyBars: { day: string; high: number; low: number }[] = [];
  const realVols: number[] = [];

  const volTercileOf = (): "LOW" | "MID" | "HIGH" | null => {
    if (realVols.length < 5) return null;
    const last = realVols[realVols.length - 1];
    const pct = realVols.filter((x) => x <= last).length / realVols.length;
    return pct < 0.33 ? "LOW" : pct < 0.66 ? "MID" : "HIGH";
  };

  let loaded = 0;
  let failed = 0;
  const t0 = Date.now();
  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loadedMinutes = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of loadedMinutes) {
      if (!minutes) {
        failed++;
        continue;
      }
      loaded++;
      const rth = minutes.filter((m) => m.t >= RTH_OPEN && m.t <= RTH_CLOSE);
      const c = cotFeatures(date);
      const t = tsyFeatures(date);
      const regime: SessionRegime = {
        volT: volTercileOf(),
        vixT: vixTercileOf(date),
        agreeD: null,
        agreeW: null,
        cotNetPct: c.netPct,
        cotPct52: c.pct52,
        cotWow: c.wow,
        s210: t.s210,
        s210Inverted: t.inverted,
        y10Chg3m: t.y10Chg3m,
      };
      if (dailyBars.length >= 30) {
        const s = htfStructure(dailyBars.map((b) => ({ t: `${b.day}T12:00:00`, high: b.high, low: b.low })));
        regime.agreeD = s.daily === "HH/HL" ? true : s.daily === "LH/LL" ? false : null;
        regime.agreeW = s.weekly === "HH/HL" ? true : s.weekly === "LH/LL" ? false : null;
      }

      const raw = [...detectMomentum(minutes, MOM_PROD), ...detectExpansionScalp(minutes, EXP_PROD)];
      for (let v = 0; v < variants.length; v++) {
        const trades = scoreSequential(minutes, raw, date, variants[v].stopFor(regime));
        for (const t of trades) {
          t.volT = regime.volT;
          t.vixT = regime.vixT;
          t.agreeD = regime.agreeD;
          t.agreeW = regime.agreeW;
          t.cotNetPct = regime.cotNetPct;
          t.cotPct52 = regime.cotPct52;
          t.cotWow = regime.cotWow;
          t.s210 = regime.s210;
          t.s210Inverted = regime.s210Inverted;
          t.y10Chg3m = regime.y10Chg3m;
          t.pnl *= variants[v].sizeFor(regime); // size multiplier as scaled fill
        }
        perVariant[v].push(...trades);
        if (v === 1) baseTrades.push(...trades); // s1.0 ×1.0 = baseline
      }

      /* after scoring: publish this session's daily bar + realized vol */
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
    if (i % 200 < CONCURRENCY) console.log(`  ${i}/${dates.length} sessions…`);
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s · ${loaded} loaded · ${failed} failed · ${baseTrades.length} base trades`);

  /* ---- A · uniform grid (stop × size) ---- */
  console.log("\n=== A · UNIFORM GRID (stopMult × sizeMult) — net pts / PF ===");
  const sizeMults = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  console.log("        " + sizeMults.map((s) => `×${s}`.padStart(8)).join(""));
  for (const stopName of ["s0.75", "s1.0", "s1.25", "s1.5"]) {
    const byStop = perVariant[variants.findIndex((x) => x.name === stopName)];
    let row = `${stopName}  `;
    for (const sizeMult of sizeMults) {
      const scaled = byStop.map((t) => ({ ...t, pnl: t.pnl * sizeMult }));
      const s = stats(scaled);
      const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
      row += `${(s.netPts / 1000).toFixed(1)}k/${pf}`.padStart(9);
    }
    console.log(row);
  }

  /* ---- all variants detail ---- */
  console.log("\n=== ALL VARIANTS (scored at their own stop/size) ===");
  for (let v = 0; v < variants.length; v++) {
    console.log(`${variants[v].name.padEnd(32)} | ${fmt(stats(perVariant[v]))} | ${acct(perVariant[v], o.split)}`);
  }

  /* ---- feature bucket breakdown of the base ---- */
  console.log("\n=== BASE (s1.0 ×1.0) × REGIME BUCKETS ===");
  const buckets: { label: string; pred: (t: ScoredTrade) => boolean }[] = [
    { label: "vol LOW", pred: (t) => t.volT === "LOW" },
    { label: "vol MID", pred: (t) => t.volT === "MID" },
    { label: "vol HIGH", pred: (t) => t.volT === "HIGH" },
    { label: "vix LOW", pred: (t) => t.vixT === "LOW" },
    { label: "vix MID", pred: (t) => t.vixT === "MID" },
    { label: "vix HIGH", pred: (t) => t.vixT === "HIGH" },
    { label: "daily agree", pred: (t) => t.agreeD === true },
    { label: "daily counter", pred: (t) => t.agreeD === false },
    { label: "daily neutral", pred: (t) => t.agreeD === null },
    { label: "weekly agree", pred: (t) => t.agreeW === true },
    { label: "weekly counter", pred: (t) => t.agreeW === false },
    { label: "weekly neutral", pred: (t) => t.agreeW === null },
    { label: "cot 0-33 pct", pred: (t) => t.cotPct52 != null && t.cotPct52 < 33 },
    { label: "cot 33-66 pct", pred: (t) => t.cotPct52 != null && t.cotPct52 >= 33 && t.cotPct52 < 66 },
    { label: "cot 66-100 pct", pred: (t) => t.cotPct52 != null && t.cotPct52 >= 66 },
    { label: "cot net long", pred: (t) => t.cotNetPct != null && t.cotNetPct > 0 },
    { label: "cot net short", pred: (t) => t.cotNetPct != null && t.cotNetPct <= 0 },
    { label: "2s10s inverted", pred: (t) => t.s210Inverted === true },
    { label: "2s10s positive", pred: (t) => t.s210Inverted === false },
    { label: "10y 3m chg pos", pred: (t) => t.y10Chg3m != null && t.y10Chg3m > 0 },
    { label: "10y 3m chg neg", pred: (t) => t.y10Chg3m != null && t.y10Chg3m <= 0 },
  ];
  for (const b of buckets) {
    console.log(`${b.label.padEnd(16)} | ${fmt(stats(baseTrades.filter(b.pred)))}`);
  }

  if (o.dump) {
    await fs.writeFile(
      o.dump,
      JSON.stringify(
        baseTrades.map((t) => ({ date: t.date, dir: t.dir, entry: t.entry, risk: t.risk, pnl: t.pnl, hit: t.hit, volT: t.volT, vixT: t.vixT, agreeD: t.agreeD, agreeW: t.agreeW })),
        null,
        1,
      ),
    );
    console.log(`dumped ${baseTrades.length} trades → ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
