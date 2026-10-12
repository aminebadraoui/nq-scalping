/* ------------------------------------------------------------------ *
 * Execution-latency telemetry — per-cycle stage timers + the
 * CrossTrade submit→fill tracker.
 *
 * Every signal-feed tick records one "cycle" with four stages, the
 * exact split the execution tab shows:
 *   · getData    — buildSnapshot(): assemble the live signal context
 *   · feedCheck  — tape-gate freshness checks (is the feed update real?)
 *   · compute    — the detectors + gates + card assembly (per-check
 *                  breakdown kept in detail.checks)
 *   · dispatch   — executor.placeOrder/placeScaleOut: send to CrossTrade
 *                  and wait for the placement ack (measured at the
 *                  lib/executor.ts choke point)
 * plus detectLagMs — how far into the current minute the dispatch
 * happened, i.e. how long after the trigger bar closed the card fired
 * (the 15s poll penalty; 0 = the bar was detected the moment it closed).
 *
 * "fill" records measure the broker leg: CrossTrade placement POST
 * submit → REST ack (submitMs/ackMs) → the broker's own fill timestamp
 * (fillMs) → when our 90s watcher actually saw it (seenMs).
 *
 * Records live in a module-global registry (read by /api/exec-latency)
 * and are persisted best-effort to Neon (exec_latency table, created
 * lazily) so the history survives container restarts. Nothing here can
 * ever change a trading decision: every hook is additive timing only.
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "./gcdb";
import { appendDaybook } from "./daybook";

const TABLE_SQL = `
create table if not exists exec_latency (
  id bigint generated always as identity primary key,
  ts bigint not null,
  kind text not null default 'cycle',   -- cycle | fill
  total_ms real not null default 0,
  stages jsonb not null default '{}',   -- {"getData":12.1,"feedCheck":0.9,"compute":5.2,"dispatch":701.5}
  detail jsonb not null default '{}'    -- {"note":…,"detectLagMs":…,"label":…,"dir":…,"submitMs":…,"fillMs":…}
);
create index if not exists exec_latency_ts_idx on exec_latency (ts desc);
create index if not exists exec_latency_kind_idx on exec_latency (kind, ts desc);
`;

export type CycleStage = "getData" | "feedCheck" | "compute" | "dispatch";

export type CycleRecord = {
  id: string;
  ts: number;
  kind: "cycle";
  totalMs: number;
  stages: Partial<Record<CycleStage, number>>;
  detail: {
    detectLagMs?: number;
    /** bar close → this tick, every cycle: the continuous detection-lag
     *  metric (0 = the tick ran the instant the bar completed; the 15s
     *  poll makes it ~uniform 0–15s) */
    barAgeMs?: number;
    note?: string;
    /** per-check breakdown of the compute stage */
    checks?: Array<{ name: string; ms: number }>;
  };
};

export type FillRecord = {
  id: string;
  ts: number; // placement submit epoch
  kind: "fill";
  /** submit→fill when filled; submit→ack while the fill is unknown */
  totalMs: number;
  stages: Record<string, never>;
  detail: {
    label: string;
    dir: string;
    qty: number;
    /** POST placement round-trip (submit → ack) */
    submitMs: number;
    ackMs: number | null;
    /** ack → broker fill timestamp (null = no fill seen yet) */
    fillMs: number | null;
    /** fill → our watcher noticing it */
    seenMs: number | null;
  };
};

export type LatencyRecord = CycleRecord | FillRecord;

export type LatencySnapshot = {
  /** the cycle currently running (stages fill in as it goes) */
  current: { id: string; startedAt: number; stages: Partial<Record<CycleStage, number>>; checks: Array<{ name: string; ms: number }> } | null;
  latest: CycleRecord | null;
  lastFills: FillRecord[];
  window: CycleRecord[];
};

const MAX_WINDOW = 120;
const MAX_FILLS = 20;
const FILL_MATCH_WINDOW_MS = 10 * 60_000;
const PRUNE_AFTER_MS = 14 * 24 * 3600_000;

/* ---- module-global registry (one container = one event loop; the
 *      signal feed's ticking guard ensures a single active cycle) ---- */

const g = globalThis as unknown as {
  __gcExecLatency?: {
    active: {
      id: string;
      startedAt: number;
      stages: Partial<Record<CycleStage, number>>;
      checks: Array<{ name: string; ms: number }>;
      detectLagMs?: number;
      barAgeMs?: number;
    } | null;
    latest: CycleRecord | null;
    window: CycleRecord[];
    lastFills: FillRecord[];
    pendingFills: Array<{ id: string; rowId: number | null; at: number; label: string; dir: string; qty: number }>;
    /** the just-finished cycle, still accepting late marks (fire-and-forget
     *  dispatch promises resolve after finishCycle) for GRACE_MS */
    grace: { obj: { id: string; startedAt: number; stages: Partial<Record<CycleStage, number>>; checks: Array<{ name: string; ms: number }>; detectLagMs?: number; barAgeMs?: number }; until: number } | null;
    ready: boolean;
    lastPruneAt: number;
  };
};

function state() {
  if (!g.__gcExecLatency) {
    g.__gcExecLatency = {
      active: null,
      latest: null,
      window: [],
      lastFills: [],
      pendingFills: [],
      grace: null,
      ready: false,
      lastPruneAt: 0,
    };
  }
  return g.__gcExecLatency;
}

const GRACE_MS = 5_000;

/** the cycle marks should attach to: the running one, or the just-finished
 *  one while its fire-and-forget promises are still settling */
function activeFor(): {
  id: string;
  startedAt: number;
  stages: Partial<Record<CycleStage, number>>;
  checks: Array<{ name: string; ms: number }>;
  detectLagMs?: number;
  barAgeMs?: number;
} | null {
  const s = state();
  if (s.active) return s.active;
  if (s.grace && Date.now() < s.grace.until) return s.grace.obj;
  return null;
}

export function latencySnapshot(): LatencySnapshot {
  const s = state();
  return {
    current: s.active ? { id: s.active.id, startedAt: s.active.startedAt, stages: { ...s.active.stages }, checks: [...s.active.checks] } : null,
    latest: s.latest,
    lastFills: [...s.lastFills],
    window: [...s.window],
  };
}

/* ---- cycle lifecycle ------------------------------------------------- */

/** open a new cycle (idempotent — an unfinished cycle is discarded) */
export function startCycle(): string {
  const s = state();
  const id = `cyc|${Date.now().toString(36)}|${Math.random().toString(36).slice(2, 6)}`;
  s.active = { id, startedAt: Date.now(), stages: {}, checks: [] };
  return id;
}

/** add ms to a stage of the ACTIVE cycle (no-op when none is running) */
export function markStage(stage: CycleStage, ms: number): void {
  const a = activeFor();
  if (!a) return;
  a.stages[stage] = (a.stages[stage] ?? 0) + ms;
}

/** record one detector/gate check inside the compute stage */
export function markCheck(name: string, ms: number): void {
  const a = activeFor();
  if (!a) return;
  a.stages.compute = (a.stages.compute ?? 0) + ms;
  a.checks.push({ name, ms });
}

/** record a dispatch (executor choke point): ms + how late in the minute
 *  the dispatch happened (lag since the trigger bar closed) */
export function markDispatch(ms: number, detectLagMs?: number): void {
  const s = state();
  const a = activeFor();
  if (!a) return;
  a.stages.dispatch = (a.stages.dispatch ?? 0) + ms;
  if (detectLagMs !== undefined) {
    a.detectLagMs = detectLagMs;
    // grace-window (late) marks: the finished record's detail was already
    // built — stamp it through so the snapshot shows the lag too
    if (s.latest && s.latest.id === a.id) s.latest.detail.detectLagMs = Math.round(detectLagMs);
  }
}

/** record the age of the last completed bar at this tick (bar close →
 *  now) — the continuous detection-lag metric, stamped every cycle */
export function markBarAge(ms: number): void {
  const s = state();
  const a = activeFor();
  if (!a) return;
  a.barAgeMs = ms;
  if (s.latest && s.latest.id === a.id) s.latest.detail.barAgeMs = Math.round(ms);
}

/** close the active cycle: total, latest, window, persist. No-op when
 *  nothing is open. */
export function finishCycle(note?: string): void {
  const s = state();
  const a = s.active;
  if (!a) return;
  s.active = null;
  s.grace = { obj: a, until: Date.now() + GRACE_MS };
  const record: CycleRecord = {
    id: a.id,
    ts: a.startedAt,
    kind: "cycle",
    totalMs: Math.max(0, Date.now() - a.startedAt),
    // reference the live object so grace-window marks still show here
    stages: a.stages,
    detail: {
      ...(a.detectLagMs !== undefined ? { detectLagMs: Math.round(a.detectLagMs) } : {}),
      ...(a.barAgeMs !== undefined ? { barAgeMs: Math.round(a.barAgeMs) } : {}),
      ...(note ? { note } : {}),
      ...(a.checks.length ? { checks: a.checks.map((c) => ({ name: c.name, ms: Math.round(c.ms * 10) / 10 })) } : {}),
    },
  };
  s.latest = record;
  s.window.unshift(record);
  if (s.window.length > MAX_WINDOW) s.window.length = MAX_WINDOW;
  void persist(record);
}

/* ---- CrossTrade submit→fill ------------------------------------------ */

/** register a REST placement about to be POSTed (returns the entry id).
 *  Live placements only — dry-runs never produce fills. */
export function noteOrderSubmit(label: string, dir: "long" | "short", qty: number): string | null {
  const s = state();
  const id = `fill|${Date.now().toString(36)}|${Math.random().toString(36).slice(2, 6)}`;
  const at = Date.now();
  s.pendingFills.push({ id, rowId: null, at, label, dir, qty });
  if (s.pendingFills.length > 50) s.pendingFills = s.pendingFills.slice(-25);
  const record: FillRecord = {
    id,
    ts: at,
    kind: "fill",
    totalMs: 0,
    stages: {},
    detail: { label, dir, qty, submitMs: 0, ackMs: null, fillMs: null, seenMs: null },
  };
  s.lastFills.unshift(record);
  if (s.lastFills.length > MAX_FILLS) s.lastFills.length = MAX_FILLS;
  void persist(record, (rowId) => {
    const p = state().pendingFills.find((x) => x.id === id);
    if (p) p.rowId = rowId;
  });
  return id;
}

/** the placement POST returned — stamp the round-trip duration */
export function noteOrderAck(id: string | null, ackMs: number, submitMs: number): void {
  const s = state();
  const rec = id ? s.lastFills.find((f) => f.id === id) : s.lastFills[0];
  if (rec) {
    rec.detail.ackMs = Math.round(ackMs);
    rec.detail.submitMs = Math.round(submitMs);
    rec.totalMs = Math.round(submitMs);
    void updateRow(rec);
  }
}

/** the watcher matched a broker fill for a pending placement — close the
 *  submit→fill leg with the broker's own fill timestamp */
export function noteOrderFill(dir: string, qty: number, fillTs: number): void {
  const s = state();
  let best: { id: string; rowId: number | null; at: number; label: string; dir: string; qty: number } | null = null;
  for (const p of s.pendingFills) {
    if (p.dir !== dir || p.qty !== qty) continue;
    if (fillTs < p.at || fillTs - p.at > FILL_MATCH_WINDOW_MS) continue;
    if (!best || p.at > best.at) best = p;
  }
  if (!best) return;
  s.pendingFills = s.pendingFills.filter((p) => p.id !== best.id);
  const rec = s.lastFills.find((f) => f.id === best.id);
  if (!rec) return;
  rec.detail.fillMs = Math.max(0, fillTs - best.at);
  rec.detail.seenMs = Math.max(0, Date.now() - fillTs);
  rec.totalMs = rec.detail.fillMs;
  void updateRow(rec);
  void appendDaybook({
    t: "latency",
    at: Date.now(),
    label: rec.detail.label,
    kind: "fill",
    dir: rec.detail.dir,
    qty: rec.detail.qty,
    submitMs: rec.detail.submitMs,
    ackMs: rec.detail.ackMs,
    fillMs: rec.detail.fillMs,
    seenMs: rec.detail.seenMs,
  });
}

/* ---- persistence (best-effort — never blocks or throws) -------------- */

async function ensureTable(): Promise<boolean> {
  const s = state();
  if (s.ready) return true;
  if (!dbEnabled()) return false;
  try {
    await getDb().unsafe(TABLE_SQL);
    s.ready = true;
    return true;
  } catch {
    return false;
  }
}

/** create the exec_latency table if it does not exist (the API route
 *  calls this so a fresh DB reads empty instead of erroring) */
export async function ensureLatencyTable(): Promise<boolean> {
  return ensureTable();
}

async function persist(record: LatencyRecord, onRow?: (rowId: number) => void): Promise<void> {
  try {
    const ok = await ensureTable();
    if (!ok) return;
    const stages = record.kind === "cycle" ? JSON.stringify(record.stages) : "{}";
    const detail = JSON.stringify(record.detail);
    const rows = (await getDb()`
      insert into exec_latency (ts, kind, total_ms, stages, detail)
      values (${record.ts}, ${record.kind}, ${Math.round(record.totalMs)}, ${stages}, ${detail})
      returning id`) as Array<{ id: number }>;
    if (onRow && rows?.[0]) onRow(Number(rows[0].id));
    void pruneOld();
  } catch {
    /* best-effort — the in-memory registry still serves the current view */
  }
}

async function updateRow(record: FillRecord): Promise<void> {
  const p = state().pendingFills.find((x) => x.id === record.id);
  const rowId = p?.rowId ?? null;
  if (rowId === null) return;
  try {
    const ok = await ensureTable();
    if (!ok) return;
    await getDb()`
      update exec_latency
      set total_ms = ${Math.round(record.totalMs)}, detail = ${JSON.stringify(record.detail)}
      where id = ${rowId}`;
  } catch {
    /* best-effort */
  }
}

async function pruneOld(): Promise<void> {
  const s = state();
  const now = Date.now();
  if (now - s.lastPruneAt < 24 * 3600_000) return;
  s.lastPruneAt = now;
  try {
    await getDb()`
      delete from exec_latency where ts < ${now - PRUNE_AFTER_MS}`;
  } catch {
    /* best-effort */
  }
}

/* ---- aggregates (pure — unit-tested) --------------------------------- */

/** nearest-rank percentile over a sorted-ascending copy */
export function pct(list: number[], p: number): number | null {
  const xs = [...list].sort((a, b) => a - b);
  if (!xs.length) return null;
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1));
  return xs[idx];
}

/** p50/p95 per stage over a set of cycle records */
export function stageAggregates(cycles: CycleRecord[]): Partial<Record<CycleStage, { p50: number | null; p95: number | null; n: number }>> {
  const by: Partial<Record<CycleStage, number[]>> = {};
  for (const c of cycles) {
    for (const k of ["getData", "feedCheck", "compute", "dispatch"] as CycleStage[]) {
      const v = c.stages[k];
      if (typeof v === "number" && Number.isFinite(v)) (by[k] ??= []).push(v);
    }
  }
  const out: Partial<Record<CycleStage, { p50: number | null; p95: number | null; n: number }>> = {};
  for (const k of Object.keys(by) as CycleStage[]) {
    const xs = by[k]!;
    out[k] = { p50: pct(xs, 50), p95: pct(xs, 95), n: xs.length };
  }
  return out;
}

/** TEST ONLY: reset the registry. */
export function __resetExecLatencyForTest(): void {
  const s = state();
  s.active = null;
  s.grace = null;
  s.latest = null;
  s.window = [];
  s.lastFills = [];
  s.pendingFills = [];
  s.ready = false;
  s.lastPruneAt = 0;
}
