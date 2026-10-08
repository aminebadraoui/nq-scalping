/* ------------------------------------------------------------------ *
 * Daybook consolidation — the DB-less session post-mortem (2026-10-07).
 *
 * Runs on the VPS jobs container (nightly.sh, AFTER the tape is
 * collected) and needs NO DATABASE_URL: it pulls the live daybook JSONL
 * from the dashboard (/api/daybook?format=jsonl), reconstructs every
 * trade from the CrossTrade fill record (the execution source of truth),
 * labels each trade with its signal card, replays the RTH cap skips
 * against the collected minute tape, and writes:
 *
 *   gcdata/data/daybook/<day>.summary.json   the consolidated summary
 *   gcdata/data/daybook/<day>.jsonl          (appends a `dayend` record)
 *
 * r2_sync.py uploads the daybook dir to R2 (free egress) — the durable
 * variation log the operator reads even when Neon is down.
 *
 * Run from web/:
 *   node --import scripts/ts-loader.mjs ./scripts/daybookConsolidate.ts
 *   node --import scripts/ts-loader.mjs ./scripts/daybookConsolidate.ts --day 2026-10-07
 * ------------------------------------------------------------------ */

import { readFileSync, existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";
import {
  entryCandidates,
  childExitFills,
  fallbackExitFills,
  type OrderRow,
  type FillRow,
} from "../lib/reconcile";
import { familyOf } from "../lib/tradeStats";
import { daybookDayKey, daybookR2Base, type DaybookDaySummary, type DaybookTradeSummary } from "../lib/daybook";
import { resolveEffectiveAccount } from "../lib/execOverrides";

/* ---- env ------------------------------------------------------------ */
function loadEnvLocal() {
  const p = path.resolve(process.cwd(), ".env.local");
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const i = s.indexOf("=");
      const k = s.slice(0, i).trim();
      if (!process.env[k]) process.env[k] = s.slice(i + 1).trim();
    }
  } catch {
    /* env must be set by the caller */
  }
}
loadEnvLocal();

const CT_KEY = process.env.CROSSTRADE_KEY ?? "";
// the effective account is resolved in main(): the dashboard's password-
// gated account switch writes a runtime override the jobs container can't
// see locally, so it asks the dashboard (key-authenticated) first.
let CT_ACCOUNT = process.env.CROSSTRADE_ACCOUNT ?? "";
const DASHBOARD = process.env.DASHBOARD_URL ?? "https://nq-dashboard.31.97.138.30.sslip.io";
const DATA_DIR = process.env.GC_DATA_DIR || path.join(process.cwd(), "..", "gcdata", "data");

if (!CT_KEY) {
  console.error("daybookConsolidate: need CROSSTRADE_KEY");
  process.exit(1);
}

const sinceArg = process.argv.indexOf("--day");
const day = sinceArg >= 0 && process.argv[sinceArg + 1] ? process.argv[sinceArg + 1] : daybookDayKey(new Date(Date.now() - 45 * 60_000));
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error(`daybookConsolidate: bad --day value "${day}"`);
  process.exit(1);
}

const MINUTE = 60_000;
const POINT_VALUE = 2; // MNQ $2/pt/contract
const COMM_PER_SIDE = 0.95; // empirically implied all-in per contract per side
const TICK = 0.3; // target/stop recognition tolerance

// session window for trading-day key `day`: day 18:00 ET → day+1 17:00 ET
// (EDT = UTC−4 → 22:00Z / 21:00Z). The daybook day key matches
// accountGuard.tradingDayKey — before 18:00 ET the day belongs to
// YESTERDAY's session date.
const nextDay = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const windowStartMs = Date.parse(`${day}T22:00:00Z`);
const windowEndMs = Date.parse(`${nextDay}T21:00:00Z`);
console.log(`[consolidate] day ${day} · window ${new Date(windowStartMs).toISOString()} → ${new Date(windowEndMs).toISOString()}`);

/* ---- daybook pull ---------------------------------------------------- */
type AnyRecord = Record<string, unknown> & { t?: string; at?: number };

async function fetchDaybook(): Promise<AnyRecord[]> {
  const fileArg = process.argv.indexOf("--daybook-file");
  if (fileArg >= 0 && process.argv[fileArg + 1]) {
    try {
      const text = readFileSync(process.argv[fileArg + 1], "utf8");
      return text
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => {
          try {
            return JSON.parse(l) as AnyRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is AnyRecord => r !== null);
    } catch (e) {
      console.warn(`[consolidate] daybook file unreadable (${String(e)})`);
      return [];
    }
  }
  const parse = (text: string): AnyRecord[] =>
    text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as AnyRecord;
        } catch {
          return null;
        }
      })
      .filter((r): r is AnyRecord => r !== null);

  const fromR2 = async (): Promise<AnyRecord[]> => {
    const res = await fetch(`${daybookR2Base()}/data/daybook/${day}.jsonl`, { signal: AbortSignal.timeout(30_000) });
    return res.ok ? parse(await res.text()) : [];
  };

  try {
    const res = await fetch(`${DASHBOARD}/api/daybook?day=${day}&format=jsonl`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`daybook HTTP ${res.status}`);
    const rows = parse(await res.text());
    // the dashboard only has days this container lived through — for older
    // days (and redeploy gaps) the R2 archive is the source of truth
    if (rows.length === 0) return fromR2();
    return rows;
  } catch (e) {
    // dashboard down → try the R2 archive directly
    try {
      const rows = await fromR2();
      if (rows.length) return rows;
    } catch {
      /* fall through to the warning */
    }
    // non-fatal: trades still reconstruct from CrossTrade alone — only the
    // signal labels / cap replay lose data (console warning)
    console.warn(`[consolidate] daybook pull unavailable (${String(e)}) — trades unlabeled`);
    return [];
  }
}

/* ---- CrossTrade fills + orders --------------------------------------- */

const ctGet = async (url: string): Promise<unknown> => {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${CT_KEY}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CrossTrade ${res.status} for ${url}`);
  return res.json();
};

async function fetchFills(): Promise<FillRow[]> {
  const map: Record<string, FillRow> = {};
  try {
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        from: new Date(windowStartMs).toISOString(),
        to: new Date(windowEndMs).toISOString(),
        limit: "1000",
        account: CT_ACCOUNT,
      });
      if (cursor) q.set("cursor", cursor);
      const d = (await ctGet(`https://app.crosstrade.io/v1/api/tv/fills/history?${q}`)) as {
        success?: boolean;
        data?: Array<Record<string, unknown>>;
        nextCursor?: string | null;
      };
      for (const f of d.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < windowStartMs || ts >= windowEndMs) continue;
        const key = `${f.fillId ?? f.executionId ?? ""}|${f.orderId ?? ""}|${ts}|${f.qty}|${f.price}|${f.action}`;
        map[key] = {
          ts,
          action: String(f.action) === "Buy" ? "Buy" : "Sell",
          qty: Number(f.qty ?? 0),
          price: Number(f.price ?? 0),
          instrument: String(f.instrument ?? ""),
          orderId: String(f.orderId ?? ""),
          commission: Number(f.commission ?? 0),
          fees: Number(f.fees ?? 0),
        };
      }
      cursor = d.nextCursor ?? undefined;
      if (!cursor) break;
    }
  } catch (e) {
    console.warn(`[consolidate] fill history unavailable: ${String(e)}`);
  }
  try {
    const d = (await ctGet("https://app.crosstrade.io/v1/api/tv/fills")) as {
      success?: boolean;
      data?: Array<{ data?: Array<Record<string, unknown>> }>;
    };
    for (const env of d.data ?? []) {
      for (const f of env.data ?? []) {
        const ts = Date.parse(String(f.timestamp ?? ""));
        if (!Number.isFinite(ts) || ts < windowStartMs || ts >= windowEndMs) continue;
        const key = `${f.id ?? ""}|${f.orderId ?? ""}|${ts}|${f.qty}|${f.price}|${f.action}`;
        if (map[key]) continue;
        map[key] = {
          ts,
          action: String(f.action) === "Buy" ? "Buy" : "Sell",
          qty: Number(f.qty ?? 0),
          price: Number(f.price ?? 0),
          instrument: String(f.instrument ?? ""),
          orderId: String(f.orderId ?? ""),
          commission: 0,
          fees: 0,
        };
      }
    }
  } catch (e) {
    console.warn(`[consolidate] session fills unavailable: ${String(e)}`);
  }
  return Object.values(map).sort((a, b) => a.ts - b.ts);
}

async function fetchOrders(): Promise<OrderRow[]> {
  try {
    const d = (await ctGet("https://app.crosstrade.io/v1/api/tv/orders?activeOnly=false")) as {
      success?: boolean;
      data?: Array<{ data?: Array<Record<string, unknown>> }>;
    };
    const raw: Array<{ id: string; ts: number; action: "Buy" | "Sell"; parentId: string | null; ocoId: string | null }> = [];
    for (const env of d.data ?? []) {
      for (const o of env.data ?? []) {
        const ts = Date.parse(String(o.timestamp ?? ""));
        if (!Number.isFinite(ts)) continue;
        raw.push({
          id: String(o.id),
          ts,
          action: String(o.action) === "Buy" ? "Buy" : "Sell",
          parentId: o.parentId !== null && o.parentId !== undefined ? String(o.parentId) : null,
          ocoId: o.ocoId !== null && o.ocoId !== undefined ? String(o.ocoId) : null,
        });
      }
    }
    // CrossTrade's FILLED exit leg often carries no parentId — only its
    // canceled twin does. ocoId links the twins, so resolve parentage
    // through the sibling: exit.ocoId → sibling.parentId → the entry.
    const byId = new Map(raw.map((o) => [o.id, o]));
    const out: OrderRow[] = raw.map((o) => {
      let parent = o.parentId;
      if (parent === null && o.ocoId !== null) {
        const sib = byId.get(o.ocoId);
        if (sib?.parentId) parent = sib.parentId;
      }
      return { id: o.id, ts: o.ts, action: o.action, parentId: parent };
    });
    return out.sort((a, b) => a.ts - b.ts);
  } catch {
    return [];
  }
}

/* ---- trade reconstruction -------------------------------------------- */

type RawTrade = {
  dir: "long" | "short";
  qty: number;
  entryAvg: number;
  entryTs: number;
  exitAvg: number | null;
  exitTs: number | null;
  allFills: FillRow[];
  open: boolean;
};

function orderLevelTrades(orders: OrderRow[], fills: FillRow[]): RawTrade[] {
  const candidates = entryCandidates(orders, fills);
  const out: RawTrade[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const e = candidates[i];
    const qty = e.fills.reduce((s, f) => s + f.qty, 0);
    if (qty <= 0) continue;
    const entryAvg = e.fills.reduce((s, f) => s + f.price * f.qty, 0) / qty;
    let exits = childExitFills([e], orders, fills);
    if (!exits.length) {
      const nextTs = i + 1 < candidates.length ? candidates[i + 1].order.ts : null;
      exits = fallbackExitFills([e], fills, nextTs, qty, "MNQ");
    }
    const exitAvg = exits.length ? exits.reduce((s, f) => s + f.price * f.qty, 0) / exits.reduce((s, f) => s + f.qty, 0) : null;
    const exitTs = exits.length ? Math.max(...exits.map((f) => f.ts)) : null;
    out.push({
      dir: e.order.action === "Buy" ? "long" : "short",
      qty,
      entryAvg,
      entryTs: e.order.ts || e.fills[0].ts,
      exitAvg,
      exitTs,
      allFills: [...e.fills, ...exits],
      open: !exits.length,
    });
  }
  return out;
}

/** fill-level fallback (session reset wiped the orders list): fill groups
 *  keyed by orderId, walked chronologically. A trade = one entry leg
 *  (possibly split across same-side orders — scale-out) closed by the
 *  opposite-side group(s) until the entry qty is covered. The live
 *  brackets alternate sides per trade, so this never mis-pairs the
 *  interleaved case (2026-10-07: 14 groups → 7 clean round trips). */
function fillLevelTrades(fills: FillRow[]): RawTrade[] {
  const groups: FillRow[][] = [];
  for (const f of fills) {
    const g = groups.find((x) => x[0].orderId === f.orderId);
    if (g) g.push(f);
    else groups.push([f]);
  }
  groups.sort((a, b) => a[0].ts - b[0].ts);

  const out: RawTrade[] = [];
  let entry: FillRow[] | null = null;
  let exits: FillRow[] = [];
  const pushTrade = () => {
    if (!entry) return;
    const qty = entry.reduce((s, f) => s + f.qty, 0);
    const xqty = exits.reduce((s, f) => s + f.qty, 0);
    const exitAvg = xqty ? exits.reduce((s, f) => s + f.price * f.qty, 0) / xqty : null;
    out.push({
      dir: entry[0].action === "Buy" ? "long" : "short",
      qty,
      entryAvg: entry.reduce((s, f) => s + f.price * f.qty, 0) / qty,
      entryTs: entry[0].ts,
      exitAvg,
      exitTs: xqty ? Math.max(...exits.map((f) => f.ts)) : null,
      allFills: [...entry, ...exits],
      open: xqty === 0,
    });
  };
  for (const g of groups) {
    if (!entry) {
      entry = g;
      exits = [];
      continue;
    }
    const sameSide = g[0].action === entry[0].action;
    if (sameSide) {
      const eQty = entry.reduce((s, f) => s + f.qty, 0);
      const xQty = exits.reduce((s, f) => s + f.qty, 0);
      if (xQty > 0 && xQty < eQty) {
        // an under-covered previous trade meets the NEXT trade's entry —
        // close the previous one as-is and start fresh
        pushTrade();
        entry = g;
        exits = [];
      } else {
        entry.push(...g); // multi-leg entry (scale-out bank + runner)
      }
    } else {
      exits.push(...g);
      const eQty = entry.reduce((s, f) => s + f.qty, 0);
      const xQty = exits.reduce((s, f) => s + f.qty, 0);
      if (xQty >= eQty) {
        pushTrade();
        entry = null;
        exits = [];
      }
    }
  }
  if (entry) pushTrade();
  return out;
}

/** choose the reconstruction that explains more of the fill record: the
 *  order-level path is best, but after the ~17:00 ET session reset the
 *  orders list shrinks to stragglers while durable fills remain — then
 *  the fill-level walk covers more. */
function pickReconstruction(orders: OrderRow[], fills: FillRow[]): RawTrade[] {
  const cover = (trades: RawTrade[]): number => trades.reduce((s, t) => s + t.allFills.reduce((a, f) => a + f.qty, 0), 0);
  const total = fills.reduce((s, f) => s + f.qty, 0);
  if (orders.length === 0) return fillLevelTrades(fills);
  const ol = orderLevelTrades(orders, fills);
  if (ol.length === 0) return fillLevelTrades(fills);
  const fl = fillLevelTrades(fills);
  return cover(ol) >= cover(fl) ? ol : fl;
}

/* ---- signal labeling + cap replay ------------------------------------ */

type SignalRec = {
  at: number;
  timeET: string;
  side: "long" | "short";
  entry: number;
  stop: number;
  target: number;
  verdict: string;
  headline: string;
  reason: string;
  sent: boolean;
};

function signalsFrom(records: AnyRecord[]): SignalRec[] {
  return records
    .filter((r) => r.t === "signal")
    .map((r) => {
      const sideRaw = String(r.side ?? "");
      return {
        at: Number(r.at ?? 0),
        timeET: String(r.timeET ?? ""),
        side: (sideRaw.includes("long") ? "long" : "short") as "long" | "short",
        entry: Number(r.entry ?? 0),
        stop: Number(r.stop ?? 0),
        target: Number(r.target ?? 0),
        verdict: String(r.verdict ?? ""),
        headline: String(r.headline ?? ""),
        reason: String(r.reason ?? ""),
        sent: Boolean(r.sent),
      };
    })
    .filter((s) => s.entry > 0);
}

function labelTrade(t: RawTrade, sigs: SignalRec[]): { family: string; verdict: string; plan: SignalRec | null } {
  let best: SignalRec | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const s of sigs) {
    if (s.side !== t.dir) continue;
    const dist = Math.abs(t.entryTs - s.at);
    if (dist < bestDist && dist <= 16 * MINUTE) {
      best = s;
      bestDist = dist;
    }
  }
  return { family: familyOf(best?.verdict ?? ""), verdict: best?.verdict ?? "", plan: best };
}

type Bar = { ts: number; high: number; low: number };

function loadBars(day: string): Bar[] {
  const out: Bar[] = [];
  for (const session of ["RTH", "ETH"]) {
    const p = path.join(DATA_DIR, `${day}_${session}.json`);
    if (!existsSync(p)) continue;
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { candles?: Array<{ t: string; high: number; low: number }> };
      for (const c of j.candles ?? []) {
        const ts = Date.parse(c.t);
        if (!Number.isFinite(ts)) continue;
        out.push({ ts, high: c.high, low: c.low });
      }
    } catch {
      /* missing session file — replay stays null */
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** replay a skipped card against the minute tape: first-touch of stop or
 *  target wins; a 45-bar time exit closes at the last close. Same bar
 *  touching both = stop first (conservative). */
function replayCard(s: SignalRec, bars: Bar[]): { wouldHave: "win" | "loss" | "flat" | null; pts: number | null } {
  const start = bars.findIndex((b) => b.ts >= s.at - MINUTE);
  if (start < 0) return { wouldHave: null, pts: null };
  const dir = s.side === "long" ? 1 : -1;
  for (let i = start; i < Math.min(bars.length, start + 45); i++) {
    const b = bars[i];
    if (dir === 1) {
      if (b.low <= s.stop) return { wouldHave: "loss", pts: s.stop - s.entry };
      if (b.high >= s.target) return { wouldHave: "win", pts: s.target - s.entry };
    } else {
      if (b.high >= s.stop) return { wouldHave: "loss", pts: s.entry - s.stop };
      if (b.low <= s.target) return { wouldHave: "win", pts: s.entry - s.target };
    }
  }
  return { wouldHave: null, pts: null }; // no touch within 45 bars — unverifiable without a close price
}

/* ---- main ------------------------------------------------------------ */

async function main() {
  CT_ACCOUNT = await resolveEffectiveAccount(process.env);
  if (!CT_ACCOUNT) {
    console.error("[consolidate] no effective CROSSTRADE_ACCOUNT (env, override file, or dashboard)");
    process.exit(1);
  }
  console.log(`[consolidate] effective account ${CT_ACCOUNT}`);
  const [records, fills, orders] = await Promise.all([fetchDaybook(), fetchFills(), fetchOrders()]);
  console.log(`[consolidate] daybook records=${records.length} fills=${fills.length} orders=${orders.length}`);

  const rawTrades = pickReconstruction(orders, fills);
  const sigs = signalsFrom(records);

  const trades: DaybookTradeSummary[] = [];
  for (const t of rawTrades) {
    const { family, verdict, plan } = labelTrade(t, sigs);
    const dirSign = t.dir === "long" ? 1 : -1;
    const pts = t.exitAvg === null ? 0 : (t.exitAvg - t.entryAvg) * dirSign;
    const grossUsd = Math.round(pts * t.qty * POINT_VALUE * 100) / 100;
    const realFees = t.allFills.reduce((s, f) => s + f.commission + f.fees, 0);
    // real fees win ONLY when every fill carried fee data (session fills
    // have none yet) — otherwise estimate the all-in rate per side
    const allHaveFees = t.allFills.every((f) => f.commission + f.fees > 0);
    const commissions =
      allHaveFees
        ? Math.round(realFees * 100) / 100
        : Math.round(t.allFills.reduce((s, f) => s + f.qty, 0) * COMM_PER_SIDE * 100) / 100;
    const netUsd = Math.round((grossUsd - commissions) * 100) / 100;
    const result = grossUsd > 0.5 ? "win" : grossUsd < -0.5 ? "loss" : "flat";
    let exitReason: DaybookTradeSummary["exitReason"] = "other";
    if (t.exitAvg !== null && plan) {
      if (Math.abs(t.exitAvg - plan.target) <= TICK) exitReason = "target";
      else if (Math.abs(t.exitAvg - plan.stop) <= TICK) exitReason = "stop";
    }
    trades.push({
      day,
      timeET: plan?.timeET ?? "",
      side: t.dir,
      contracts: t.qty,
      family,
      verdict,
      entry: Math.round(t.entryAvg * 100) / 100,
      exit: t.exitAvg === null ? 0 : Math.round(t.exitAvg * 100) / 100,
      stop: plan?.stop ?? 0,
      target: plan?.target ?? 0,
      grossUsd,
      netUsd,
      commissions,
      result,
      heldMin: t.exitTs === null ? 0 : Math.round(((t.exitTs - t.entryTs) / MINUTE) * 10) / 10,
      exitReason,
    });
  }

  // RTH cap-skip replay against the collected tape
  const bars = loadBars(day);
  const capSkips = sigs.filter((s) => s.reason.includes("daily card cap"));
  const capReplay: DaybookDaySummary["capReplay"] = capSkips.map((s) => {
    const r = replayCard(s, bars);
    return {
      timeET: s.timeET,
      side: s.side,
      wouldHave: r.wouldHave,
      pts: r.pts === null ? null : Math.round(r.pts * 100) / 100,
      grossUsd: null,
    };
  });

  const healEpisodes = records.filter((r) => r.t === "heal").length;
  const expiries = records.filter((r) => r.t === "signal" && /expired|not filled/.test(String(r.reason ?? ""))).length;
  const retraceFills = records.filter((r) => r.t === "exec" && r.outcome === "limit_filled" && /retrace/i.test(String(r.label ?? ""))).length;

  const wins = trades.filter((t) => t.result === "win");
  const losses = trades.filter((t) => t.result === "loss");
  const summary: DaybookDaySummary = {
    day,
    source: "crossTrade+daybook",
    tradesN: trades.length,
    wins: wins.length,
    losses: losses.length,
    flats: trades.length - wins.length - losses.length,
    grossUsd: Math.round(trades.reduce((s, t) => s + t.grossUsd, 0) * 100) / 100,
    netUsd: Math.round(trades.reduce((s, t) => s + t.netUsd, 0) * 100) / 100,
    commissions: Math.round(trades.reduce((s, t) => s + t.commissions, 0) * 100) / 100,
    healEpisodes,
    capSkips: capSkips.length,
    capReplay,
    expRetrace: {
      expiries,
      fills: retraceFills,
      avgAdverseDriftPts: null,
    },
    trades,
  };

  const dir = path.join(DATA_DIR, "daybook");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${day}.summary.json`), JSON.stringify(summary, null, 2));
  // rewrite the day file as: the pulled live records (minus any previous
  // dayend) + exactly one fresh dayend — re-runs never double-count and
  // the R2 copy always mirrors the full record
  const base = records
    .filter((r) => r.t !== "dayend")
    .map((r) => JSON.stringify(r))
    .join("\n");
  writeFileSync(path.join(dir, `${day}.jsonl`), (base ? base + "\n" : "") + JSON.stringify({ t: "dayend", at: Date.now(), summary }) + "\n");

  // ---- report ---------------------------------------------------------
  const f = (n: number, dp = 0) => `${n >= 0 ? "+" : "−"}$${Math.abs(n).toFixed(dp)}`;
  console.log(`\n# Daybook consolidation — ${day}`);
  console.log(`${trades.length} trades · ${wins.length}W / ${losses.length}L · gross ${f(summary.grossUsd)} · net ${f(summary.netUsd)}`);
  console.log(`heal episodes ${healEpisodes} · cap skips ${capSkips.length} (replayed ${capReplay.filter((r) => r.wouldHave).length})`);
  for (const t of trades) {
    console.log(
      `- ${t.timeET || "??:??"} ${t.side.toUpperCase()} ${t.contracts} ${t.family || "other"} · ${t.result.toUpperCase()} ${f(t.grossUsd)} (net ${f(t.netUsd, 2)}) · in ${t.entry} out ${t.exit} · ${t.exitReason}`,
    );
  }
  for (const r of capReplay) {
    console.log(`- CAP SKIP ${r.timeET} ${r.side.toUpperCase()} → would have ${r.wouldHave ?? "?"}${r.pts === null ? "" : ` ${f(r.pts, 1)} pts`}`);
  }
}

main().catch((e) => {
  console.error("[daybookConsolidate] failed:", e);
  process.exit(1);
});
