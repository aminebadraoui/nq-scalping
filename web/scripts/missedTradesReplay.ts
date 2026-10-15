/* ------------------------------------------------------------------ *
 * MISSED-TRADES REPLAY (SCRATCH — NOT COMMITTED)
 *
 * For the recent window (RTH dates 2026-10-08 .. 2026-10-15), run the
 * CURRENT live strategy set over each session's footprint minutes and
 * replay every detector card under the live bracket/entry mechanics:
 *
 *   flush      detectMomentum(MOM_PROD)     → resting limit AT the signal
 *               close, TTL 9 min (flushLimit arm, momentumEntryMechanics
 *               study 2026-10-14). Fill-or-better at bar open. Brackets
 *               rebuilt from the fill: structural risk, 1R target.
 *   expansion  detectExpansionScalp(EXP_PROD) → resting limit 1 pt behind
 *               the close, TTL 5 min (EXP_RETRACE). Brackets from fill.
 *   rth        detectSoftMomentum(SOFT_PROD) → resting limit at the signal
 *               close, TTL 9 min, 0.5× structural stop, 2.5R target,
 *               60-bar horizon, crossed-stop dispatch gate (bar+1 mid).
 *   open_drive detectOpenDrive(OPEN_PROD)   → marketable at the close,
 *               fixed TP +15 / SL −35.
 *
 * Sequencing context (labels only — every card is still replayed
 * standalone): one-position-at-a-time occupancy (60-bar window), the
 * momentum cross-kind 5-bar gap, news blackout, and the 2026-10-15
 * stale-signal-veto bug window (08:03–10:35 ET).
 *
 * Each card is joined against the live Neon `signals` (day = RTH
 * calendar date) + `trades` (day = evening-start date) to tag its live
 * fate: executed / unexecuted (no-fill) / never-sent.
 *
 * Output: per-session tape stats + full card tables + the missed-
 * beautiful summary (replay win + live missed).
 *
 * Run from web/:
 *   node --env-file=.env.local --import ../scripts/ts-loader.mjs \
 *     scripts/missedTradesReplay.ts
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { loadSessionMinutes } from "../lib/archive";
import {
  detectMomentum,
  detectExpansionScalp,
  MOM_PROD,
  EXP_PROD,
  closeOf,
  midOf,
  type MomMinute,
  type MomentumSignal,
} from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectOpenDrive, OPEN_PROD } from "../lib/openDrive";
import { newsBlockedAt, NEWS_EVENTS } from "../lib/newsGate";
import { momentumSize } from "../lib/propRules";

const DATES = (process.env.REPLAY_DATES ?? "2026-10-08,2026-10-09,2026-10-12,2026-10-13,2026-10-14,2026-10-15").split(",").map((d) => d.trim());
const LOCAL_DATA = path.resolve(process.cwd(), "..", "gcdata", "data");
const FLUSH_TTL = 9;
const EXP_TTL = 5;
const RTH_TTL = 9;
const RTH_STOP_MULT = 0.5;
const RTH_TARGET_R = 2.5;
const HORIZON = 60;
const VETO_START = 8 * 60 + 3; // 08:03 ET
const VETO_END = 10 * 60 + 35; // 10:35 ET

type Bar = { t: string; o: number; c: number; high: number; low: number };
const openOf = (b: Bar): number => (b.o > 0 ? b.o : midOfBar(b));
const closeOfBar = (b: Bar): number => (b.c > 0 ? b.c : (b.high + b.low) / 2);
const midOfBar = (b: Bar): number => (b.high + b.low) / 2;
const etMin = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const ctToEt = (t: string): string => {
  const h = Number(t.slice(0, 2));
  return `${String((h + 1) % 24).padStart(2, "0")}:${t.slice(3, 5)}`;
};

/* ---------------- data loaders ---------------- */

/** local vendor-pulled file (2026-10-14/15) — mirrors lib/archive parseRaw,
 *  tolerant of partial sessions */
function loadLocalMinutes(date: string): MomMinute[] | null {
  try {
    const raw = readFileSync(path.join(LOCAL_DATA, `${date}_ETH.json`), "utf8");
    const j = JSON.parse(raw) as {
      candles?: { t: string; high: number; low: number; buy: number; sell: number; levels?: Record<string, [number, number, number, number, number]> }[];
    };
    const candles = j.candles ?? [];
    if (candles.length < 60) return null;
    return candles.map((c) => ({
      t: c.t.slice(11, 16),
      d: c.t.slice(0, 10),
      o: 0,
      c: 0,
      high: c.high / 100,
      low: c.low / 100,
      buy: c.buy,
      sell: c.sell,
      levels: Object.entries(c.levels ?? {}).map(([p, v]) => ({
        price: Number(p) / 100,
        buy: v[1],
        sell: v[2],
      })),
    }));
  } catch {
    return null;
  }
}

/** Neon candles_1m → OHLC twin keyed by America/Chicago "HH:mm".
 *  Window = exactly the ETH session: (date−1) 17:00 CT → +24 h. */
async function neonOhlc(sql: postgres.Sql, date: string): Promise<Map<string, Bar>> {
  const d0 = new Date(`${date}T00:00:00-05:00`);
  d0.setUTCDate(d0.getUTCDate() - 1);
  const t0 = new Date(d0.getTime() + 17 * 3600_000);
  const t1 = new Date(t0.getTime() + 24 * 3600_000);
  const rows = await sql`
    select ts, o::float8 o, h::float8 h, l::float8 l, c::float8 c
    from candles_1m where ts >= ${t0} and ts < ${t1} order by ts`;
  const out = new Map<string, Bar>();
  for (const r of rows) {
    const ct = new Date(r.ts).toLocaleString("en-US", { timeZone: "America/Chicago", hour12: false });
    const t = ct.slice(12, 17);
    out.set(t, { t, o: Number(r.o), c: Number(r.c), high: Number(r.h), low: Number(r.l) });
  }
  return out;
}

function joinOhlc(minutes: MomMinute[], twin: Map<string, Bar>): void {
  let missing = 0;
  for (const m of minutes) {
    const b = twin.get(m.t);
    if (b) {
      m.o = b.o;
      m.c = b.c;
    } else missing++;
  }
  if (missing > 0) console.log(`    ohlc join: ${missing}/${minutes.length} minutes without a twin bar (mid fallback)`);
}

/* ---------------- replay machinery ---------------- */

type Replay = {
  fillBar: number;
  fill: number;
  stop: number;
  target: number;
  hit: "target" | "stop" | "time" | "no-fill" | "gate-skip";
  exit: number;
  exitIdx: number;
  pts: number; // gross
  bars: number;
  mae: number;
  mfe: number;
};

function limitFill(bars: Bar[], from: number, ttl: number, dir: 1 | -1, level: number): { fillBar: number; fill: number } | null {
  const end = Math.min(bars.length - 1, from + ttl);
  for (let j = from; j <= end; j++) {
    const b = bars[j];
    const touched = dir > 0 ? b.low <= level : b.high >= level;
    if (!touched) continue;
    const open = openOf(b);
    const fill = dir > 0 ? Math.min(open, level) : Math.max(open, level);
    return { fillBar: j, fill };
  }
  return null;
}

/** stop-first scan; sameBar starts the scan at the fill bar itself */
function exitScan(bars: Bar[], startIdx: number, dir: 1 | -1, stop: number, target: number, horizonIdx: number): { hit: "target" | "stop" | "time"; exit: number; exitIdx: number; mae: number; mfe: number } {
  let mae = 0;
  let mfe = 0;
  const end = Math.min(bars.length - 1, horizonIdx);
  for (let j = startIdx; j <= end; j++) {
    const b = bars[j];
    if (dir > 0) {
      mae = Math.max(mae, 0);
      if (b.low <= stop) return { hit: "stop", exit: stop, exitIdx: j, mae: 0, mfe: 0 };
      if (b.high >= target) return { hit: "target", exit: target, exitIdx: j, mae: 0, mfe: 0 };
    } else {
      if (b.high >= stop) return { hit: "stop", exit: stop, exitIdx: j, mae: 0, mfe: 0 };
      if (b.low <= target) return { hit: "target", exit: target, exitIdx: j, mae: 0, mfe: 0 };
    }
  }
  const exit = closeOfBar(bars[end]);
  return { hit: "time", exit, exitIdx: end, mae, mfe };
}

/** replay one limit-entry card (flush / expansion / rth share this shape) */
function replayLimitCard(bars: Bar[], s: MomentumSignal, kind: "flush" | "expansion" | "rth", level: number, ttl: number, stopMult: number, targetR: number, sameBar: boolean): Replay {
  const dir = s.dir === "long" ? 1 : -1;
  const from = s.entryIdx + 1;
  const f = limitFill(bars, from, ttl, dir, level);
  if (!f) {
    return { fillBar: -1, fill: 0, stop: 0, target: 0, hit: "no-fill", exit: 0, exitIdx: 0, pts: 0, bars: 0, mae: 0, mfe: 0 };
  }
  const risk = s.risk * stopMult;
  const stop = f.fill - dir * risk;
  const target = f.fill + dir * risk * targetR;
  // crossed-stop dispatch gate (rth only, live 2026-10-08 incident fix):
  // the tape already through the bracket stop at dispatch → no order
  if (kind === "rth") {
    const nb = bars[s.entryIdx + 1];
    if (nb) {
      const crossed = dir > 0 ? midOfBar(nb) <= stop : midOfBar(nb) >= stop;
      if (crossed) {
        return { fillBar: f.fillBar, fill: f.fill, stop, target, hit: "gate-skip", exit: 0, exitIdx: 0, pts: 0, bars: 0, mae: 0, mfe: 0 };
      }
    }
  }
  const start = sameBar ? f.fillBar : f.fillBar + 1;
  const horizon = s.entryIdx + HORIZON;
  const sc = exitScan(bars, start, dir, stop, target, horizon);
  if (sc.hit === "time") {
    // MAE/MFE over the hold
    let mae = 0;
    let mfe = 0;
    for (let j = start; j <= sc.exitIdx; j++) {
      const b = bars[j];
      if (dir > 0) {
        mae = Math.max(mae, f.fill - b.low);
        mfe = Math.max(mfe, b.high - f.fill);
      } else {
        mae = Math.max(mae, b.high - f.fill);
        mfe = Math.max(mfe, f.fill - b.low);
      }
    }
    sc.mae = mae;
    sc.mfe = mfe;
  }
  const pts = (sc.exit - f.fill) * dir;
  return { fillBar: f.fillBar, fill: f.fill, stop, target, hit: sc.hit, exit: sc.exit, exitIdx: sc.exitIdx, pts, bars: sc.exitIdx - f.fillBar, mae: sc.mae, mfe: sc.mfe };
}

function replayMarketCard(bars: Bar[], s: MomentumSignal, tpPts: number, slPts: number): Replay {
  const dir = s.dir === "long" ? 1 : -1;
  const fill = s.entry;
  const stop = fill - dir * slPts;
  const target = fill + dir * tpPts;
  const sc = exitScan(bars, s.entryIdx + 1, dir, stop, target, bars.length - 1);
  const pts = (sc.exit - fill) * dir;
  return { fillBar: s.entryIdx, fill, stop, target, hit: sc.hit, exit: sc.exit, exitIdx: sc.exitIdx, pts, bars: sc.exitIdx - s.entryIdx, mae: sc.mae, mfe: sc.mfe };
}

type Card = {
  date: string;
  family: string;
  dir: "long" | "short";
  tET: string;
  entryIdx: number;
  entry: number;
  risk: number;
  rep: Replay;
  live: "executed" | "unexecuted" | "never-sent" | "decided-no-fill";
  liveOutcome: string;
  liveFill: number | null;
  liveExit: number | null;
  livePts: number | null;
  gates: string[];
};

/* ---------------- live join (Neon) ---------------- */

const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 2 });

type LiveSig = { day: string; time_et: string; side: string; price: number; verdict: string; outcome: string; mfe: number; mae: number };
type LiveTr = { day: string; time_et: string; side: string; status: string; result: string; fill: number | null; exit: number | null; pts: number | null };

async function loadLive(): Promise<{ sigs: LiveSig[]; trades: LiveTr[] }> {
  const sigRows = await sql`
    select day, time_et, side, price::float8 price, verdict, outcome,
           coalesce(mfe_pts::float8, 0) mfe, coalesce(mae_pts::float8, 0) mae
    from signals where day in ${sql(DATES)} order by ts`;
  const tradeDays = DATES.map((d) => {
    const x = new Date(`${d}T12:00:00-05:00`);
    x.setUTCDate(x.getUTCDate() - 1);
    return x.toISOString().slice(0, 10);
  });
  const trRows = await sql`
    select day, time_et, side, status, result, fill_entry::float8 fill, exit_avg::float8 exit, gross_pts::float8 pts
    from trades where day in ${sql(tradeDays)} order by ts`;
  return {
    sigs: sigRows.map((r) => ({ day: String(r.day), time_et: String(r.time_et), side: String(r.side), price: Number(r.price), verdict: String(r.verdict), outcome: String(r.outcome ?? ""), mfe: Number(r.mfe), mae: Number(r.mae) })),
    trades: trRows.map((r) => ({ day: String(r.day), time_et: String(r.time_et), side: String(r.side), status: String(r.status), result: String(r.result ?? ""), fill: r.fill === null ? null : Number(r.fill), exit: r.exit === null ? null : Number(r.exit), pts: r.pts === null ? null : Number(r.pts) })),
  };
}

/* ---------------- session tape stats ---------------- */

function tapeStats(bars: Bar[], minutes: MomMinute[]): string[] {
  const out: string[] = [];
  const o = openOf(bars[0]);
  const c = closeOfBar(bars[bars.length - 1]);
  let hi = -Infinity;
  let lo = Infinity;
  let hiT = "";
  let loT = "";
  let totVol = 0;
  let buyVol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (b.high > hi) {
      hi = b.high;
      hiT = b.t;
    }
    if (b.low < lo) {
      lo = b.low;
      loT = b.t;
    }
    totVol += minutes[i].buy + minutes[i].sell;
    buyVol += minutes[i].buy;
  }
  out.push(`session ${bars[0].t} → ${bars[bars.length - 1].t} · ${bars.length} bars · open ${o.toFixed(2)} close ${c.toFixed(2)} (${(c - o >= 0 ? "+" : "")}${(c - o).toFixed(0)} pts)`);
  out.push(`range ${(hi - lo).toFixed(0)} pts · high ${hi.toFixed(2)} @${hiT}CT · low ${lo.toFixed(2)} @${loT}CT · vol ${totVol} · buy-frac ${((buyVol / totVol) * 100).toFixed(1)}%`);
  // biggest bars
  const big = bars
    .map((b, i) => ({ b, i, r: b.high - b.low }))
    .sort((x, y) => y.r - x.r)
    .slice(0, 5);
  out.push(`biggest bars: ${big.map((x) => `${x.b.t} ${x.r.toFixed(1)}pts`).join(" · ")}`);
  return out;
}

/* ---------------- main ---------------- */

async function main() {
  const { sigs, trades } = await loadLive();
  console.log(`live context: ${sigs.length} signals · ${trades.length} trade rows for ${DATES.join(", ")}\n`);

  const allCards: Card[] = [];

  for (const date of DATES) {
    let fp: MomMinute[];
    if (date >= "2026-10-14") {
      fp = loadLocalMinutes(date)!;
      const twin = await neonOhlc(sql, date);
      joinOhlc(fp, twin);
    } else {
      fp = (await loadSessionMinutes(date, { withOhlc: true }))!;
    }
    const bars: Bar[] = fp.map((m) => ({ t: m.t, o: m.o, c: m.c, high: m.high, low: m.low }));
    console.log(`\n########## ${date} ##########`);
    for (const l of tapeStats(bars, fp)) console.log(`  ${l}`);

    const flush = detectMomentum(fp, MOM_PROD).filter((s) => s.kind === "flush");
    const exp = detectExpansionScalp(fp, EXP_PROD);
    const rth = detectSoftMomentum(fp, SOFT_PROD);
    const open = detectOpenDrive(fp, OPEN_PROD);

    const cards: Card[] = [];
    const add = (family: string, s: MomentumSignal, rep: Replay) => {
      const tET = ctToEt(s.t);
      cards.push({
        date,
        family,
        dir: s.dir,
        tET,
        entryIdx: s.entryIdx,
        entry: s.entry,
        risk: s.risk,
        rep,
        live: "never-sent",
        liveOutcome: "",
        liveFill: null,
        liveExit: null,
        livePts: null,
        gates: [],
      });
    };

    for (const s of flush) add("flush", s, replayLimitCard(bars, s, "flush", s.entry, FLUSH_TTL, 1, 1, true));
    for (const s of exp) add("expansion", s, replayLimitCard(bars, s, "expansion", s.entry - (s.dir === "long" ? 1 : -1) * 1, EXP_TTL, 1, 1, true));
    for (const s of rth) add("rth", s, replayLimitCard(bars, s, "rth", s.entry, RTH_TTL, RTH_STOP_MULT, RTH_TARGET_R, false));
    for (const s of open) add("open_drive", s, replayMarketCard(bars, s, 15, 35));

    /* --- live join ---
     * signals.day = the NY calendar date the card printed (evening cards
     * before 18:00 ET keep the session's start date; cards from 18:00 ET
     * on roll to the next calendar date). trades.day = the session's
     * evening-start date (always `date` − 1 day for a RTH-date session). */
    const nyDayOf = (tET: string): string => {
      const h = Number(tET.slice(0, 2));
      if (h >= 18) {
        const d = new Date(`${date}T12:00:00-05:00`);
        d.setUTCDate(d.getUTCDate() - 1);
        return d.toISOString().slice(0, 10);
      }
      return date;
    };
    const sigBy = (t: string, side: string) =>
      sigs.find((x) => x.day === nyDayOf(t) && x.time_et === t && x.side === side);
    const trBy = (t: string, side: string) => {
      const d = new Date(`${date}T12:00:00-05:00`);
      d.setUTCDate(d.getUTCDate() - 1);
      const tday = d.toISOString().slice(0, 10);
      return trades.find((x) => x.day === tday && x.time_et === t && x.side === side);
    };
    for (const c of cards) {
      const s = sigBy(c.tET, c.dir);
      const t = trBy(c.tET, c.dir);
      if (s) {
        const fam = s.verdict.toLowerCase();
        const liveFam = fam.includes("rth") ? "rth" : fam.includes("open") ? "open_drive" : fam.includes("expansion") ? "expansion" : "flush";
        if (liveFam !== c.family) c.gates.push(`live-family:${liveFam}`);
        c.liveOutcome = s.outcome;
        if (t && t.status === "matched" && t.fill !== null) {
          c.live = "executed";
          c.liveFill = t.fill;
          c.liveExit = t.exit;
          c.livePts = t.pts;
        } else if (t && (t.status === "unexecuted" || t.status === "expired" || t.status === "gate_skip")) {
          c.live = "unexecuted";
        } else if (s.outcome === "win" || s.outcome === "loss") {
          c.live = "decided-no-fill";
        }
      }
    }

    /* --- suppression labels --- */
    for (const c of cards) {
      const hm = etMin(c.tET);
      if (date === "2026-10-15" && hm >= VETO_START && hm <= VETO_END) c.gates.push("veto-bug");
      if (newsBlockedAt(NEWS_EVENTS, date, Number(c.tET.slice(0, 2)), Number(c.tET.slice(3, 5)))) c.gates.push("news");
    }
    // momentum cross-kind 5-bar gap (live: one momentum card family)
    const mom = cards.filter((c) => c.family === "flush" || c.family === "expansion").sort((a, b) => a.entryIdx - b.entryIdx);
    let lastMom = -10_000;
    for (const c of mom) {
      if (c.entryIdx - lastMom < 5) c.gates.push("mom-gap");
      else lastMom = c.entryIdx;
    }
    // one-position-at-a-time occupancy (60-bar window, filled cards only)
    const seq = [...cards].sort((a, b) => a.entryIdx - b.entryIdx);
    let openUntil = -1;
    for (const c of seq) {
      if (c.entryIdx < openUntil) c.gates.push("occupied");
      else if (c.rep.fillBar >= 0) openUntil = c.entryIdx + HORIZON;
    }

    /* --- table --- */
    console.log(`\n  ${cards.length} detector cards (flush ${flush.length} · expansion ${exp.length} · rth ${rth.length} · open ${open.length}):`);
    console.log("  tET     fam        dir    entry      risk   outcome      pts     fill    mae    live");
    for (const c of cards.sort((a, b) => a.entryIdx - b.entryIdx)) {
      const r = c.rep;
      const res = r.hit === "no-fill" ? "no-fill" : r.hit === "gate-skip" ? "gate-skip" : `${r.hit}${r.pts >= 0 ? "+" : ""}${r.pts.toFixed(1)}`;
      const liveTxt = c.live === "executed" ? `EXEC ${c.liveOutcome} ${c.livePts !== null ? (c.livePts >= 0 ? "+" : "") + c.livePts.toFixed(1) : ""}` : c.live === "unexecuted" ? "UNEXEC" : c.live === "decided-no-fill" ? `decided ${c.liveOutcome}` : `—${c.gates.length ? " [" + c.gates.join(",") + "]" : ""}`;
      console.log(
        `  ${c.tET.padEnd(7)} ${c.family.padEnd(10)} ${c.dir.padEnd(6)} ${c.entry.toFixed(2).padStart(9)} ${c.risk.toFixed(1).padStart(5)}  ${res.padStart(9)} ${(r.hit !== "no-fill" && r.hit !== "gate-skip" ? r.pts.toFixed(1) : "0.0").padStart(7)} ${r.fillBar >= 0 ? r.fill.toFixed(2) : "—".padStart(7)} ${r.mae.toFixed(1).padStart(5)}  ${liveTxt}`,
      );
    }
    allCards.push(...cards);
  }

  /* --- missed-beautiful summary --- */
  const missed = allCards.filter((c) => c.rep.hit === "target" && (c.live === "never-sent" || c.live === "unexecuted" || c.live === "decided-no-fill"));
  missed.sort((a, b) => b.rep.pts - a.rep.pts);
  console.log(`\n\n########## MISSED BEAUTIFUL (replay target hit, not live-executed) — ${missed.length} ##########`);
  for (const c of missed) {
    const usd = c.family === "open_drive" ? 0 : (c.rep.pts - 0.95) * 2 * momentumSize(c.risk * (c.family === "rth" ? RTH_STOP_MULT : 1), 100).contracts;
    console.log(`${c.date} ${c.tET} ${c.family.padEnd(10)} ${c.dir.padEnd(6)} entry ${c.entry.toFixed(2)} → ${c.rep.exit.toFixed(2)} +${c.rep.pts.toFixed(1)} pts · ${c.rep.bars}b · mae ${c.rep.mae.toFixed(1)} · live=${c.live}${c.gates.length ? " [" + c.gates.join(",") + "]" : ""} · ~$${usd.toFixed(0)}`);
  }

  /* --- caught context --- */
  const caught = allCards.filter((c) => c.live === "executed");
  const cw = caught.filter((c) => (c.livePts ?? 0) > 0);
  const cl = caught.filter((c) => (c.livePts ?? 0) <= 0);
  console.log(`\nLIVE CAUGHT: ${caught.length} executed (${cw.length} green · ${cl.length} red)`);

  await sql.end();
}

main().catch((e) => {
  console.error("missedTradesReplay failed:", e);
  process.exit(1);
});
