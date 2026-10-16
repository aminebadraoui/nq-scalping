"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * ExecLedgerPanel — the joined Signal → Execution view.
 *
 * One row per card: the Telegram signal record joined with the
 * executor's ledger (place → fill → flat) and the exec log. Rows where
 * no execution happened (gated / capped / blacked out) show the
 * Telegram status + skip reason; rows from before the limit-card
 * journaling fix show execution only.
 *
 * Polls /api/exec-ledger every 20s (display-only read of Neon).
 * ------------------------------------------------------------------ */

type LedgerRow = {
  id: string;
  ts: number;
  day: string;
  timeET: string;
  side: string;
  family: string;
  headline: string;
  verdict: string;
  sent: boolean | null;
  sentReason: string;
  signalOutcome: string;
  contracts: number;
  sigEntry: number | null;
  sigStop: number | null;
  sigTarget: number | null;
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

type LedgerResponse = {
  ok: boolean;
  rows: LedgerRow[];
  summary: {
    cards: number;
    sent: number;
    notSent: number;
    executed: number;
    closed: number;
    wins: number;
    losses: number;
    netUsd: number;
  } | null;
  error?: string;
};

const fmt = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits);

const fmtUsd = (n: number | null | undefined, forceSign = true): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : forceSign ? "+" : "";
  return `${sign}$${Math.abs(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const netTone = (n: number): string => (n > 0 ? "text-long" : n < 0 ? "text-short" : "text-zinc-400");

const FAMILY_BADGE: Record<string, { label: string; cls: string }> = {
  momentum: { label: "MOM", cls: "border-info/40 bg-info/10 text-info" },
  rth: { label: "RTH", cls: "border-violet-500/40 bg-violet-500/10 text-violet-300" },
  open: { label: "OPEN", cls: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" },
  sweep_reclaim: { label: "SWP", cls: "border-zinc-600 bg-zinc-800/40 text-zinc-300" },
};

const STATUS_STYLE: Record<string, string> = {
  placed: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  filled: "border-info/40 bg-info/10 text-info",
  closed: "border-zinc-600 bg-zinc-800/40 text-zinc-300",
  failed: "border-short/40 bg-short/10 text-short",
  gated: "border-zinc-600 bg-zinc-800/40 text-zinc-400",
};

const RESULT_STYLE: Record<string, string> = {
  win: "border-long/40 bg-long/10 text-long",
  loss: "border-short/40 bg-short/10 text-short",
  flat: "border-zinc-600 bg-zinc-800/40 text-zinc-300",
};

function statusChip(r: LedgerRow): { label: string; cls: string } {
  if (r.status !== null && r.status !== "") {
    const st = STATUS_STYLE[r.status] ? r.status : "gated";
    return { label: r.status, cls: STATUS_STYLE[st] };
  }
  // signal-only row: the card never reached the executor
  return { label: "not executed", cls: STATUS_STYLE.gated };
}

function tgCell(r: LedgerRow): { label: string; cls: string; title: string } {
  if (r.sent === null) return { label: "—", cls: "text-zinc-500", title: "no signal record (pre-journaling exec row)" };
  if (r.sent) return { label: "✓ sent", cls: "text-long", title: "Telegram accepted the card" };
  return { label: "✗ not sent", cls: "text-short", title: r.sentReason || "skipped" };
}

function ExitDetail({ r }: { r: LedgerRow }) {
  if (r.exitFills.length === 0) return null;
  return (
    <span className="block text-[10px] text-zinc-500">
      {r.exitFills
        .map((f) => `${f.action === "Buy" ? "B" : "S"}${f.qty} @ ${fmt(f.price)}`)
        .join(" · ")}
    </span>
  );
}

export default function ExecLedgerPanel() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [summary, setSummary] = useState<LedgerResponse["summary"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/exec-ledger", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: LedgerResponse) => {
          if (cancelled) return;
          if (!j.ok) {
            setError(j.error ?? "ledger unavailable");
            return;
          }
          setRows(j.rows ?? []);
          setSummary(j.summary ?? null);
          setError(null);
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setError("ledger fetch failed");
        });
    };
    tick();
    timerRef.current = setInterval(tick, 20_000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const chip = (label: string, value: string, tone: string) => (
    <span className="rounded-md border border-zinc-800 bg-panel px-3 py-1.5 text-center">
      <span className="block font-mono text-[9px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`block font-mono text-sm ${tone}`}>{value}</span>
    </span>
  );

  return (
    <section className="rounded-lg border border-zinc-800 bg-panel/60 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div>
          <h2 className="font-mono text-xs uppercase tracking-wider text-zinc-400">signal → execution ledger</h2>
          <p className="mt-1 text-[11px] text-zinc-500">
            every generated card: Telegram delivery + the executor&apos;s record (place → fill → flat) — live, joined, one row per card
          </p>
        </div>
        {summary && (
          <div className="flex gap-2">
            {chip("cards", String(summary.cards), "text-zinc-200")}
            {chip("sent", `${summary.sent}✓ / ${summary.notSent}✗`, summary.notSent > 0 ? "text-amber-300" : "text-long")}
            {chip("executed", String(summary.executed), "text-info")}
            {chip("closed", `${summary.wins}W / ${summary.losses}L`, "text-zinc-200")}
            {chip("net", fmtUsd(summary.netUsd), netTone(summary.netUsd))}
          </div>
        )}
      </div>

      {error && <p className="mb-2 text-xs text-short">{error}</p>}
      {!loaded && !error && <p className="text-xs text-zinc-500">loading ledger…</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-zinc-800 font-mono text-[9px] uppercase tracking-wider text-zinc-500">
              <th className="px-2 py-1.5">time ET</th>
              <th className="px-2 py-1.5">fam</th>
              <th className="px-2 py-1.5">card</th>
              <th className="px-2 py-1.5">tg</th>
              <th className="px-2 py-1.5 text-right">qty</th>
              <th className="px-2 py-1.5 text-right">entry</th>
              <th className="px-2 py-1.5 text-right">exit</th>
              <th className="px-2 py-1.5 text-right">pts</th>
              <th className="px-2 py-1.5 text-right">gross</th>
              <th className="px-2 py-1.5 text-right">fees</th>
              <th className="px-2 py-1.5 text-right">net</th>
              <th className="px-2 py-1.5">exec</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const st = statusChip(r);
              const tg = tgCell(r);
              const fam = FAMILY_BADGE[r.family] ?? { label: r.family.slice(0, 3).toUpperCase() || "—", cls: "border-zinc-700 bg-zinc-800/40 text-zinc-400" };
              const entry = r.fillEntry ?? r.sigEntry;
              const res = r.result !== "" ? RESULT_STYLE[r.result] : null;
              return (
                <tr key={r.id} className="border-b border-zinc-900 hover:bg-zinc-900/40">
                  <td className="px-2 py-1.5 font-mono whitespace-nowrap text-zinc-400">
                    {r.day.slice(5)} {r.timeET}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[9px] ${fam.cls}`}>{fam.label}</span>
                  </td>
                  <td className="max-w-[260px] px-2 py-1.5">
                    <span className="mr-1 font-semibold text-zinc-200">{r.side === "long" ? "🟢" : r.side === "short" ? "🔴" : ""}</span>
                    <span className="text-zinc-300">{r.headline}</span>
                    {(r.sent === false && r.sentReason) && (
                      <span className="block text-[10px] text-short">{r.sentReason}</span>
                    )}
                    {r.execReason && r.status === "failed" && (
                      <span className="block text-[10px] text-short">{r.execReason}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className={`font-mono text-[10px] ${tg.cls}`} title={tg.title}>
                      {tg.label}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-zinc-300">{r.contracts || "—"}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-zinc-300">
                    {fmt(entry)}
                    {r.fillEntry !== null && r.fillEntry !== r.sigEntry && (
                      <span className="block text-[9px] text-zinc-500">sig {fmt(r.sigEntry)}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-zinc-300">
                    {fmt(r.exitAvg)}
                    <ExitDetail r={r} />
                  </td>
                  <td className={`px-2 py-1.5 text-right font-mono ${netTone(r.pts ?? 0)}`}>{fmt(r.pts, 2)}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${netTone(r.grossUsd)}`}>{fmtUsd(r.grossUsd, r.status === "closed")}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-zinc-500">{r.feesUsd ? fmtUsd(r.feesUsd, false) : "—"}</td>
                  <td className={`px-2 py-1.5 text-right font-mono font-semibold ${netTone(r.netUsd)}`}>
                    {r.status === "closed" ? fmtUsd(r.netUsd) : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <span className="inline-flex items-center gap-1">
                      <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${st.cls}`}>{st.label}</span>
                      {res && r.status === "closed" && (
                        <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] ${res}`}>{r.result}</span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {loaded && rows.length === 0 && (
              <tr>
                <td colSpan={12} className="px-2 py-4 text-center text-zinc-500">
                  no cards in the window yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
