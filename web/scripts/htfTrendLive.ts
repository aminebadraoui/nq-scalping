/* ------------------------------------------------------------------ *
 * HTF-trend live audit — test the hypothesis that losing SHORT trades
 * cluster on higher-timeframe BULLISH pullbacks.
 *
 * Joins the reconciled `trades` rows with session minutes loaded from
 * the R2 archive (full OHLC; the Neon live-capture rows for ETH hours
 * have NULL o/c, so the archive is the reliable source), then computes
 * higher-timeframe trend measures at each entry:
 *   - 15m EMA20/50 (resampled from 1m closes/mids) + slope
 *   - 1m EMA50/200 + EMA200 slope
 *   - session net change / session VWAP / session cumulative delta
 *   - position within the prior RTH range
 * and tabulates win/loss by side × trend regime, listing every losing
 * short with its regime flags.
 *
 * Run from web/:
 *   node --import ../scripts/ts-loader.mjs ./scripts/htfTrendLive.ts
 * ------------------------------------------------------------------ */

import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";
import { loadSessionMinutes } from "../lib/archive";
import { closeOf, type MomMinute } from "../lib/momentum";

function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      const v = s.slice(i + 1).trim();
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {
    /* env must be set by the caller */
  }
}
loadEnvLocal();

const MIN = 60_000;

type Bar = { t: number; o: number; h: number; l: number; c: number; buy: number; sell: number };

function emaAt(closes: number[], idx: number, period: number): number {
  const k = 2 / (period + 1);
  let prev = closes[0];
  for (let i = 1; i <= idx; i++) prev = prev + k * (closes[i] - prev);
  return prev;
}

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { ssl: "require", max: 1 });
  const trades = await sql`
    SELECT id, ts, time_et, side, family, verdict, result, fill_entry, exit_avg,
           gross_pts, gross_usd, net_usd, mfe_pts, mae_pts, target_reached, stop_run, loss_label
    FROM trades
    WHERE result IN ('win','loss','flat') AND fill_entry IS NOT NULL
    ORDER BY ts`;
  await sql.end();

  // Session labels (RTH-date convention: ETH session of label D covers
  // D-1 22:00Z → D 20:59Z). Load every session that could contain a trade
  // plus the day before for the prior-RTH range.
  const utcDay = (ms: number) => Math.floor(ms / (24 * MIN));
  const days = new Set<number>();
  for (const tr of trades) {
    const ms = Number(tr.ts);
    const d = utcDay(ms);
    // if the entry is before 22:00Z, its session label is that same UTC day
    days.add(d);
    days.add(d - 1);
  }
  const byMin = new Map<number, Bar>();
  for (const d of [...days].sort()) {
    const iso = new Date(d * 24 * MIN).toISOString().slice(0, 10);
    const minutes: MomMinute[] | null = await loadSessionMinutes(iso);
    if (!minutes) continue;
    for (const m of minutes) {
      // vendor stamps HH:MM with a fixed -05:00 offset (see hourET = hh+1 in
      // momentum.ts); parsing it literally reconstructs the true UTC minute.
      const t = Math.floor(Date.parse(`${m.d}T${m.t}:00-05:00`) / MIN);
      byMin.set(t, {
        t,
        o: m.o,
        h: m.high,
        l: m.low,
        c: closeOf(m),
        buy: m.buy,
        sell: m.sell,
      });
    }
  }
  if (byMin.size === 0) throw new Error("no archive minutes loaded");

  const rows: any[] = [];
  for (const tr of trades) {
    const t = Math.floor(Number(tr.ts) / MIN);
    if (!byMin.has(t)) {
      rows.push({ id: tr.id, side: tr.side, result: tr.result, note: "no candle coverage" });
      continue;
    }
    // session start: 22:00Z (18:00 ET) boundary
    const dayStart = Math.floor(t / 1440) * 1440;
    const s0 = (t % 1440) >= 22 * 60 ? dayStart + 22 * 60 : dayStart - 2 * 60;
    // prior RTH: previous UTC day 13:30–20:00Z (9:30–16:00 ET)
    const prev = Math.floor(t / 1440) - 1;
    const r0 = prev * 1440 + 13 * 60 + 30;
    const r1 = prev * 1440 + 20 * 60;

    // trailing 1m series (contiguous back from entry)
    const idxArr: number[] = [];
    for (let m = t; m >= t - 2000; m--) {
      if (byMin.has(m)) idxArr.unshift(m);
      else break;
    }
    const series = idxArr.map((m) => byMin.get(m)!);
    const closes = series.map((b) => b.c);
    const i = series.length - 1;
    const ema50 = emaAt(closes, i, 50);
    const ema200 = emaAt(closes, i, 200);
    const ema200Prev = emaAt(closes, Math.max(0, i - 60), 200);
    const ema50Prev = emaAt(closes, Math.max(0, i - 30), 50);

    // 15m resample over trailing series
    const m15: Bar[] = [];
    for (let m = t; m >= t - 2000; m -= 15) {
      const bucket: Bar[] = [];
      for (let k = m - 14; k <= m; k++) {
        const b = byMin.get(k);
        if (b) bucket.push(b);
      }
      if (bucket.length) {
        m15.unshift({
          t: m, o: bucket[0].o,
          h: Math.max(...bucket.map((b) => b.h)),
          l: Math.min(...bucket.map((b) => b.l)),
          c: bucket[bucket.length - 1].c,
          buy: bucket.reduce((a, b) => a + b.buy, 0),
          sell: bucket.reduce((a, b) => a + b.sell, 0),
        });
      }
    }
    const c15 = m15.map((b) => b.c);
    const j = c15.length - 1;
    const e20_15 = emaAt(c15, j, 20);
    const e50_15 = emaAt(c15, j, 50);
    const e20_15Prev = emaAt(c15, Math.max(0, j - 4), 20);

    // session aggregates from 22:00Z
    let sOpen: number | null = null;
    let sCumDelta = 0, sTypVol = 0, sVol = 0;
    for (let m = s0; m <= t; m++) {
      const b = byMin.get(m);
      if (!b) continue;
      if (sOpen === null) sOpen = b.o;
      sCumDelta += b.buy - b.sell;
      const typ = (b.h + b.l + b.c) / 3;
      sTypVol += typ * (b.buy + b.sell);
      sVol += b.buy + b.sell;
    }
    const sVwap = sVol > 0 ? sTypVol / sVol : null;

    // prior RTH high/low
    let prH: number | null = null, prL: number | null = null;
    for (let m = r0; m < r1; m++) {
      const b = byMin.get(m);
      if (!b) continue;
      prH = prH === null ? b.h : Math.max(prH, b.h);
      prL = prL === null ? b.l : Math.min(prL, b.l);
    }

    const c0 = closes[Math.max(0, i - 15)];
    const c60 = closes[Math.max(0, i - 60)];
    const c240 = closes[Math.max(0, i - 240)];
    const fill = +tr.fill_entry;

    const htf = {
      bull15: e20_15 > e50_15 && e20_15 >= e20_15Prev,
      bear15: e20_15 < e50_15 && e20_15 <= e20_15Prev,
      aboveEma200: fill > ema200,
      ema200Rising: ema200 >= ema200Prev,
      ema50Rising: ema50 >= ema50Prev,
      ret15: fill - c0,
      ret60: fill - c60,
      ret240: fill - c240,
      sessRet: sOpen !== null ? fill - sOpen : null,
      sessCumDelta: sCumDelta,
      aboveVwap: sVwap !== null ? fill > sVwap : null,
      prevRangePos: prH !== null && prL !== null && prH > prL ? (fill - prL) / (prH - prL) : null,
    };

    const up = htf.bull15 && htf.aboveEma200;
    const dn = htf.bear15 && !htf.aboveEma200;
    const regime = up ? "HTF_UP" : dn ? "HTF_DOWN" : "HTF_MIXED";

    rows.push({
      id: tr.id, time_et: tr.time_et, side: tr.side, family: tr.family,
      verdict: tr.verdict, result: tr.result, fill_entry: tr.fill_entry,
      gross_usd: tr.gross_usd, net_usd: tr.net_usd, mfe_pts: tr.mfe_pts, mae_pts: tr.mae_pts,
      stop_run: tr.stop_run, loss_label: tr.loss_label,
      e20_15: +e20_15.toFixed(2), e50_15: +e50_15.toFixed(2),
      slope15: +(e20_15 - e20_15Prev).toFixed(2),
      ema50: +ema50.toFixed(2), ema200: +ema200.toFixed(2),
      ret15: +htf.ret15.toFixed(1), ret60: +htf.ret60.toFixed(1), ret240: +htf.ret240.toFixed(1),
      sessRet: htf.sessRet === null ? null : +htf.sessRet.toFixed(2),
      sessCumDelta: htf.sessCumDelta,
      aboveVwap: htf.aboveVwap,
      prevRangePos: htf.prevRangePos === null ? null : +htf.prevRangePos.toFixed(2),
      regime,
    });
  }

  console.log("=== Every matched trade with HTF context ===\n");
  console.log(
    ["id","et","side","family","res","$gross","mfe","mae","regime","e20_15","e50_15","slope15","ema200","ret15","ret60","ret240","sessRet","sessΔ","vWAP","prRng"].join("\t")
  );
  for (const r of rows) {
    console.log(
      [r.id, r.time_et, r.side, r.family, r.result, r.gross_usd, r.mfe_pts, r.mae_pts,
       r.regime, r.e20_15, r.e50_15, r.slope15, r.ema200, r.ret15, r.ret60, r.ret240,
       r.sessRet, r.sessCumDelta, r.aboveVwap === null ? "" : (r.aboveVwap ? ">" : "<"),
       r.prevRangePos].join("\t")
    );
  }

  console.log("\n=== Side x regime outcomes ===");
  const groups = new Map<string, any[]>();
  for (const r of rows) {
    if (!r.fill_entry) continue;
    const k = `${r.side}|${r.regime}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  for (const [k, list] of [...groups.entries()].sort()) {
    const wins = list.filter((r) => r.result === "win");
    const losses = list.filter((r) => r.result === "loss");
    const gross = list.reduce((a, r) => a + +r.gross_usd, 0);
    const grossW = wins.reduce((a, r) => a + +r.gross_usd, 0);
    const grossL = losses.reduce((a, r) => a - (+r.gross_usd), 0);
    const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? Infinity : 0;
    console.log(
      `${k.padEnd(22)} n=${String(list.length).padStart(2)}  W=${String(wins.length).padStart(2)} L=${String(losses.length).padStart(2)} ` +
      `WR=${((wins.length / list.length) * 100).toFixed(0).padStart(3)}%  PF=${pf === Infinity ? "∞" : pf.toFixed(2).padStart(5)}  gross=$${gross.toFixed(0)}`
    );
  }

  console.log("\n=== Losing shorts with regime context (the hypothesis) ===");
  for (const r of rows) {
    if (r.side === "short" && r.result === "loss") {
      console.log(
        `#${r.id} ${r.time_et} ${r.family} ${r.verdict}: regime=${r.regime} ` +
        `15mEMA20=${r.e20_15} vs EMA50=${r.e50_15} (slope ${r.slope15}) ` +
        `priceVsEMA200=${(r.fill_entry - r.ema200).toFixed(1)} ret15=${r.ret15} ret60=${r.ret60} ret240=${r.ret240} ` +
        `sessRet=${r.sessRet} sessΔ=${r.sessCumDelta} ` +
        `vsVWAP=${r.aboveVwap === null ? "?" : r.aboveVwap ? "above" : "below"} prevRangePos=${r.prevRangePos} ` +
        `→ $${r.gross_usd} ${r.loss_label ? `[${r.loss_label}]` : ""} ${r.stop_run ? "[stop-run]" : ""}`
      );
    }
  }
  console.log("\n=== Losing longs (for symmetry) ===");
  for (const r of rows) {
    if (r.side === "long" && r.result === "loss") {
      console.log(
        `#${r.id} ${r.time_et} ${r.family}: regime=${r.regime} 15mEMA20=${r.e20_15} vs EMA50=${r.e50_15} ` +
        `ret60=${r.ret60} sessRet=${r.sessRet} sessΔ=${r.sessCumDelta} → $${r.gross_usd} ` +
        `${r.loss_label ? `[${r.loss_label}]` : ""} ${r.stop_run ? "[stop-run]" : ""}`
      );
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
