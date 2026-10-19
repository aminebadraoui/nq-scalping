/* ------------------------------------------------------------------ *
 * Unified journal entries — ONE entry per trade, bot or manual.
 *
 * The journal's ground truth is a single list. Every entry carries an
 * explicit `origin` (bot = backed by a signal card in `trades`; manual =
 * a broker round trip no signal explains, in `manual_trades` with
 * matched_signal null) and an explicit `account` (lib/accountAttribution).
 *
 * Pure functions over plain rows — unit-tested, shared by the journal
 * API and any other surface that needs the combined trade record.
 *
 * Not included (by design):
 *   · manual_trades rows with matched_signal set — those are provenance
 *     for a bot trade's correction, not trades of their own;
 *   · live intraday rows (lib/execTracker / lib/manualDetect) — the
 *     API merges those in as today's preview and dedupes by identity.
 * ------------------------------------------------------------------ */

import { resolveAccount, type AccountSource } from "./accountAttribution";
import { familyOf } from "./tradeStats";
import { canonicalFamily } from "./strategies/aliases";

export type JournalOrigin = "bot" | "manual";

export type JournalEntry = {
  /** bot: the signal_key · manual: the manual_trades key */
  key: string;
  origin: JournalOrigin;
  day: string;
  timeET: string;
  /** epoch ms (signal fire time / manual entry time) */
  ts: number;
  account: string;
  accountSource: AccountSource;
  side: "long" | "short";
  contracts: number;
  /** bot: strategy family · manual: "" */
  family: string;
  /** manual: contract symbol · bot: "" */
  symbol: string;
  status: "matched" | "unexecuted" | "partial";
  result: "" | "win" | "loss" | "flat";
  fillEntry: number | null;
  exitAvg: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  /** manual rows only — the audit evidence (hover detail, never identity) */
  audit: { label: string; reason: string; nearestSignal: string | null } | null;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const sideOf = (s: unknown): JournalEntry["side"] => (String(s ?? "") === "short" ? "short" : "long");

/** "HH:mm" New York from epoch ms */
export function etTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }).slice(0, 5);
}

/** manual P&L is NET when the import carried it (MFF), else gross. */
export function manualNetUsd(row: Record<string, unknown>): number {
  const net = numOrNull(row.pnl_net_usd);
  return net === null ? num(row.pnl_usd) : net;
}

export function manualFeesUsd(row: Record<string, unknown>): number {
  const fees = numOrNull(row.fees_usd);
  if (fees !== null) return fees;
  const gross = num(row.pnl_usd);
  const net = numOrNull(row.pnl_net_usd);
  return net === null ? 0 : Math.round(Math.max(0, gross - net) * 100) / 100;
}

/** map one `trades` row (bot) to a journal entry */
export function botEntry(r: Record<string, unknown>): JournalEntry {
  const day = String(r.day ?? "");
  const acct = resolveAccount(r.account, day);
  const status = String(r.status ?? "unexecuted");
  const netUsd = status === "matched" ? num(r.net_usd) : 0;
  const grossUsd = status === "matched" ? num(r.gross_usd) : 0;
  return {
    key: String(r.signal_key ?? ""),
    origin: "bot",
    day,
    timeET: String(r.time_et ?? ""),
    ts: num(r.ts),
    account: acct.account,
    accountSource: acct.source,
    side: sideOf(r.side),
    contracts: num(r.contracts),
    family: canonicalFamily(String(r.family ?? "") || familyOf(String(r.verdict ?? ""))),
    symbol: "",
    status: status === "matched" ? "matched" : status === "partial" ? "partial" : "unexecuted",
    result: (["win", "loss", "flat"].includes(String(r.result ?? "")) ? String(r.result) : "") as JournalEntry["result"],
    fillEntry: numOrNull(r.fill_entry),
    exitAvg: numOrNull(r.exit_avg),
    grossUsd,
    feesUsd: status === "matched" ? num(r.commissions) : 0,
    netUsd,
    audit: null,
  };
}

/** map one `manual_trades` row (matched_signal null) to a journal entry */
export function manualEntry(r: Record<string, unknown>): JournalEntry {
  const day = String(r.day ?? "");
  const acct = resolveAccount(r.account, day);
  const grossUsd = num(r.pnl_usd);
  const netUsd = manualNetUsd(r);
  return {
    key: String(r.key ?? ""),
    origin: "manual",
    day,
    timeET: etTime(num(r.entry_at ? Date.parse(String(r.entry_at)) : NaN)),
    ts: num(r.entry_at ? Date.parse(String(r.entry_at)) : NaN),
    account: acct.account,
    accountSource: acct.source,
    side: String(r.direction ?? "") === "short" ? "short" : "long",
    contracts: num(r.qty),
    family: "",
    symbol: String(r.symbol ?? ""),
    status: "matched",
    result: netUsd > 0.5 ? "win" : netUsd < -0.5 ? "loss" : "flat",
    fillEntry: numOrNull(r.entry_price),
    exitAvg: numOrNull(r.exit_price),
    grossUsd,
    feesUsd: manualFeesUsd(r),
    netUsd,
    audit: null,
  };
}

/** the unified list: bot trades + manual trips, newest first */
export function buildEntries(
  botRows: Array<Record<string, unknown>>,
  manualRows: Array<Record<string, unknown>>,
): JournalEntry[] {
  const out: JournalEntry[] = [];
  for (const r of botRows) out.push(botEntry(r));
  for (const r of manualRows) out.push(manualEntry(r));
  return out.sort((a, b) => b.ts - a.ts || a.key.localeCompare(b.key));
}

export type AccountRollupRow = {
  account: string;
  botN: number;
  manualN: number;
  botNet: number;
  manualNet: number;
  net: number;
  firstDay: string;
  lastDay: string;
};

/** per-account rollup over the unified list (money that ties out) */
export function accountRollup(entries: JournalEntry[]): AccountRollupRow[] {
  const map = new Map<string, AccountRollupRow>();
  const bucket = (account: string) => {
    let b = map.get(account);
    if (!b) {
      b = { account, botN: 0, manualN: 0, botNet: 0, manualNet: 0, net: 0, firstDay: "", lastDay: "" };
      map.set(account, b);
    }
    return b;
  };
  for (const e of entries) {
    const b = bucket(e.account);
    if (!b.firstDay || e.day < b.firstDay) b.firstDay = e.day;
    if (!b.lastDay || e.day > b.lastDay) b.lastDay = e.day;
    if (e.status !== "matched") continue;
    if (e.origin === "bot") {
      b.botN++;
      b.botNet += e.netUsd;
    } else {
      b.manualN++;
      b.manualNet += e.netUsd;
    }
    b.net += e.netUsd;
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  return [...map.values()]
    .map((b) => ({ ...b, botNet: round(b.botNet), manualNet: round(b.manualNet), net: round(b.net) }))
    .sort((a, b) => a.account.localeCompare(b.account));
}

/** the accounts present in the entries, for filter chips */
export function entryAccounts(entries: JournalEntry[]): string[] {
  return [...new Set(entries.map((e) => e.account))].sort();
}
