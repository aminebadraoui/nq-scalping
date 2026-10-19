/* ------------------------------------------------------------------ *
 * execLedger — the joined Signal → Execution view (display-only).
 *
 * One row per card: the Telegram signal record (lib/signalHistory →
 * Neon `signals`) joined with the executor's live ledger
 * (lib/execTracker → Neon `exec_trades`) and the exec log (Neon
 * `exec_log`). Signals that were generated but never executed (gated,
 * capped, blacked out) appear as signal-only rows; limit-entry cards
 * from before the 2026-10-16 journaling fix appear as exec-only rows.
 *
 * Join keys:
 *   primary  exec_trades.signal_id = signals.key
 *   fallback same day + time_et + side + family (pre-fix limit cards
 *            carry signal_id = "" but the family|day|side|time key)
 *
 * Pure merge — unit-tested (tests/execLedger.test.ts). No order path,
 * no gate, no mutation: the route only reads Neon.
 * ------------------------------------------------------------------ */

import { canonicalFamily } from "./strategies/aliases";

export type LedgerSignal = {
  key: string;
  ts: number;
  day: string;
  time_et: string;
  side: string;
  verdict: string;
  headline: string;
  sent: boolean;
  reason: string;
  outcome: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
};

export type LedgerExec = {
  key: string;
  signal_id: string;
  ts: number;
  day: string;
  time_et: string;
  label: string;
  family: string;
  side: string;
  contracts: number;
  sig_entry: number | null;
  sig_stop: number | null;
  sig_target: number | null;
  order_id: string;
  status: string;
  fill_entry: number | null;
  fill_entry_at: number | null;
  exit_avg: number | null;
  exit_fills: Array<{ ts: number; action: string; qty: number; price: number }> | null;
  pts: number | null;
  gross_usd: number;
  fees_usd: number;
  net_usd: number;
  result: string;
};

export type LedgerLog = {
  key: string;
  outcome: string;
  reason: string;
};

export type LedgerRow = {
  id: string;
  ts: number;
  day: string;
  timeET: string;
  side: string;
  family: string;
  headline: string;
  verdict: string;
  /** null = no signal record (exec-only row) */
  sent: boolean | null;
  sentReason: string;
  signalOutcome: string;
  contracts: number;
  sigEntry: number | null;
  sigStop: number | null;
  sigTarget: number | null;
  /** null = never executed (signal-only row) */
  status: string | null;
  orderId: string;
  fillEntry: number | null;
  fillEntryAt: number | null;
  exitAvg: number | null;
  exitFills: Array<{ ts: number; action: string; qty: number; price: number }>;
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: string;
  execReason: string;
  linked: "both" | "signal" | "exec";
};

export type LedgerSummary = {
  cards: number;
  sent: number;
  notSent: number;
  executed: number;
  closed: number;
  wins: number;
  losses: number;
  netUsd: number;
};

/** verdict string → family slug (the exec_trades.family vocabulary) */
export function familyFromVerdict(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v.includes("sweep")) return "sweep_reclaim";
  if (v.includes("rth")) return "rth";
  if (v.includes("big-bar") || v.includes("momentum")) return "momentum";
  if (v.includes("open")) return "open";
  return "";
}

/** does this exec row plausibly belong to this signal (fallback join)? */
export function execMatchesSignalFallback(e: LedgerExec, s: LedgerSignal): boolean {
  if (e.signal_id === s.key) return true;
  if (e.day !== s.day || e.time_et !== s.time_et || e.side !== s.side) return false;
  const fam = familyFromVerdict(s.verdict);
  // 2026-10-19 rename bridge: canonicalize both sides (historical exec
  // rows hold legacy slugs; the verdict parser may emit either).
  return fam !== "" && canonicalFamily(e.family) === canonicalFamily(fam);
}

export function mergeExecLedger(
  signals: LedgerSignal[],
  execs: LedgerExec[],
  logs: LedgerLog[],
): { rows: LedgerRow[]; summary: LedgerSummary } {
  const logByKey = new Map(logs.map((l) => [l.key, l]));
  const sigByKey = new Map(signals.map((s) => [s.key, s]));
  const consumed = new Set<string>();

  const rows: LedgerRow[] = [];

  for (const e of execs) {
    // primary: the resolver stamped the signal key at fill time
    let sig = e.signal_id ? (sigByKey.get(e.signal_id) ?? null) : null;
    if (!sig) {
      // fallback: same day/time/side/family (pre-fix limit cards)
      sig =
        signals.find((s) => !consumed.has(s.key) && execMatchesSignalFallback(e, s)) ?? null;
    }
    if (sig) consumed.add(sig.key);
    const log = logByKey.get(e.key);
    rows.push({
      id: sig?.key ?? e.key,
      ts: Math.max(e.ts, sig?.ts ?? 0),
      day: sig?.day ?? e.day,
      timeET: sig?.time_et ?? e.time_et,
      side: sig?.side ?? e.side,
      family: e.family || (sig ? familyFromVerdict(sig.verdict) : ""),
      headline: sig?.headline ?? e.label,
      verdict: sig?.verdict ?? "",
      sent: sig ? sig.sent : null,
      sentReason: sig?.reason ?? "",
      signalOutcome: sig?.outcome ?? "",
      contracts: e.contracts,
      sigEntry: e.sig_entry ?? sig?.entry ?? null,
      sigStop: e.sig_stop ?? sig?.stop ?? null,
      sigTarget: e.sig_target ?? sig?.target ?? null,
      status: e.status,
      orderId: e.order_id,
      fillEntry: e.fill_entry,
      fillEntryAt: e.fill_entry_at,
      exitAvg: e.exit_avg,
      exitFills: e.exit_fills ?? [],
      pts: e.pts,
      grossUsd: Number(e.gross_usd),
      feesUsd: Number(e.fees_usd),
      netUsd: Number(e.net_usd),
      result: e.result,
      execReason: log?.reason ?? "",
      linked: sig ? "both" : "exec",
    });
  }

  for (const s of signals) {
    if (consumed.has(s.key)) continue;
    rows.push({
      id: s.key,
      ts: s.ts,
      day: s.day,
      timeET: s.time_et,
      side: s.side,
      family: familyFromVerdict(s.verdict),
      headline: s.headline,
      verdict: s.verdict,
      sent: s.sent,
      sentReason: s.reason,
      signalOutcome: s.outcome,
      contracts: 0,
      sigEntry: s.entry,
      sigStop: s.stop,
      sigTarget: s.target,
      status: null,
      orderId: "",
      fillEntry: null,
      fillEntryAt: null,
      exitAvg: null,
      exitFills: [],
      pts: null,
      grossUsd: 0,
      feesUsd: 0,
      netUsd: 0,
      result: "",
      execReason: "",
      linked: "signal",
    });
  }

  rows.sort((a, b) => b.ts - a.ts);

  const closed = rows.filter((r) => r.status === "closed");
  const summary: LedgerSummary = {
    cards: rows.length,
    sent: rows.filter((r) => r.sent === true).length,
    notSent: rows.filter((r) => r.sent === false).length,
    executed: rows.filter((r) => r.status !== null).length,
    closed: closed.length,
    wins: closed.filter((r) => r.result === "win").length,
    losses: closed.filter((r) => r.result === "loss").length,
    netUsd: Math.round(closed.reduce((a, r) => a + r.netUsd, 0) * 100) / 100,
  };

  return { rows, summary };
}
