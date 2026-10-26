/* ------------------------------------------------------------------ *
 * Limit-entry fix study (2026-10-26) — can every live limit family be
 * made fundable WITHOUT turning any of them off?
 *
 * Context: docs/research/limit-stop-flip-2026-10-26.md — the live audit
 * showed the limit backtests skipped the fill bar (stop-outs inside the
 * fill minute were invisible); scored honestly the RTH limit edge is
 * ~breakeven and momentum is slightly negative.
 *
 * HONEST scoring everywhere: the fill bar's adverse range counts
 * (stop-first), no target credit on a resting-limit fill bar, 60-bar
 * time exit, $1.90/RT per contract, $100-budget sizing, eval sim.
 *
 * Levers (all implementable in the live executor, no family disabled):
 *   stop   stop distance as a multiple of the signal risk
 *   tgt    target in R of that stop
 *   entry  limit    rest at the family's limit price (today)
 *          cancel   limit, cancelled if the target prints before a fill
 *          deep     limit 0.25 × risk further away (better price)
 *          confirm  touch the price, wait for the touch bar to CLOSE back
 *                   on the signal side, then market-in at the next open
 *                   (+0.25 pt slip) — dodges the fill-minute blow-through
 * Selection on train (< 2026-01-01) — PASS + PF ≥ 1.1 + net $ > 0 — and
 * the pick is reported OOS. The number of configs tried is printed
 * (multiple-testing: treat picks as research input until a holdout).
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs ./scripts/limitFixStudy.ts [--ohlc-dir ../gcdata/data/ohlc_hist --real-only]
 * ------------------------------------------------------------------ */

import fs from "node:fs";
import { loadSessionMinutes, archiveDates } from "../lib/archive";
import { closeOf, midOf, detectMomentum, detectExpansionScalp, MOM_PROD, EXP_PROD, type MomMinute, type MomentumSignal } from "../lib/momentum";
import { detectSoftMomentum, SOFT_PROD } from "../lib/softMomentum";
import { detectBigBar, type BigBarMinute } from "../lib/bigBar";
import { stopCrossedAtDispatch } from "../lib/crossTrade";
import { coreStats, propViability, renderT1, renderT4, renderVerdict, type EngineTrade } from "../lib/backtestEngine";

const CONCURRENCY = 8;
const HORIZON = 60;
const RISK_BUDGET = 100;
const FEE_RT = 1.9;
const SPLIT = "2026-01-01";
const CONFIRM_SLIP = 0.25;

const argv = process.argv.slice(2);
const OHLC_DIR = argv.includes("--ohlc-dir") ? argv[argv.indexOf("--ohlc-dir") + 1] : "";
const REAL_ONLY = argv.includes("--real-only");

type Entry = "limit" | "cancel" | "deep" | "confirm";
type Cfg = { stop: number; tgt: number; entry: Entry };
type Family = {
  name: string;
  sigs: (m: MomMinute[]) => MomentumSignal[];
  /** the live limit price for a signal */
  price: (s: MomentumSignal) => number;
  ttl: number;
  /** today's live config */
  live: Cfg;
  stops: number[];
};
const FAMILIES: Family[] = [
  {
    name: "rth",
    sigs: (m) => detectSoftMomentum(m, SOFT_PROD),
    price: (s) => s.entry,
    ttl: 9,
    live: { stop: 0.5, tgt: 2.5, entry: "limit" },
    stops: [0.5, 0.75, 1.0, 1.5],
  },
  {
    name: "flush",
    sigs: (m) => detectMomentum(m, MOM_PROD).filter((s) => s.kind === "flush"),
    price: (s) => s.entry,
    ttl: 9,
    live: { stop: 1, tgt: 1, entry: "limit" },
    stops: [0.75, 1.0, 1.5, 2.0],
  },
  {
    name: "expansion",
    sigs: (m) => {
      const a = detectMomentum(m, MOM_PROD).filter((s) => s.kind === "expansion");
      const seen = new Set(a.map((x) => `${x.d}|${x.dir}|${x.t}`));
      return [...a, ...detectExpansionScalp(m, EXP_PROD).filter((x) => !seen.has(`${x.d}|${x.dir}|${x.t}`))];
    },
    price: (s) => s.entry - (s.dir === "long" ? 1 : -1) * 1.0,
    ttl: 5,
    live: { stop: 1, tgt: 1, entry: "limit" },
    stops: [0.75, 1.0, 1.5, 2.0],
  },
  {
    name: "bigbar",
    sigs: (m) => {
      const b = detectBigBar(m as unknown as BigBarMinute[]);
      return b ? [b] : [];
    },
    price: (s) => s.entry,
    ttl: 9,
    live: { stop: 1, tgt: 1, entry: "limit" },
    stops: [0.5, 0.75, 1.0, 1.5],
  },
];
const TGTS = [1.0, 1.5, 2.0, 2.5];
const ENTRIES: Entry[] = ["limit", "cancel", "deep", "confirm"];

type Trade = { date: string; pnl: number; risk: number };
const openOf = (m: MomMinute): number => (m.o > 0 ? m.o : midOf(m));

function score(minutes: MomMinute[], sigs: MomentumSignal[], date: string, fam: Family, c: Cfg): Trade[] {
  const out: Trade[] = [];
  let openUntil = -1;
  for (const s of [...sigs].sort((a, b) => a.entryIdx - b.entryIdx)) {
    if (s.entryIdx <= openUntil || !(s.risk > 0)) continue;
    const dir = s.dir === "long" ? 1 : -1;
    const sd = s.risk * c.stop;
    const td = sd * c.tgt;
    const P0 = fam.price(s);
    const P = c.entry === "deep" ? P0 - dir * 0.25 * s.risk : P0;
    // live dispatch gate (the OSO stop built from the limit price)
    const nb = minutes[s.entryIdx + 1];
    if (c.entry !== "confirm" && nb && stopCrossedAtDispatch(s.dir, P - dir * sd, midOf(nb)) === true) continue;

    const endTtl = Math.min(minutes.length - 1, s.entryIdx + fam.ttl);
    let fillBar = -1;
    let fill = 0;
    let targetCreditFromFillBar = false;
    for (let j = s.entryIdx + 1; j <= endTtl; j++) {
      const b = minutes[j];
      if (c.entry === "cancel" && (dir > 0 ? b.high >= P + td : b.low <= P - td)) break; // ran to target unfilled → cancel
      const touched = dir > 0 ? b.low <= P : b.high >= P;
      if (!touched) continue;
      if (c.entry === "confirm") {
        const cl = closeOf(b);
        const held = dir > 0 ? cl >= P : cl <= P;
        if (!held) break; // blew through on the touch bar → skip the card
        const nx = minutes[j + 1];
        if (!nx) break;
        fillBar = j + 1;
        fill = openOf(nx) + dir * CONFIRM_SLIP;
        targetCreditFromFillBar = true; // market entry at the open: the bar is all after the fill
      } else {
        fillBar = j;
        const open = openOf(b);
        fill = dir > 0 ? Math.min(open, P) : Math.max(open, P);
      }
      break;
    }
    if (fillBar < 0) continue;
    const stop = fill - dir * sd;
    const target = fill + dir * td;
    const end = Math.min(minutes.length - 1, fillBar + HORIZON);
    let exit = closeOf(minutes[end]);
    for (let j = fillBar; j <= end; j++) {
      const b = minutes[j];
      if (dir > 0 ? b.low <= stop : b.high >= stop) {
        exit = stop;
        break;
      }
      if ((j > fillBar || targetCreditFromFillBar) && (dir > 0 ? b.high >= target : b.low <= target)) {
        exit = target;
        break;
      }
    }
    out.push({ date, pnl: (exit - fill) * dir, risk: sd });
    openUntil = Math.max(end, s.entryIdx);
  }
  return out;
}

function usd(trades: Trade[]) {
  const rows = trades.map((t) => {
    const contracts = Math.max(1, Math.min(30, Math.floor(RISK_BUDGET / (t.risk * 2))));
    return { date: t.date, pnlPts: t.pnl, riskPts: t.risk, pnlUsd: t.pnl * contracts * 2 - contracts * FEE_RT };
  });
  // fee-inclusive daily $ series; "passed" = never 2,000 below the
  // running peak (the Rapid EOD trailing MLL, fees included)
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.pnlUsd);
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  let breached = false;
  for (const d of [...byDay.keys()].sort()) {
    eq += byDay.get(d)!;
    peak = Math.max(peak, eq);
    maxDD = Math.min(maxDD, eq - peak);
    if (eq - peak <= -2000) breached = true;
  }
  return { netUsd: rows.reduce((a, r) => a + r.pnlUsd, 0), maxDD, passed: !breached, n: rows.length };
}

function joinHistOhlc(date: string, minutes: MomMinute[], dir: string): boolean {
  const f = `${dir}/${date}_ETH.json`;
  if (!fs.existsSync(f)) return false;
  const bars: Array<{ t: string; o: number; h: number; l: number; c: number }> = JSON.parse(fs.readFileSync(f, "utf8")).bars ?? [];
  const byT = new Map(bars.map((b) => [b.t.slice(11, 16), b]));
  const key = (t: string, off: number) => {
    const [h, m] = t.split(":").map(Number);
    const x = (h * 60 + m + off + 1440) % 1440;
    return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
  };
  const ok = (m: MomMinute, b?: { h: number; l: number }) => !!b && Math.abs(b.h - m.high) <= 0.5 && Math.abs(b.l - m.low) <= 0.5;
  let best = 0;
  let bestN = -1;
  for (const off of [-1, 0, 1]) {
    const n = minutes.filter((m) => ok(m, byT.get(key(m.t, off)))).length;
    if (n > bestN) [best, bestN] = [off, n];
  }
  if (bestN < 0.9 * minutes.length) return false;
  for (const m of minutes) {
    const b = byT.get(key(m.t, best));
    if (m.c > 0 || !ok(m, b)) continue;
    (m as { o: number }).o = b!.o;
    (m as { c: number }).c = b!.c;
  }
  return true;
}

const cfgName = (c: Cfg) => `${c.entry.padEnd(7)} s${c.stop.toFixed(2)} t${c.tgt.toFixed(1)}`;

async function main() {
  const dates = await archiveDates();
  if (!dates.length) throw new Error("no archive dates (GC_REMOTE_URL?)");
  const grids = new Map<string, Cfg[]>();
  for (const f of FAMILIES) {
    const g: Cfg[] = [];
    for (const e of ENTRIES) for (const st of f.stops) for (const t of TGTS) g.push({ stop: st, tgt: t, entry: e });
    grids.set(f.name, g);
  }
  const per = new Map<string, Trade[]>();
  let used = 0;
  console.log(`replaying ${dates.length} sessions${OHLC_DIR ? ` · OHLC join ${OHLC_DIR}${REAL_ONLY ? " · real-only" : ""}` : ""}…`);
  for (let i = 0; i < dates.length; i += CONCURRENCY) {
    const chunk = dates.slice(i, i + CONCURRENCY);
    const lm = await Promise.all(chunk.map(async (date) => ({ date, minutes: await loadSessionMinutes(date, { withOhlc: true }) })));
    for (const { date, minutes } of lm) {
      if (!minutes) continue;
      if (OHLC_DIR) joinHistOhlc(date, minutes, OHLC_DIR);
      if (REAL_ONLY && minutes.filter((m) => m.c > 0).length < 0.9 * minutes.length) continue;
      used++;
      for (const f of FAMILIES) {
        const sigs = f.sigs(minutes);
        for (const c of grids.get(f.name)!) {
          const k = `${f.name}|${cfgName(c)}`;
          if (!per.has(k)) per.set(k, []);
          per.get(k)!.push(...score(minutes, sigs, date, f, c));
        }
      }
    }
  }
  console.log(`sessions used: ${used}\n`);

  const picks: Trade[] = [];
  const lives: Trade[] = [];
  for (const f of FAMILIES) {
    const g = grids.get(f.name)!;
    console.log(`\n################ ${f.name} — ${g.length} configs tried ################`);
    const rows = g.map((c) => {
      const ts = per.get(`${f.name}|${cfgName(c)}`)!;
      const tr = ts.filter((t) => t.date < SPLIT);
      const te = ts.filter((t) => t.date >= SPLIT);
      return { c, ts, trS: coreStats(tr), teS: coreStats(te), tr$: usd(tr), te$: usd(te), all$: usd(ts) };
    });
    const live = rows.find((r) => cfgName(r.c) === cfgName(f.live))!;
    const q = rows.filter((r) => r.tr$.passed && r.trS.pf >= 1.1 && r.tr$.netUsd > 0 && r.trS.n >= 30).sort((a, b) => b.tr$.netUsd - a.tr$.netUsd);
    const line = (r: (typeof rows)[number]) =>
      `${cfgName(r.c)} | train n=${String(r.trS.n).padStart(4)} WR ${r.trS.wr.toFixed(1)}% PF ${r.trS.pf.toFixed(2)} $${r.tr$.netUsd.toFixed(0).padStart(7)} ${r.tr$.passed ? "PASS" : "BRCH"} · ` +
      `OOS n=${String(r.teS.n).padStart(4)} WR ${r.teS.wr.toFixed(1)}% PF ${r.teS.pf.toFixed(2)} exp ${r.teS.expPts.toFixed(2)} $${r.te$.netUsd.toFixed(0).padStart(7)} dd ${r.te$.maxDD.toFixed(0)} ${r.te$.passed ? "PASS" : "BRCH"}`;
    console.log(`LIVE  ${line(live)}`);
    console.log(`train-qualified: ${q.length}/${rows.length}`);
    for (const r of q.slice(0, 8)) console.log(`  ${line(r)}`);
    // best per entry type (train-ranked, any qualification) so each lever is visible
    console.log("best per entry mode (train $):");
    for (const e of ENTRIES) {
      const b = rows.filter((r) => r.c.entry === e).sort((a, b2) => b2.tr$.netUsd - a.tr$.netUsd)[0];
      console.log(`  ${line(b)}`);
    }
    lives.push(...live.ts);
    const pick = q[0];
    if (pick) {
      picks.push(...pick.ts);
      console.log(`\n=== T1 — ${f.name}: live vs train pick (${cfgName(pick.c)}) ===`);
      console.log(
        renderT1([
          { label: `live ${cfgName(f.live)} · all`, stats: coreStats(live.ts) },
          { label: "live · test", stats: live.teS },
          { label: `pick ${cfgName(pick.c)} · all`, stats: coreStats(pick.ts) },
          { label: "pick · train", stats: pick.trS },
          { label: "pick · test", stats: pick.teS },
        ]),
      );
      const v = propViability(pick.ts as EngineTrade[], { splitDate: SPLIT });
      console.log(renderT4(v));
      console.log(
        renderVerdict({
          edge: pick.teS.expPts > 0 && pick.te$.netUsd > 0 ? "real" : "absent",
          significance: `train-selected from ${rows.length} configs — no DSR`,
          stability: `train/test WR gap ${(pick.trS.wr - pick.teS.wr).toFixed(1)} pts`,
          holdout: `OOS ≥ ${SPLIT}: $${pick.te$.netUsd.toFixed(0)} ${pick.te$.passed ? "PASS" : "BREACH"}`,
          viability: v.pPass === null ? "n/a" : `${v.pPass >= 0.9 ? "PASS" : v.pPass >= 0.7 ? "weak" : "FAIL"} (P=${v.pPass.toFixed(2)})`,
        }),
      );
    } else {
      console.log(`\n${f.name}: NO config qualifies on train`);
      picks.push(...live.ts);
    }
  }
  console.log("\n################ STACK (all families, each at its pick; live where none) ################");
  const pl = (ts: Trade[], lbl: string) => {
    const tr = usd(ts.filter((t) => t.date < SPLIT));
    const te = usd(ts.filter((t) => t.date >= SPLIT));
    const cs = coreStats(ts.filter((t) => t.date >= SPLIT));
    console.log(`${lbl.padEnd(10)} | train $${tr.netUsd.toFixed(0)} ${tr.passed ? "PASS" : "BRCH"} · OOS n=${cs.n} PF ${cs.pf.toFixed(2)} exp ${cs.expPts.toFixed(2)} $${te.netUsd.toFixed(0)} dd ${te.maxDD.toFixed(0)} ${te.passed ? "PASS" : "BRCH"}`);
  };
  pl(lives, "live");
  pl(picks, "picks");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
