/* ------------------------------------------------------------------ *
 * Journal metric tables — pure functions over matched trade rows.
 *
 * Each table answers ONE question with a stable, machine-readable schema
 * (the same shape the /api/trades JSON exposes to the AI review):
 *   streakTable      → how long do win/loss runs last per strategy?
 *   drawdownTable    → worst give-back per strategy (running net curve)
 *   hourMatrix       → which strategy performs best at which hour block?
 *   hourTable        → best/worst hour blocks overall
 * Everything is computed from (ts, family, hourBucket, result, netUsd) —
 * deterministic, replayable, unit-tested.
 * ------------------------------------------------------------------ */

import { familyName } from "./familyNames";

export type MetricTrade = {
  ts: number;
  day: string;
  family: string;
  hourBucket: string;
  result: string; // "win" | "loss" | "flat" | ""
  netUsd: number;
};

/* ---------------- streaks ------------------------------------------- */

export type StreakRow = {
  family: string;
  label: string;
  n: number;
  maxWin: number;
  maxLoss: number;
  curWin: number;
  curLoss: number;
};

export function streakTable(trades: MetricTrade[]): StreakRow[] {
  const byFam = new Map<string, MetricTrade[]>();
  for (const t of trades) {
    if (t.result !== "win" && t.result !== "loss") continue;
    const list = byFam.get(t.family);
    if (list) list.push(t);
    else byFam.set(t.family, [t]);
  }
  const out: StreakRow[] = [];
  for (const [fam, list] of byFam) {
    list.sort((a, b) => a.ts - b.ts);
    let win = 0;
    let loss = 0;
    let maxWin = 0;
    let maxLoss = 0;
    for (const t of list) {
      if (t.result === "win") {
        win++;
        loss = 0;
      } else {
        loss++;
        win = 0;
      }
      if (win > maxWin) maxWin = win;
      if (loss > maxLoss) maxLoss = loss;
    }
    out.push({ family: fam, label: familyName(fam), n: list.length, maxWin, maxLoss, curWin: win, curLoss: loss });
  }
  return out.sort((a, b) => b.n - a.n);
}

/* ---------------- drawdown ------------------------------------------ */

export type DrawdownRow = {
  family: string;
  label: string;
  maxDdUsd: number;
  ddPct: number | null; // % of the strategy's running-net peak; null if it never went positive
  worstDayUsd: number;
  worstDay: string;
};

export function drawdownTable(trades: MetricTrade[]): DrawdownRow[] {
  const byFam = new Map<string, MetricTrade[]>();
  for (const t of trades) {
    const list = byFam.get(t.family);
    if (list) list.push(t);
    else byFam.set(t.family, [t]);
  }
  const out: DrawdownRow[] = [];
  for (const [fam, list] of byFam) {
    list.sort((a, b) => a.ts - b.ts);
    let running = 0;
    let peak = 0;
    let maxDd = 0;
    let peakAtDd = 0;
    for (const t of list) {
      running += t.netUsd;
      if (running > peak) peak = running;
      const dd = running - peak;
      if (dd < maxDd) {
        maxDd = dd;
        peakAtDd = peak;
      }
    }
    let worstDayUsd = 0;
    let worstDay = "";
    const byDay = new Map<string, number>();
    for (const t of list) byDay.set(t.day, (byDay.get(t.day) ?? 0) + t.netUsd);
    for (const [d, v] of byDay) {
      if (v < worstDayUsd) {
        worstDayUsd = v;
        worstDay = d;
      }
    }
    out.push({
      family: fam,
      label: familyName(fam),
      maxDdUsd: Math.round(maxDd * 100) / 100,
      ddPct: peakAtDd > 0 ? Math.round((maxDd / peakAtDd) * 10000) / 100 : null,
      worstDayUsd: Math.round(worstDayUsd * 100) / 100,
      worstDay,
    });
  }
  return out.sort((a, b) => a.maxDdUsd - b.maxDdUsd);
}

/* ---------------- strategy × hour matrix ---------------------------- */

export const HOUR_ORDER = ["globex_early", "globex_core", "globex_late", "globex_dawn", "premkt", "rth", "close"] as const;

export const HOUR_LABEL: Record<string, string> = {
  globex_early: "18–21 ET",
  globex_core: "21–00 ET",
  globex_late: "00–03 ET",
  globex_dawn: "03–06 ET",
  premkt: "06–09:30 ET",
  rth: "09:30–16 ET",
  close: "16–18 ET",
};

export type HourCell = {
  family: string;
  label: string;
  hour: string;
  n: number;
  wins: number;
  losses: number;
  netUsd: number;
  wr: number | null; // 0..1, null when n=0
};

export function hourMatrix(trades: MetricTrade[]): HourCell[] {
  const key = (f: string, h: string) => `${f}|${h}`;
  const cells = new Map<string, HourCell>();
  for (const t of trades) {
    const k = key(t.family, t.hourBucket || "other");
    const c = cells.get(k);
    if (c) {
      c.n++;
      if (t.result === "win") c.wins++;
      else if (t.result === "loss") c.losses++;
      c.netUsd += t.netUsd;
    } else {
      cells.set(k, {
        family: t.family,
        label: familyName(t.family),
        hour: t.hourBucket || "other",
        n: 1,
        wins: t.result === "win" ? 1 : 0,
        losses: t.result === "loss" ? 1 : 0,
        netUsd: t.netUsd,
        wr: null,
      });
    }
  }
  const out = [...cells.values()];
  for (const c of out) c.wr = c.n > 0 ? (c.wins / c.n) * 100 : null;
  return out;
}

/* ---------------- hour performance (best/worst hours) --------------- */

export type HourRow = {
  hour: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  wr: number | null;
  netUsd: number;
  expUsd: number | null;
};

export function hourTable(trades: MetricTrade[]): HourRow[] {
  const cells = new Map<string, HourRow>();
  for (const t of trades) {
    const h = t.hourBucket || "other";
    const c = cells.get(h);
    if (c) {
      c.n++;
      if (t.result === "win") c.wins++;
      else if (t.result === "loss") c.losses++;
      c.netUsd += t.netUsd;
    } else {
      cells.set(h, {
        hour: h,
        label: HOUR_LABEL[h] ?? h,
        n: 1,
        wins: t.result === "win" ? 1 : 0,
        losses: t.result === "loss" ? 1 : 0,
        wr: null,
        netUsd: 0,
        expUsd: null,
      });
      const c = cells.get(h)!;
      c.netUsd = t.netUsd;
    }
  }
  const out = [...cells.values()];
  for (const c of out) {
    c.wr = c.n > 0 ? (c.wins / c.n) * 100 : null;
    c.expUsd = c.n > 0 ? Math.round((c.netUsd / c.n) * 100) / 100 : null;
    c.netUsd = Math.round(c.netUsd * 100) / 100;
  }
  return out.sort((a, b) => b.netUsd - a.netUsd);
}
