/* ------------------------------------------------------------------ *
 * Limit → stop flip study (2026-10-26, lib/stopFlip.ts).
 *
 * Question: the live RTH limit entries lose — what if every resting
 * limit is sent as the OPPOSITE-side stop entry at the same price with
 * the bracket mirrored around it (buy limit @P → sell stop @P)?
 *
 * Families = every live limit-entry path (signalFeed):
 *   rth        detectSoftMomentum SOFT_PROD · limit AT the signal ·
 *              s0.5 / t2.5 (RTH_LIMIT_* defaults) · TTL 9
 *   flush      detectMomentum MOM_PROD kind=flush · limit AT the close ·
 *              ±1R from the limit · TTL 9 (FLUSH_LIMIT_BARS)
 *   expansion  detectMomentum kind=expansion ∪ detectExpansionScalp
 *              EXP_PROD (deduped d|dir|t like the feed) · limit 1 pt
 *              behind the close · ±1R · TTL 5 (EXP_RETRACE_*)
 *   bigbar     detectBigBar (first ≥100-pt bar) · flush path · ±1R · TTL 9
 *   all        every family's trades pooled (one account)
 * Each family is replayed independently (own one-at-a-time latch); the
 * live feed shares the flat gate across families, so "all" is an upper
 * bound on trade count. Crossed-stop dispatch gate, $1.90/RT fees,
 * $100-budget sizing, eval account sim, train < 2026-01-01 / OOS ≥.
 *
 * Arms (same signals, same trigger bars — a limit touch at P is exactly
 * a stop trigger at P on the opposite side):
 *   limit      baseline: fill at P or better (min/max of bar open, P)
 *   flip+0     stop entry: fill at P or WORSE (gap-through at bar open)
 *   flip+slip  stop entry + 0.25 / 0.5 / 1.0 pt extra adverse slip
 *              (a stop-market fills past the trigger in fast tape)
 * Exits are stop/target touch, then the 60-bar horizon close — identical
 * for every arm (no exit slippage in either; the limit arm's live losses
 * included stop slippage this model does not price for either side).
 *
 * Run from web/ (env GC_REMOTE_URL + DATABASE_URL):
 *   node --import ../scripts/ts-loader.mjs ./scripts/stopFlipStudy.ts
 * ------------------------------------------------------------------ */

import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectBigBar, type BigBarMinute } from "../lib/bigBar";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { dollarize, simulateAccount } from "../lib/propAccount";
import { stopCrossedAtDispatch } from "../lib/crossTrade";
import { coreStats, propViability, renderT1, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const HORIZON = 60;

/** a live limit-entry family: its signals and how the limit card is built */
type Family = {
  name: string;
  sigs: (m: MomMinute[]) => MomentumSignal[];
  /** limit price, stop distance, target distance (pts) from the limit */
  plan: (s: MomentumSignal) => { P: number; stopD: number; targetD: number };
  ttl: number;
};
const FAMILIES: Family[] = [
  {
    name: "rth",
    sigs: (m) => detectSoftMomentum(m, SOFT_PROD),
    plan: (s) => ({ P: s.entry, stopD: s.risk * 0.5, targetD: s.risk * 0.5 * 2.5 }),
    ttl: 9,
  },
  {
    name: "flush",
    sigs: (m) => detectMomentum(m, MOM_PROD).filter((s) => s.kind === "flush"),
    plan: (s) => ({ P: s.entry, stopD: s.risk, targetD: s.risk }),
    ttl: 9,
  },
  {
    name: "expansion",
    sigs: (m) => {
      const a = detectMomentum(m, MOM_PROD).filter((s) => s.kind === "expansion");
      const seen = new Set(a.map((x) => `${x.d}|${x.dir}|${x.t}`));
      return [...a, ...detectExpansionScalp(m, EXP_PROD).filter((x) => !seen.has(`${x.d}|${x.dir}|${x.t}`))];
    },
    plan: (s) => ({ P: s.entry - (s.dir === "long" ? 1 : -1) * 1.0, stopD: s.risk, targetD: s.risk }),
    ttl: 5,
  },
  {
    name: "bigbar",
    sigs: (m) => {
      const b = detectBigBar(m as unknown as BigBarMinute[]);
      return b ? [b] : [];
    },
    plan: (s) => ({ P: s.entry, stopD: s.risk, targetD: s.risk }),
    ttl: 9,
  },
];
const RISK_BUDGET = 100;
const FEE_RT = 1.9;
const SPLIT = "2026-01-01";

/** bracket geometry of the traded side, from the family's (stopD, targetD):
 *  orig = mirrored distances · 1R = stop distance both ways ·
 *  1Rw = target distance both ways · swap = SL ↔ TP distances */
type RR = "orig" | "1R" | "1Rw" | "swap";
/** honest = the fill bar's own adverse range counts (stop-first): a bar
 *  that touches the entry AND reaches the stop is a stop-out in that bar
 *  (the live 1–3 s stop-outs). The legacy rule scans from the next bar. */
type Arm = { name: string; flip: boolean; slip: number; rr: RR; honest?: boolean };
const ARMS: Arm[] = [
  { name: "limit (baseline)", flip: false, slip: 0, rr: "orig" },
  { name: "limit HONEST fill bar", flip: false, slip: 0, rr: "orig", honest: true },
  { name: "flip HONEST +0", flip: true, slip: 0, rr: "orig", honest: true },
  { name: "flip HONEST +0.25", flip: true, slip: 0.25, rr: "orig", honest: true },
  { name: "flip stop +0", flip: true, slip: 0, rr: "orig" },
  { name: "flip stop +0.25", flip: true, slip: 0.25, rr: "orig" },
  { name: "flip stop +0.5", flip: true, slip: 0.5, rr: "orig" },
  { name: "flip stop +1.0", flip: true, slip: 1.0, rr: "orig" },
  { name: "limit 1R", flip: false, slip: 0, rr: "1R" },
  { name: "flip 1R +0", flip: true, slip: 0, rr: "1R" },
  { name: "flip 1R +0.25", flip: true, slip: 0.25, rr: "1R" },
  { name: "limit 1R wide", flip: false, slip: 0, rr: "1Rw" },
  { name: "flip 1R wide +0", flip: true, slip: 0, rr: "1Rw" },
  { name: "flip 1R wide +0.25", flip: true, slip: 0.25, rr: "1Rw" },
  { name: "flip swapRR +0", flip: true, slip: 0, rr: "swap" },
  { name: "flip swapRR +0.25", flip: true, slip: 0.25, rr: "swap" },
];

type Trade = { date: string; pnl: number; risk: number };
const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

function score(minutes: MomMinute[], sigs: MomentumSignal[], date: string, arm: Arm, fam: Family): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of [...sigs].sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (s.entryIdx <= openUntil) continue;
    if (!(s.risk > 0)) continue;
    const { P, stopD, targetD } = fam.plan(s);
    const sigDir = s.dir === "long" ? 1 : -1;
    if (!(stopD > 0 && targetD > 0)) continue;
    // traded side + bracket (orig = mirrored around P under the flip)
    const dir = arm.flip ? -sigDir : sigDir;
    const [sd, td] =
      arm.rr === "1R" ? [stopD, stopD] : arm.rr === "1Rw" ? [targetD, targetD] : arm.rr === "swap" ? [targetD, stopD] : [stopD, targetD];
    const risk = sd;
    const stop = P - dir * sd;
    const target = P + dir * td;

    const nb = minutes[s.entryIdx + 1];
    if (nb && stopCrossedAtDispatch(dir > 0 ? "long" : "short", stop, midOf(nb)) === true) continue;

    // trigger: price trades to P on the approach side (the limit touch)
    const endTtl = Math.min(minutes.length - 1, s.entryIdx + fam.ttl);
    let fillBar = -1;
    let fill = 0;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      const touched = sigDir > 0 ? b.low <= P : b.high >= P;
      if (!touched) continue;
      fillBar = j;
      const open = openOf(b);
      if (!arm.flip) {
        fill = sigDir > 0 ? Math.min(open, P) : Math.max(open, P); // limit: at or better
      } else {
        // stop: at or worse (gap-through at the open) + adverse slip
        fill = dir > 0 ? Math.max(open, P) + arm.slip : Math.min(open, P) - arm.slip;
      }
      break;
    }
    if (fillBar < 0) continue;

    const end = Math.min(minutes.length - 1, s.entryIdx + HORIZON);
    let exit = closeOf(minutes[end]);
    // exits scan from the bar AFTER the fill for every arm (same rule as
    // rthLimitValidation — the fill bar's own range is not attributed)
    for (let j = arm.honest ? fillBar : fillBar + 1; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) {
        exit = stop;
        break;
      }
      // a target on the fill bar itself is not credited (order unknown)
      if (j > fillBar && (dir > 0 ? b.high >= target : b.low <= target)) {
        exit = target;
        break;
      }
    }
    out.push({ date, pnl: (exit - fill) * dir, risk });
    openUntil = s.entryIdx + HORIZON;
  }
  return out;
}

function usd(trades: Trade[]) {
  const rows = trades.map((t) => {
    const contracts = Math.max(1, Math.min(30, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnl, riskPts: t.risk, pnlUsd: t.pnl * contracts * 2 - contracts * FEE_RT };
  });
  const acc = simulateAccount(dollarize(rows.map((r) => ({ date: r.date, pnlPts: r.pnlPts, riskPts: r.riskPts }))), "eval");
  let peak = 0;
  let maxDD = 0;
  for (const d of acc.days) {
    peak = Math.max(peak, d.equity);
    maxDD = Math.min(maxDD, d.equity - peak);
  }
  return { netUsd: rows.reduce((a, r) => a + r.pnlUsd, 0), maxDD, passed: acc.breachDay === null };
}

async function main() {
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const groups = [...FAMILIES.map((f) => f.name), "all"];
  const per = new Map<string, Trade[]>();
  for (const g of groups) for (const a of ARMS) per.set(`${g}|${a.name}`, []);
  console.log(`replaying ${dates.length} sessions × ${FAMILIES.length} families × ${ARMS.length} arms…`);
  const t0 = Date.now();
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      for (const f of FAMILIES) {
        const sigs = f.sigs(minutes);
        for (const a of ARMS) {
          const ts = score(minutes, sigs, date, a, f);
          per.get(`${f.name}|${a.name}`)!.push(...ts);
          per.get(`all|${a.name}`)!.push(...ts);
        }
      }
    }
  }
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s\n`);

  for (const g of groups) {
    console.log(`\n################ FAMILY: ${g} ################`);
    console.log("=== T1 CORE QUALITY (gross pts; fees in the $ column below) ===");
    const t1: { label: string; stats: ReturnType<typeof coreStats> }[] = [];
    for (const a of ARMS) {
      const ts: EngineTrade[] = per.get(`${g}|${a.name}`)!;
      t1.push({ label: `${a.name} · all`, stats: coreStats(ts) });
      t1.push({ label: `${a.name} · train`, stats: coreStats(ts.filter((t) => t.date < SPLIT)) });
      t1.push({ label: `${a.name} · test`, stats: coreStats(ts.filter((t) => t.date >= SPLIT)) });
    }
    console.log(renderT1(t1));
    console.log("\n=== $ ACCOUNT SIM (eval, $100 budget, $1.90/RT) ===");
    for (const a of ARMS) {
      const ts = per.get(`${g}|${a.name}`)!;
      if (!ts.length) {
        console.log(`${a.name.padEnd(18)} | no trades`);
        continue;
      }
      const all = usd(ts);
      const tr = usd(ts.filter((t) => t.date < SPLIT));
      const te = usd(ts.filter((t) => t.date >= SPLIT));
      console.log(
        `${a.name.padEnd(18)} | all $${all.netUsd.toFixed(0).padStart(8)} dd $${all.maxDD.toFixed(0).padStart(7)} ${all.passed ? "PASS" : "BREACH"}` +
          ` · train $${tr.netUsd.toFixed(0).padStart(8)} ${tr.passed ? "PASS" : "BREACH"} · OOS $${te.netUsd.toFixed(0).padStart(7)} dd $${te.maxDD.toFixed(0).padStart(6)} ${te.passed ? "PASS" : "BREACH"}`,
      );
    }
    for (const k of [0, 2]) {
      const ts = per.get(`${g}|${ARMS[k].name}`)!;
      if (!ts.length) continue;
      const v = propViability(ts, { splitDate: SPLIT });
      console.log(`\n=== T4 PROP VIABILITY — ${g} · ${ARMS[k].name} ===`);
      console.log(renderT4(v));
      const trS = coreStats(ts.filter((t) => t.date < SPLIT));
      const teS = coreStats(ts.filter((t) => t.date >= SPLIT));
      console.log(
        renderVerdict({
          edge: teS.netPts > 0 && teS.expR > 0 ? "real" : "absent",
          significance: "—",
          stability: `train/test WR gap ${(trS.wr - teS.wr).toFixed(1)} pts`,
          holdout: "OOS ≥ 2026-01-01",
          viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
        }),
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
