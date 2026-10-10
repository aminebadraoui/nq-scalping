/* ------------------------------------------------------------------ *
 * Seasonal almanac — measure every calendar window as a number.
 *
 *   Part A · day-level windows: month, day-of-week, turn-of-month,
 *            quarter-turn, holiday-adjacent, early-close, OPEX day/week,
 *            FOMC day / pre-FOMC, session legs (preRTH / RTH / tail) and
 *            the 24h pre-FOMC window — each as n, P(up), mean pts,
 *            median, mean |move|, lift vs baseline, Wilson 95% CI,
 *            train/test split (default 2026-01-01).
 *   Part B · hour-of-day drift (the MatFinOg measurement): going long
 *            every hour of the ET day, hour-open to next-hour-open,
 *            gross and net of 0.5 pt round-trip cost.
 *   Part C · overlay on the momentum card: the same windows sliced
 *            across the MOM_PROD flush + EXP_PROD replay (esStudy
 *            discipline: sequential one-trade-at-a-time, pessimistic
 *            same-bar exit, 0.5 pt cost, 60-bar time exit).
 *
 * Conventions:
 *   · session date D = the RTH calendar date (the file's own date)
 *   · day return chains close-to-close across consecutive sessions
 *     (last traded minute of the file), so weekend/halt gaps count
 *   · "with vol" = total > 0; feed clock is CT, reported in ET (+1h)
 *   · calendars: CME full holidays + early closes 2024–2026,
 *     FOMC decision days 2023-12 → 2026 (Fed official calendar)
 *
 *   GC_REMOTE_URL=... node --import scripts/ts-loader.mjs \
 *     scripts/seasonalAlmanac.ts [--max N] [--split 2026-01-01] \
 *     [--dump out.json] [--offline]
 * ------------------------------------------------------------------ */

import { promises as fs } from "node:fs";
import { loadSessionMinutes, archiveDates, cacheDir } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  closeOf,
  MOM_PROD,
  EXP_PROD,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { scoreTrade, scoreSequential as scoreSequentialEngine, coreStats, propViability, wilson95, renderT1, renderT2, renderT4, renderVerdict } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const COST_PTS = 0.5; // still used by Part B (hour drift net of cost)

/* ---------------- calendars ---------------- */

const FOMC_DAYS = new Set<string>([
  "2023-12-13",
  "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31",
  "2024-09-18", "2024-11-07", "2024-12-18",
  "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30",
  "2025-09-17", "2025-10-29", "2025-12-10",
  "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29",
  "2026-09-16", "2026-10-28", "2026-12-09",
]);

const FULL_HOLIDAYS = new Set<string>([
  "2023-12-25",
  "2024-01-01", "2024-01-15", "2024-02-19", "2024-03-29", "2024-05-27",
  "2024-06-19", "2024-07-04", "2024-09-02", "2024-11-28", "2024-12-25",
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
  "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
  "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
]);

const EARLY_CLOSE = new Set<string>([
  "2024-07-03", "2024-11-29", "2025-07-03", "2025-11-28",
  "2026-07-03", "2026-11-27",
]);

/* ---------------- CLI ---------------- */

function parseArgs(argv: string[]) {
  const o: { max?: number; split?: string; dump?: string; offline: boolean } = { offline: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max") o.max = Number(argv[++i]);
    else if (a === "--split") o.split = argv[++i];
    else if (a === "--dump") o.dump = argv[++i];
    else if (a === "--offline") o.offline = true;
  }
  return o;
}

/* ---------------- date helpers ---------------- */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function partsOf(d: string): { y: number; m: number; dd: number; dow: number } {
  const [y, m, dd] = d.split("-").map(Number);
  return { y, m, dd, dow: new Date(Date.UTC(y, m - 1, dd)).getUTCDay() };
}
function nextDay(d: string): string {
  const { y, m, dd } = partsOf(d);
  return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10);
}
function prevDay(d: string): string {
  const { y, m, dd } = partsOf(d);
  return new Date(Date.UTC(y, m - 1, dd - 1)).toISOString().slice(0, 10);
}
const monthOf = (d: string): string => d.slice(0, 7);

/* ---------------- inventory + per-date flags ---------------- */

async function inventory(): Promise<string[]> {
  let dates = await archiveDates();
  if (!dates.length) {
    // offline fallback: scan the local gzip cache
    const dir = cacheDir();
    try {
      const files = await fs.readdir(dir);
      dates = [...new Set(files.filter((f) => /^\d{4}-\d{2}-\d{2}_ETH\.json(\.gz)?$/.test(f)).map((f) => f.slice(0, 10)))].sort();
    } catch {
      /* empty */
    }
  }
  return dates;
}

type DayFlags = {
  prevT: string | null;
  nextT: string | null;
  lastOfMonth: boolean;
  first3OfMonth: boolean;
  quarterTurn: boolean;
  preHoliday: boolean;
  postHoliday: boolean;
  earlyClose: boolean;
  opexDay: boolean;
  opexWeek: boolean;
  fomcDay: boolean;
  preFomc: boolean;
};

function buildFlags(dates: string[]): Map<string, DayFlags> {
  const idx = new Map(dates.map((d, i) => [d, i]));
  const prevT = (d: string) => (idx.get(d)! > 0 ? dates[idx.get(d)! - 1] : null);
  const nextT = (d: string) => (idx.get(d)! < dates.length - 1 ? dates[idx.get(d)! + 1] : null);
  const out = new Map<string, DayFlags>();

  // opex day per month: third Friday, fell back to the previous trading day on a holiday
  const opexByMonth = new Map<string, string>();
  for (const d of dates) {
    const { y, m, dow } = partsOf(d);
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (!opexByMonth.has(key)) {
      const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
      const third = new Date(Date.UTC(y, m - 1, 1 + ((5 - first + 7) % 7) + 14)).toISOString().slice(0, 10);
      let found = third;
      if (!idx.has(found)) {
        let back = third;
        let fwd = third;
        for (let k = 0; k < 6 && !idx.has(found); k++) {
          back = prevDay(back);
          fwd = nextDay(fwd);
          if (idx.has(back)) found = back;
          else if (idx.has(fwd)) found = fwd;
        }
      }
      opexByMonth.set(key, idx.has(found) ? found : "");
    }
  }

  for (const d of dates) {
    const p = partsOf(d);
    const prev = prevT(d);
    const next = nextT(d);
    const lastOfMonth = !next || monthOf(next) !== monthOf(d);
    const firstOfMonth = !prev || monthOf(prev) !== monthOf(d);
    // first 3 trading days of the month: walk back ≤2 sessions to a month change
    let first3 = firstOfMonth;
    let back = d;
    for (let k = 0; k < 2 && !first3; k++) {
      back = prevT(back) ?? "";
      if (!back) break;
      const bp = prevT(back);
      if (!bp || monthOf(bp) !== monthOf(back)) first3 = true;
    }
    // quarter turn: within 2 trading days of a quarter-boundary month change
    const Q = new Set([3, 6, 9, 12]);
    const lastOfQuarter = next !== null && monthOf(next) !== monthOf(d) && Q.has(partsOf(next).m);
    const firstOfQuarter = prev !== null && monthOf(prev) !== monthOf(d) && Q.has(p.m);
    let quarterTurn = lastOfQuarter || firstOfQuarter;
    let f = d;
    for (let k = 0; k < 2 && !quarterTurn; k++) {
      f = nextT(f) ?? "";
      if (!f) break;
      const fp = partsOf(f);
      const fn = nextT(f);
      if ((!fn || monthOf(fn) !== monthOf(f)) && Q.has(fp.m)) quarterTurn = true;
      const fprev = prevT(f);
      if (fprev && monthOf(fprev) !== monthOf(f) && Q.has(fp.m)) quarterTurn = true;
    }

    // holiday-adjacent: scan the calendar gap to the next/previous trading day
    let preHoliday = false;
    let cur = nextDay(d);
    let guard = 0;
    while (cur !== next && guard < 4) {
      if (FULL_HOLIDAYS.has(cur)) {
        preHoliday = true;
        break;
      }
      cur = nextDay(cur);
      guard++;
    }
    let postHoliday = false;
    cur = prevDay(d);
    guard = 0;
    while (cur !== prev && guard < 4) {
      if (FULL_HOLIDAYS.has(cur)) {
        postHoliday = true;
        break;
      }
      cur = prevDay(cur);
      guard++;
    }

    const opex = opexByMonth.get(monthOf(d)) ?? "";
    const { dow } = p;
    let inOpexWeek = false;
    if (opex) {
      const op = partsOf(opex);
      const weekStart = new Date(Date.UTC(op.y, op.m - 1, op.dd - op.dow)).toISOString().slice(0, 10);
      inOpexWeek = d >= weekStart && d <= opex && dow >= 1 && dow <= 5;
    }

    out.set(d, {
      prevT: prev,
      nextT: next,
      lastOfMonth,
      first3OfMonth: first3,
      quarterTurn,
      preHoliday,
      postHoliday,
      earlyClose: EARLY_CLOSE.has(d),
      opexDay: d === opex,
      opexWeek: inOpexWeek,
      fomcDay: FOMC_DAYS.has(d),
      preFomc: next !== null && FOMC_DAYS.has(next),
    });
  }
  return out;
}

/* ---------------- minute helpers ---------------- */

const hhmm = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hourET = (t: string): number => (Number(t.slice(0, 2)) + 1) % 24; // CT → ET
const inRTH = (t: string): boolean => {
  const m = hhmm(t);
  return m >= 8 * 60 + 30 && m <= 14 * 60 + 59;
};

/** closeOf the last traded minute in the given CT time range (inclusive). */
function closeAt(minutes: MomMinute[], from: number, to: number): number | null {
  for (let i = minutes.length - 1; i >= 0; i--) {
    const m = hhmm(minutes[i].t);
    if (m >= from && m <= to && minutes[i].buy + minutes[i].sell > 0) return closeOf(minutes[i]);
  }
  return null;
}
/** closeOf the first traded minute in the given CT time range. */
function openAt(minutes: MomMinute[], from: number, to: number): number | null {
  for (let i = 0; i < minutes.length; i++) {
    const m = hhmm(minutes[i].t);
    if (m >= from && m <= to && minutes[i].buy + minutes[i].sell > 0) return closeOf(minutes[i]);
  }
  return null;
}
/** closeOf the first traded minute of hour h (ET). */
function hourOpen(minutes: MomMinute[], h: number): number | null {
  const ct = (h + 23) % 24;
  return openAt(minutes, ct * 60, ct * 60 + 59);
}

/* ---------------- stats ---------------- */

type DayStat = { n: number; wins: number; up: number; mean: number; med: number; meanAbs: number; lo: number; hi: number };
type CellStat = DayStat & { lift: number; train: { n: number; up: number; mean: number }; test: { n: number; up: number; mean: number } };

/* Wilson 95% CI on a proportion now comes from the engine's wilson95
 * (percent bounds; same formula as the previous local implementation). */

function dayStat(vals: number[]): DayStat {
  const n = vals.length;
  const wins = vals.filter((v) => v > 0).length;
  const mean = n ? vals.reduce((a, b) => a + b, 0) / n : 0;
  const s = [...vals].sort((a, b) => a - b);
  const med = n ? (s[Math.floor(n / 2)] + s[Math.ceil((n - 1) / 2)]) / 2 : 0;
  const meanAbs = n ? vals.reduce((a, b) => a + Math.abs(b), 0) / n : 0;
  const [lo, hi] = wilson95(wins, n);
  return { n, wins, up: n ? (wins / n) * 100 : 0, mean, med, meanAbs, lo, hi };
}

function cellStat(vals: number[], allUp: number, split: string, dates: string[]): CellStat {
  const base = dayStat(vals);
  const tr = vals.filter((_, i) => dates[i] < split);
  const te = vals.filter((_, i) => dates[i] >= split);
  const t1 = dayStat(tr);
  const t2 = dayStat(te);
  return { ...base, lift: allUp > 0 ? base.up / allUp : 0, train: { n: t1.n, up: t1.up, mean: t1.mean }, test: { n: t2.n, up: t2.up, mean: t2.mean } };
}

function fmtDay(s: CellStat): string {
  return (
    `n=${String(s.n).padStart(4)}  up=${s.up.toFixed(1).padStart(5)}% [${s.lo.toFixed(0).padStart(2)},${s.hi.toFixed(0).padStart(2)}]` +
    `  mean=${s.mean.toFixed(1).padStart(7)}  med=${s.med.toFixed(1).padStart(7)}  |m|=${s.meanAbs.toFixed(1).padStart(6)}` +
    `  lift=${s.lift.toFixed(2).padStart(5)}  train=${s.train.n}/${s.train.up.toFixed(0).padStart(3)}%/${s.train.mean.toFixed(1).padStart(6)}` +
    `  test=${s.test.n}/${s.test.up.toFixed(0).padStart(3)}%/${s.test.mean.toFixed(1).padStart(6)}`
  );
}

function printFamily(title: string, cells: Array<[string, CellStat]>) {
  console.log(`\n── ${title} ──`);
  for (const [name, s] of cells) {
    console.log(`${name.padEnd(16)} ${fmtDay(s)}`);
  }
}

/* ---------------- signal replay (esStudy discipline) ---------------- */

type Scored = MomentumSignal & {
  date: string;
  pnl: number;
  exit: number;
  hit: "target" | "stop" | "time";
  heldBars: number;
};

function scoreSignal(minutes: MomMinute[], sig: MomentumSignal, date: string): Scored | null {
  const dir = sig.dir === "long" ? 1 : -1;
  /* canonical engine scorer: pessimistic stop-first, 0.5 pt cost, 60-bar
   * time exit at closeOf, last-bar signals dropped — semantics identical
   * to the previous local loop for every valid detector signal */
  const sc = scoreTrade(minutes, {
    dir,
    entry: sig.entry,
    stop: sig.stop,
    target: sig.target,
    entryIdx: sig.entryIdx,
    risk: sig.risk,
  });
  if (!sc) return null;
  return { ...sig, date, pnl: sc.pnl, exit: sc.exit, hit: sc.hit, heldBars: sc.heldBars };
}

function scoreSequential(minutes: MomMinute[], signals: MomentumSignal[], date: string): Scored[] {
  return scoreSequentialEngine(signals, (s) => scoreSignal(minutes, s, date));
}

type TradeStat = { n: number; wins: number; wr: number; pf: number; avgPts: number; netPts: number; lo: number; hi: number; days: number };

function tradeStat(tr: Scored[]): TradeStat {
  /* engine coreStats — identical formulas to the previous local version
   * (wins = pnl>0, pf = grossWin/grossLoss over pnl<=0, exp = net/n), so
   * the legacy fmtTrade() output is unchanged */
  const c = coreStats(tr.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk })));
  return { n: c.n, wins: c.wins, wr: c.wr, pf: c.pf, avgPts: c.expPts, netPts: c.netPts, lo: c.wrCi[0], hi: c.wrCi[1], days: c.sessions };
}

function fmtTrade(s: TradeStat): string {
  const pf = Number.isFinite(s.pf) ? s.pf.toFixed(2) : "inf";
  return (
    `n=${String(s.n).padStart(5)}  wr=${s.wr.toFixed(1).padStart(5)}% [${s.lo.toFixed(0)},${s.hi.toFixed(0)}]` +
    `  pf=${pf.padStart(5)}  avg=${s.avgPts.toFixed(2).padStart(6)}  net=${s.netPts.toFixed(0).padStart(7)}pts  days=${s.days}`
  );
}

function tradeRow(tr: Scored[], splitDate: string): string {
  const all = tradeStat(tr);
  const train = tradeStat(tr.filter((t) => t.date < splitDate));
  const test = tradeStat(tr.filter((t) => t.date >= splitDate));
  return `${fmtTrade(all)}\n${"".padEnd(16)}train: ${fmtTrade(train)}\n${"".padEnd(16)}test : ${fmtTrade(test)}`;
}

function printTradeFamily(title: string, cells: Array<[string, Scored[]]>, split: string) {
  console.log(`\n── ${title} ──`);
  for (const [name, tr] of cells) {
    console.log(`${name.padEnd(16)} ${tradeRow(tr, split)}`);
  }
}

/* ---------------- main ---------------- */

type SessionRec = {
  date: string;
  ret: number | null; // close-to-close day return
  preRTH: number | null;
  rth: number | null;
  tail: number | null;
  close1300: number | null;
  hourLong: Array<number | null>; // per ET hour 0..23, gross 1h long
};

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const split = o.split ?? "2026-01-01";
  let dates = await inventory();
  if (!dates.length) {
    console.error("no session inventory (set GC_REMOTE_URL or warm the cache)");
    process.exit(1);
  }
  if (o.max) dates = dates.slice(0, o.max);
  console.log(`seasonal almanac · ${dates.length} sessions ${dates[0]} → ${dates[dates.length - 1]} · split ${split}`);
  if (o.offline) console.log("(offline inventory)");

  const flags = buildFlags(dates);
  const records = new Map<string, SessionRec>();
  let prevClose: number | null = null;
  let failed = 0;

  let i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(
      chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })),
    );
    for (const { date, minutes } of loaded) {
      if (!minutes) {
        failed++;
        continue;
      }
      const closeS = closeAt(minutes, 0, 24 * 60 - 1); // last traded minute anywhere
      const closeR = closeAt(minutes, 8 * 60 + 30, 14 * 60 + 59);
      const openR = openAt(minutes, 8 * 60 + 30, 8 * 60 + 59);
      const openS = openAt(minutes, 0, 24 * 60 - 1);
      const c1300 = closeAt(minutes, 13 * 60, 13 * 60 + 59);
      const ret = closeS !== null && prevClose !== null ? closeS - prevClose : null;
      const rec: SessionRec = {
        date,
        ret,
        preRTH: openR !== null && prevClose !== null ? openR - prevClose : null,
        rth: openR !== null && closeR !== null ? closeR - openR : null,
        tail: closeR !== null && closeS !== null ? closeS - closeR : null,
        close1300: c1300,
        hourLong: [],
      };
      for (let h = 0; h < 24; h++) {
        const a = hourOpen(minutes, h);
        const b = hourOpen(minutes, (h + 1) % 24);
        rec.hourLong.push(a !== null && b !== null ? b - a : null);
      }
      records.set(date, rec);
      prevClose = closeS;
    }
    i += chunk.length;
  }
  console.log(`loaded ${records.size} sessions (${failed} failed)\n`);

  /* ---- Part A: day-level windows ---- */

  const dayRows = dates.filter((d) => records.get(d)!.ret !== null);
  const dayVals = dayRows.map((d) => records.get(d)!.ret!);
  const allUp = dayStat(dayVals).up;
  console.log(`── PART A · day-level windows (close-to-close, NQ points) ──`);
  console.log(`baseline      ${fmtDay(cellStat(dayVals, allUp, split, dayRows))}`);

  const fam = (key: (d: string) => string, rows: string[] = dayRows) => {
    const m = new Map<string, number[]>();
    for (const d of rows) {
      const k = key(d);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(records.get(d)!.ret!);
    }
    return [...m.entries()]
      .map(([k, v]): [string, CellStat] => [k, cellStat(v, allUp, split, rows.filter((r) => key(r) === k))])
      .sort((a, b) => a[0].localeCompare(b[0]));
  };

  printFamily("month", fam((d) => `${MONTHS[partsOf(d).m - 1]}`));
  printFamily("day of week", fam((d) => DOW[partsOf(d).dow]));
  printFamily("turn of month", fam((d) => (flags.get(d)!.lastOfMonth ? "last-day" : flags.get(d)!.first3OfMonth ? "first-3" : "mid-month")));
  printFamily("quarter turn", fam((d) => (flags.get(d)!.quarterTurn ? "quarter-turn" : "mid-quarter")));
  printFamily(
    "holiday window",
    fam((d) => (flags.get(d)!.preHoliday ? "pre-holiday" : flags.get(d)!.postHoliday ? "post-holiday" : flags.get(d)!.earlyClose ? "early-close" : "regular")),
  );
  printFamily("OPEX", fam((d) => (flags.get(d)!.opexDay ? "opex-day" : flags.get(d)!.opexWeek ? "opex-week" : "other")));
  printFamily("FOMC", fam((d) => (flags.get(d)!.fomcDay ? "fomc-day" : flags.get(d)!.preFomc ? "pre-fomc-day" : "other")));

  // session legs
  for (const leg of ["preRTH", "rth", "tail"] as const) {
    const rows = dates.filter((d) => records.get(d)![leg] !== null);
    const vals = rows.map((d) => records.get(d)![leg]!);
    const st = cellStat(vals, dayStat(vals).up, split, rows);
    const total = vals.reduce((a, b) => a + b, 0);
    console.log(`${leg.padEnd(15)} ${fmtDay(st)}  Σ=${total.toFixed(0)}pts (${rows.length} sessions)`);
  }

  // 24h pre-FOMC window: close 13:00 CT on D-1 → close 13:00 CT on D
  const fomcRows = dates.filter((d) => flags.get(d)!.fomcDay && flags.get(d)!.prevT && records.get(d)!.close1300 !== null && records.get(flags.get(d)!.prevT!)!.close1300 !== null);
  const fomc24 = fomcRows.map((d) => records.get(d)!.close1300! - records.get(flags.get(d)!.prevT!)!.close1300!);
  if (fomc24.length) {
    const st = cellStat(fomc24, dayStat(fomc24).up, split, fomcRows);
    console.log(`24h pre-FOMC   ${fmtDay(st)}`);
  }

  /* ---- Part B: hour-of-day drift ---- */

  console.log(`\n── PART B · hour-of-day drift (long 1h, hour-open → next hour-open, ET) ──`);
  console.log(`hour  n    up%     grossMean   netMean(0.5pt)  trainMean   testMean   wilson`);
  for (let h = 0; h < 24; h++) {
    const rows = dates.filter((d) => records.get(d)!.hourLong[h] !== null);
    const vals = rows.map((d) => records.get(d)!.hourLong[h]!);
    const gross = dayStat(vals);
    const net = dayStat(vals.map((v) => v - COST_PTS));
    const tr = vals.filter((_, k) => rows[k] < split);
    const te = vals.filter((_, k) => rows[k] >= split);
    const t1 = dayStat(tr);
    const t2 = dayStat(te);
    console.log(
      `${String(h).padStart(4)}  ${String(gross.n).padStart(4)}  ${gross.up.toFixed(1).padStart(5)}%  ` +
        `${gross.mean.toFixed(2).padStart(8)}   ${net.mean.toFixed(2).padStart(9)}     ${t1.mean.toFixed(2).padStart(8)}  ${t2.mean.toFixed(2).padStart(8)}  [${gross.lo.toFixed(0)},${gross.hi.toFixed(0)}]`,
    );
  }
  console.log("short mirror = −long; hours 16–17 ET have no hour-open (daily halt)");

  /* ---- Part C: momentum-card overlay ---- */

  console.log(`\n── PART C · momentum-card overlay (MOM_PROD flush + EXP_PROD, sequential) ──`);
  const trades: Scored[] = [];
  i = 0;
  while (i < dates.length) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const loaded = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date) })));
    for (const { date, minutes } of loaded) {
      if (!minutes) continue;
      const mom = detectMomentum(minutes, MOM_PROD);
      const exp = detectExpansionScalp(minutes, EXP_PROD);
      const flushSigs = mom.filter((s) => s.kind === "flush");
      const seen = new Set(flushSigs.map((s) => `${s.entryIdx}|${s.dir}`));
      const merged = [...flushSigs, ...exp.filter((s) => !seen.has(`${s.entryIdx}|${s.dir}`))];
      trades.push(...scoreSequential(minutes, merged, date));
    }
    i += chunk.length;
  }
  console.log(`replayed ${dates.length} sessions → ${trades.length} trades`);
  console.log(`baseline      ${tradeRow(trades, split)}`);

  const tcell = (key: (t: Scored) => string) => {
    const m = new Map<string, Scored[]>();
    for (const t of trades) {
      const k = key(t);
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(t);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };

  const hourOf = (t: Scored) => String(hourET(t.t));
  printTradeFamily("entry hour (ET)", tcell((t) => hourOf(t)), split);
  const hour37 = trades.filter((t) => {
    const h = hourET(t.t);
    return h >= 3 && h <= 7;
  });
  console.log(`hour 3-7 ET    ${tradeRow(hour37, split)}`);
  printTradeFamily(
    "session part",
    tcell((t) => (inRTH(t.t) ? "RTH 9:30–16:00" : "Globex")),
    split,
  );
  printTradeFamily("day of week", tcell((t) => DOW[partsOf(t.date).dow]), split);
  printTradeFamily("month", tcell((t) => MONTHS[partsOf(t.date).m - 1]), split);
  printTradeFamily("turn of month", tcell((t) => (flags.get(t.date)!.lastOfMonth ? "last-day" : flags.get(t.date)!.first3OfMonth ? "first-3" : "mid-month")), split);
  printTradeFamily(
    "holiday window",
    tcell((t) => (flags.get(t.date)!.preHoliday ? "pre-holiday" : flags.get(t.date)!.postHoliday ? "post-holiday" : flags.get(t.date)!.earlyClose ? "early-close" : "regular")),
    split,
  );
  printTradeFamily("OPEX", tcell((t) => (flags.get(t.date)!.opexDay ? "opex-day" : flags.get(t.date)!.opexWeek ? "opex-week" : "other")), split);
  printTradeFamily("FOMC", tcell((t) => (flags.get(t.date)!.fomcDay ? "fomc-day" : flags.get(t.date)!.preFomc ? "pre-fomc-day" : "other")), split);

  /* ---- STANDARD REPORT (consolidated engine · BACKTEST-REPORT-STANDARD.md) ----
   * T1 core quality for the Part C card overlay, T2 one row per calendar
   * cell, T4 prop viability, five-slot verdict. ---- */
  const splitDate = split;
  const engineTrades = trades.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
  const eAll = coreStats(engineTrades);
  const eTrain = coreStats(engineTrades.filter((t) => t.date < splitDate));
  const eTest = coreStats(engineTrades.filter((t) => t.date >= splitDate));
  console.log("\n=== STANDARD REPORT ===");
  console.log(
    renderT1([
      { label: "all", stats: eAll },
      { label: "train", stats: eTrain },
      { label: "test", stats: eTest },
    ]),
  );
  const t2rows: { rule: string; n: number; wr: number; ci: [number, number]; pf: number; expPts: number; trainTest: string; compare: string }[] = [];
  const cellFamilies: Array<[string, Array<[string, Scored[]]>]> = [
    ["entry hour (ET)", tcell((t) => hourOf(t))],
    ["session part", tcell((t) => (inRTH(t.t) ? "RTH 9:30–16:00" : "Globex"))],
    ["day of week", tcell((t) => DOW[partsOf(t.date).dow])],
    ["month", tcell((t) => MONTHS[partsOf(t.date).m - 1])],
    ["turn of month", tcell((t) => (flags.get(t.date)!.lastOfMonth ? "last-day" : flags.get(t.date)!.first3OfMonth ? "first-3" : "mid-month"))],
    [
      "holiday window",
      tcell((t) => (flags.get(t.date)!.preHoliday ? "pre-holiday" : flags.get(t.date)!.postHoliday ? "post-holiday" : flags.get(t.date)!.earlyClose ? "early-close" : "regular")),
    ],
    ["OPEX", tcell((t) => (flags.get(t.date)!.opexDay ? "opex-day" : flags.get(t.date)!.opexWeek ? "opex-week" : "other"))],
    ["FOMC", tcell((t) => (flags.get(t.date)!.fomcDay ? "fomc-day" : flags.get(t.date)!.preFomc ? "pre-fomc-day" : "other"))],
  ];
  for (const [famName, cells] of cellFamilies) {
    for (const [name, tr] of cells) {
      const toEngine = (ts: Scored[]) => ts.map((t) => ({ date: t.date, pnl: t.pnl, risk: t.risk }));
      const s = coreStats(toEngine(tr));
      const sTr = coreStats(toEngine(tr.filter((t) => t.date < splitDate)));
      const sTe = coreStats(toEngine(tr.filter((t) => t.date >= splitDate)));
      t2rows.push({
        rule: `${famName}: ${name}`,
        n: s.n,
        wr: s.wr,
        ci: wilson95(s.wins, s.n),
        pf: s.pf,
        expPts: s.expPts,
        trainTest: `${sTr.wr.toFixed(0)}% / ${sTe.wr.toFixed(0)}%`,
        compare: `baseline ${eAll.wr.toFixed(0)}% WR`,
      });
    }
  }
  console.log("\n" + renderT2(t2rows));
  const viability = propViability(engineTrades, { splitDate });
  console.log("\n" + renderT4(viability));
  console.log(
    "\n" +
      renderVerdict({
        edge: eTest.netPts > 0 && eTest.expR > 0 ? "real" : "absent",
        significance: "—",
        stability: `train/test WR gap ${(eTrain.wr - eTest.wr).toFixed(1)} pts`,
        holdout: "n/a (validation pipeline)",
        viability:
          viability.pPass === null
            ? "n/a"
            : `${viability.pPass >= 0.9 ? "PASS" : viability.pPass >= 0.7 ? "weak" : "FAIL"} (P=${viability.pPass.toFixed(2)})`,
      }),
  );

  /* ---- dump ---- */

  if (o.dump) {
    const out = {
      generated: new Date().toISOString(),
      split,
      sessions: records.size,
      partA: {
        month: Object.fromEntries(fam((d) => MONTHS[partsOf(d).m - 1])),
        dow: Object.fromEntries(fam((d) => DOW[partsOf(d).dow])),
        turn: Object.fromEntries(fam((d) => (flags.get(d)!.lastOfMonth ? "last-day" : flags.get(d)!.first3OfMonth ? "first-3" : "mid-month"))),
        quarter: Object.fromEntries(fam((d) => (flags.get(d)!.quarterTurn ? "quarter-turn" : "mid-quarter"))),
        holiday: Object.fromEntries(fam((d) => (flags.get(d)!.preHoliday ? "pre-holiday" : flags.get(d)!.postHoliday ? "post-holiday" : flags.get(d)!.earlyClose ? "early-close" : "regular"))),
        opex: Object.fromEntries(fam((d) => (flags.get(d)!.opexDay ? "opex-day" : flags.get(d)!.opexWeek ? "opex-week" : "other"))),
        fomc: Object.fromEntries(fam((d) => (flags.get(d)!.fomcDay ? "fomc-day" : flags.get(d)!.preFomc ? "pre-fomc-day" : "other"))),
      },
      partB: Object.fromEntries(
        Array.from({ length: 24 }, (_, h) => {
          const rows = dates.filter((d) => records.get(d)!.hourLong[h] !== null);
          const vals = rows.map((d) => records.get(d)!.hourLong[h]!);
          const net = vals.map((v) => v - COST_PTS);
          return [h, { n: vals.length, up: dayStat(vals).up, grossMean: dayStat(vals).mean, netMean: dayStat(net).mean }];
        }),
      ),
      partC: {
        baseline: tradeStat(trades),
        hour: Object.fromEntries(tcell((t) => hourOf(t)).map(([k, v]) => [k, tradeStat(v)])),
        sessionPart: Object.fromEntries(tcell((t) => (inRTH(t.t) ? "rth" : "globex")).map(([k, v]) => [k, tradeStat(v)])),
        dow: Object.fromEntries(tcell((t) => DOW[partsOf(t.date).dow]).map(([k, v]) => [k, tradeStat(v)])),
        month: Object.fromEntries(tcell((t) => MONTHS[partsOf(t.date).m - 1]).map(([k, v]) => [k, tradeStat(v)])),
        turn: Object.fromEntries(tcell((t) => (flags.get(t.date)!.lastOfMonth ? "last-day" : flags.get(t.date)!.first3OfMonth ? "first-3" : "mid-month")).map(([k, v]) => [k, tradeStat(v)])),
        holiday: Object.fromEntries(tcell((t) => (flags.get(t.date)!.preHoliday ? "pre-holiday" : flags.get(t.date)!.postHoliday ? "post-holiday" : flags.get(t.date)!.earlyClose ? "early-close" : "regular")).map(([k, v]) => [k, tradeStat(v)])),
        opex: Object.fromEntries(tcell((t) => (flags.get(t.date)!.opexDay ? "opex-day" : flags.get(t.date)!.opexWeek ? "opex-week" : "other")).map(([k, v]) => [k, tradeStat(v)])),
        fomc: Object.fromEntries(tcell((t) => (flags.get(t.date)!.fomcDay ? "fomc-day" : flags.get(t.date)!.preFomc ? "pre-fomc-day" : "other")).map(([k, v]) => [k, tradeStat(v)])),
      },
    };
    await fs.writeFile(o.dump, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${o.dump}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
