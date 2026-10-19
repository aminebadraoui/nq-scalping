/* ------------------------------------------------------------------ *
 * Trade ledger — the all-variables trade table.
 *
 * One row per bot trade (signal ↔ CrossTrade fills), carrying every
 * number the system knew or tracked when the trade was taken:
 *
 *   · the signal card (levels, size, verdict, headline)
 *   · the feature vector recorded at fire time (`signals.features` /
 *     `trades.features` jsonb) — including context that does NOT
 *     participate in the signal (dom evidence, options walls, ES /
 *     seasonal / round-number context, kelly chip, gate snapshot)
 *   · the execution anatomy (drift, MFE/MAE, stop-run, loss label)
 *   · the SYSTEM VARIATION in effect when the trade fired: the daybook
 *     boot record (git SHA + the full masked settings snapshot) that
 *     precedes the trade on its day
 *   · the account the trade belongs to (fire-time stamp when present,
 *     otherwise the 2026-10-05 reset date boundary)
 *
 * Pure functions over plain rows — unit-tested and shared by the API
 * route (/api/trades/table) and the journal's full-variable table.
 * ------------------------------------------------------------------ */

import { familyOf } from "./tradeStats";
import { canonicalFamily } from "./strategies/aliases";
import type { DaybookRecord } from "./daybook";
import { accountForDay, resolveAccount, type AccountSource } from "./accountAttribution";

export type LedgerRow = {
  key: string;
  day: string;
  timeET: string;
  ts: number;
  account: string;
  accountSource: AccountSource;
  variationId: string | null;
  buildSha: string | null;
  side: string;
  contracts: number;
  family: string;
  verdict: string;
  headline: string;
  status: string; // matched | unexecuted | partial | no-fill
  result: string; // win | loss | flat | ''
  sigEntry: number | null;
  sigStop: number | null;
  sigTarget: number | null;
  fillEntry: number | null;
  exitAvg: number | null;
  grossUsd: number;
  netUsd: number;
  drift: number | null;
  mfe: number | null;
  mae: number | null;
  heldMin: number | null;
  stopRun: boolean;
  targetReached: boolean;
  recovered: boolean;
  lossLabel: string;
  size: string;
  source: string;
  test: boolean;
  sent: boolean;
  reason: string;
  features: Record<string, unknown> | null;
  /** the masked settings snapshot of the boot in effect (variation) */
  settings: Record<string, string> | null;
};

export type LedgerVariable = { key: string; count: number };

/* ---- account attribution -------------------------------------------- */

/* The ONE attribution source is lib/accountAttribution.ts: the
 * fire-time stamp on the row wins; legacy rows fall back to the known
 * account-switch timeline. Nothing here keeps its own constants. */

/* ---- feature flattening ---------------------------------------------- */

const MAX_DEPTH = 3;

/** Flatten a nested feature object to dotted-path leaves: plain objects
 *  walk down (bounded depth); arrays and other values become leaves.
 *  This makes the dom/options/ES context cells printable and the CSV
 *  columns deterministic. */
export function flattenFeatures(f: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!f || typeof f !== "object") return out;
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined) continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const isPlain = typeof v === "object" && !Array.isArray(v);
      if (isPlain && depth < MAX_DEPTH) {
        walk(v as Record<string, unknown>, path, depth + 1);
      } else if (isPlain) {
        out[path] = JSON.stringify(v);
      } else if (Array.isArray(v)) {
        out[path] = JSON.stringify(v);
      } else {
        out[path] = v;
      }
    }
  };
  walk(f, "", 0);
  return out;
}

/** every distinct flattened variable across the rows, most common first */
export function distinctVariables(rows: LedgerRow[]): LedgerVariable[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const k of Object.keys(flattenFeatures(r.features))) {
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/* ---- row builders ---------------------------------------------------- */

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const bool = (v: unknown): boolean => v === true || v === "true" || v === 1 || v === "t";

type DbTradeRow = Record<string, unknown>;

/** Map a `trades` row (joined with its signal) to a ledger row. */
export function buildRowFromDb(r: DbTradeRow, index = 0): LedgerRow {
  const day = String(r.day ?? "");
  const acct = resolveAccount(r.account, day);
  const featuresRaw = r.features ?? null;
  let features: Record<string, unknown> | null = null;
  if (featuresRaw !== null && featuresRaw !== undefined) {
    try {
      features = typeof featuresRaw === "string" ? JSON.parse(featuresRaw) : (featuresRaw as Record<string, unknown>);
    } catch {
      features = null;
    }
  }
  return {
    key: String(r.signal_key ?? `row-${index}`),
    day,
    timeET: String(r.time_et ?? ""),
    ts: Number(r.ts ?? 0),
    account: acct.account,
    accountSource: acct.source,
    variationId: null,
    buildSha: null,
    side: String(r.side ?? ""),
    contracts: Number(r.contracts ?? 0),
    family: canonicalFamily(String(r.family ?? familyOf(String(r.verdict ?? "")))),
    verdict: String(r.verdict ?? ""),
    headline: String(r.headline ?? ""),
    status: String(r.status ?? "matched"),
    result: String(r.result ?? ""),
    sigEntry: num(r.sig_entry),
    sigStop: num(r.sig_stop),
    sigTarget: num(r.sig_target),
    fillEntry: num(r.fill_entry),
    exitAvg: num(r.exit_avg),
    grossUsd: Number(r.gross_usd ?? 0),
    netUsd: Number(r.net_usd ?? 0),
    drift: num(r.entry_adverse_pts),
    mfe: num(r.mfe_pts),
    mae: num(r.mae_pts),
    heldMin: num(r.held_min),
    stopRun: bool(r.stop_run),
    targetReached: bool(r.target_reached),
    recovered: bool(r.recovered),
    lossLabel: String(r.loss_label ?? ""),
    size: String(r.sig_size ?? ""),
    source: String(r.sig_source ?? r.source ?? ""),
    test: bool(r.sig_test ?? r.test),
    sent: bool(r.sig_sent ?? r.sent),
    reason: String(r.sig_reason ?? r.reason ?? ""),
    features,
    settings: null,
  };
}

export function buildRowsFromDb(rows: DbTradeRow[]): LedgerRow[] {
  return rows.map((r, i) => buildRowFromDb(r, i));
}

/* ---- daybook fallback (DB-less) -------------------------------------- */

export type DaybookDayPack = { day: string; recs: DaybookRecord[] };

/** Join the DB-less journal: dayend summary trades ← daybook signal
 *  records (same day + side, timeET when present, otherwise order).
 *  Records are deduped first: the local volume and the R2 archive can
 *  both carry copies of the same line; only the newest dayend summary
 *  per day counts (older consolidations superseded). */
export function buildRowsFromDaybook(packs: DaybookDayPack[]): LedgerRow[] {
  const out: LedgerRow[] = [];
  for (const { day, recs } of packs) {
    const seenSig = new Set<string>();
    const signals = recs
      .filter((r): r is Extract<DaybookRecord, { t: "signal" }> => r.t === "signal")
      .filter((s) => s.side === "long" || s.side === "short")
      .sort((a, b) => a.at - b.at)
      .filter((s) => {
        const k = `${s.at}|${s.timeET}|${s.side}|${s.verdict}`;
        if (seenSig.has(k)) return false;
        seenSig.add(k);
        return true;
      });
    const dayends = recs
      .filter((r): r is Extract<DaybookRecord, { t: "dayend" }> => r.t === "dayend")
      .sort((a, b) => b.at - a.at)
      .slice(0, 1);
    const trades = dayends.flatMap((r) => (r.summary as { trades?: Array<Record<string, unknown>> } | undefined)?.trades ?? [])
      .filter((t) => t.side === "long" || t.side === "short");
    const used = new Set<number>();
    const acct = accountForDay(day);

    const pick = (side: string, timeET: string): number => {
      // exact timeET match first (same-minute card); otherwise the next
      // unmatched signal of the side, chronologically
      const idx = signals.findIndex((s, i) => !used.has(i) && s.side === side && timeET !== "" && s.timeET === timeET);
      return idx >= 0 ? idx : signals.findIndex((s, i) => !used.has(i) && s.side === side);
    };

    for (const t of trades) {
      const side = String(t.side);
      const timeET = String(t.timeET ?? "");
      const idx = pick(side, timeET);
      const sig = idx >= 0 ? signals[idx] : null;
      if (idx >= 0) used.add(idx);
      const family = canonicalFamily(String(t.family ?? (sig ? familyOf(sig.verdict) : "other")));
      const verdict = String(t.verdict ?? sig?.verdict ?? "");
      const ts = sig?.at ?? Date.parse(`${day}T12:00:00-05:00`);
      out.push({
        key: `${day}|${timeET || (sig?.timeET ?? "")}|${side}|${out.length}`,
        day,
        timeET: timeET || (sig?.timeET ?? ""),
        ts: Number.isFinite(ts) ? ts : 0,
        account: acct,
        accountSource: "timeline",
        variationId: null,
        buildSha: null,
        side,
        contracts: Number(t.contracts ?? 0),
        family,
        verdict,
        headline: sig?.headline ?? "",
        status: "matched",
        result: String(t.result ?? ""),
        sigEntry: num(sig?.entry ?? t.entry),
        sigStop: num(sig?.stop ?? t.stop),
        sigTarget: num(sig?.target ?? t.target),
        fillEntry: num(t.entry),
        exitAvg: num(t.exit),
        grossUsd: Number(t.grossUsd ?? 0),
        netUsd: Number(t.netUsd ?? 0),
        drift: null,
        mfe: null,
        mae: null,
        heldMin: num(t.heldMin),
        stopRun: false,
        targetReached: false,
        recovered: false,
        lossLabel: "",
        size: sig?.size ?? "",
        source: sig?.source ?? "",
        test: false,
        sent: sig?.sent ?? false,
        reason: sig?.reason ?? "",
        features: sig?.features ?? null,
        settings: null,
      });
    }
    // signals no summary trade explains (vetoed / never filled) — the
    // full decision set, so the table is not a biased sample
    signals.forEach((s, i) => {
      if (used.has(i)) return;
      out.push({
        key: `${day}|${s.timeET}|${s.side}|${out.length}`,
        day,
        timeET: s.timeET,
        ts: s.at,
        account: acct,
        accountSource: "timeline",
        variationId: null,
        buildSha: null,
        side: s.side,
        contracts: 0,
        family: familyOf(s.verdict),
        verdict: s.verdict,
        headline: s.headline,
        status: "no-fill",
        result: "",
        sigEntry: num(s.entry),
        sigStop: num(s.stop),
        sigTarget: num(s.target),
        fillEntry: null,
        exitAvg: null,
        grossUsd: 0,
        netUsd: 0,
        drift: null,
        mfe: null,
        mae: null,
        heldMin: null,
        stopRun: false,
        targetReached: false,
        recovered: false,
        lossLabel: "",
        size: s.size,
        source: s.source,
        test: false,
        sent: s.sent,
        reason: s.reason,
        features: s.features ?? null,
        settings: null,
      });
    });
  }
  return out.sort((a, b) => b.ts - a.ts);
}

/* ---- variation attachment -------------------------------------------- */

/** Attach to each row the daybook boot record in effect when the trade
 *  fired: the latest boot at or before the trade's ts (the first boot of
 *  the day when the row carries no ts). Boot settings are already masked
 *  (secrets → stable hashes) by the daybook writer. */
export function attachVariations(
  rows: LedgerRow[],
  dayRecs: Map<string, DaybookRecord[]>,
): void {
  for (const r of rows) {
    const recs = dayRecs.get(r.day) ?? [];
    const boots = recs
      .filter((x): x is Extract<DaybookRecord, { t: "boot" }> => x.t === "boot")
      .sort((a, b) => a.at - b.at);
    if (!boots.length) continue;
    const inEffect = boots.filter((b) => b.at <= r.ts).at(-1) ?? boots[0];
    r.variationId = inEffect.variationId;
    r.buildSha = inEffect.sha;
    r.settings = inEffect.settings ?? null;
  }
}

/* ---- CSV -------------------------------------------------------------- */

export const LEDGER_CORE_COLUMNS = [
  "day",
  "timeET",
  "account",
  "accountSource",
  "family",
  "side",
  "contracts",
  "status",
  "result",
  "sigEntry",
  "sigStop",
  "sigTarget",
  "fillEntry",
  "exitAvg",
  "drift",
  "mfe",
  "mae",
  "heldMin",
  "grossUsd",
  "netUsd",
  "variationId",
] as const;

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(Math.round(v * 10000) / 10000);
  if (typeof v === "boolean") return v ? "1" : "0";
  return String(v);
}

const csvField = (v: unknown): string => {
  const s = cell(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** flat CSV: core columns then every distinct variable as a column */
export function ledgerCsv(rows: LedgerRow[], variables: string[]): string {
  const header = [...LEDGER_CORE_COLUMNS, ...variables];
  const lines = [header.join(",")];
  for (const r of rows) {
    const flat = flattenFeatures(r.features);
    const core: Record<string, unknown> = {
      day: r.day,
      timeET: r.timeET,
      account: r.account,
      accountSource: r.accountSource,
      family: r.family,
      side: r.side,
      contracts: r.contracts,
      status: r.status,
      result: r.result,
      sigEntry: r.sigEntry,
      sigStop: r.sigStop,
      sigTarget: r.sigTarget,
      fillEntry: r.fillEntry,
      exitAvg: r.exitAvg,
      drift: r.drift,
      mfe: r.mfe,
      mae: r.mae,
      heldMin: r.heldMin,
      grossUsd: r.grossUsd,
      netUsd: r.netUsd,
      variationId: r.variationId,
    };
    lines.push(header.map((h) => csvField((h in core ? core[h] : flat[h]) ?? "")).join(","));
  }
  return lines.join("\n");
}
