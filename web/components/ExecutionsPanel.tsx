"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * ExecutionsPanel — which signal got executed, what the execution was
 * on Tradovate (order id, entry fill, exit fills), and how much money
 * it won or lost (net = gross − fees, MNQ $2/pt).
 *
 * Polls /api/executions (lib/execTracker.ts — the live ledger written
 * by the execution watcher as cards place → fill → flat). The nightly
 * reconcile (scripts/reconcileTrades.ts) remains the historical record.
 * ------------------------------------------------------------------ */

type ExecRow = {
  key: string;
  signalId: string;
  ts: number;
  day: string;
  timeET: string;
  label: string;
  family: string;
  side: "long" | "short";
  contracts: number;
  sigEntry: number;
  sigStop: number;
  sigTarget: number;
  orderId: string;
  status: "placed" | "filled" | "closed" | "failed";
  fillEntry: number | null;
  fillEntryAt: number | null;
  exitAvg: number | null;
  pts: number | null;
  grossUsd: number;
  feesUsd: number;
  netUsd: number;
  result: "" | "win" | "loss" | "flat";
};

type ExecResponse = {
  ok: boolean;
  rows: ExecRow[];
  summary?: { n: number; closed: number; wins: number; losses: number; netUsd: number };
  note?: string;
};

type ManualRow = {
  key: string;
  kind: "manual_trade" | "manual_order";
  at: number;
  day: string;
  timeET: string;
  side: "long" | "short" | "";
  qty: number;
  entryPrice: number | null;
  exitPrice: number | null;
  pnlUsd: number | null;
  orderId: string;
  closed: boolean;
  note: string;
};

type ManualResponse = {
  ok: boolean;
  rows: ManualRow[];
  summary?: { n: number; trades: number; open: number; orders: number; netUsd: number };
};

const fmt = (n: number | null | undefined, digits = 2): string =>
  n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits);

const fmtUsd = (n: number | null | undefined, forceSign = true): string => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : forceSign ? "+" : "";
  return `${sign}$${Math.abs(Math.round(n * 100) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false });

const STATUS_STYLE: Record<ExecRow["status"], string> = {
  placed: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  filled: "border-info/40 bg-info/10 text-info",
  closed: "border-zinc-600 bg-zinc-800/40 text-zinc-300",
  failed: "border-short/40 bg-short/10 text-short",
};

const STATUS_LABEL: Record<ExecRow["status"], string> = {
  placed: "placed",
  filled: "filled",
  closed: "closed",
  failed: "failed",
};

export default function ExecutionsPanel() {
  const [rows, setRows] = useState<ExecRow[]>([]);
  const [summary, setSummary] = useState<ExecResponse["summary"] | null>(null);
  const [manual, setManual] = useState<ManualRow[]>([]);
  const [manualSummary, setManualSummary] = useState<ManualResponse["summary"] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/executions", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: ExecResponse) => {
          if (cancelled || !j.ok) return;
          setRows(j.rows ?? []);
          setSummary(j.summary ?? null);
          setLoaded(true);
        })
        .catch(() => {});
      fetch("/api/manual", { cache: "no-store" })
        .then((r) => r.json())
        .then((j: ManualResponse) => {
          if (cancelled || !j.ok) return;
          setManual(j.rows ?? []);
          setManualSummary(j.summary ?? null);
        })
        .catch(() => {});
    };
    tick();
    timerRef.current = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const netTone = (n: number) => (n > 0 ? "text-long" : n < 0 ? "text-short" : "text-zinc-400");

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Executed signals — CrossTrade → Tradovate, live
        </h2>
        {summary && summary.closed > 0 && (
          <span className="font-mono text-[10px] text-zinc-500">
            {summary.wins}W / {summary.losses}L · net{" "}
            <span className={netTone(summary.netUsd)}>{fmtUsd(summary.netUsd)}</span>
          </span>
        )}
      </div>

      {loaded && rows.length === 0 ? (
        <p className="font-mono text-xs text-zinc-600">
          no executed signals yet — rows appear the moment a card is dispatched (live mode)
        </p>
      ) : (
        <div className="max-h-[480px] overflow-x-auto overflow-y-auto rounded border border-zinc-800">
          <table className="w-full border-collapse font-mono text-xs">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="text-left text-zinc-500">
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">time (NY)</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">signal</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">side · n</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">entry (signal)</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">fill</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">exit</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal" title="signed points across the contracts">pts</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">fees</th>
                <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net $</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">tradovate</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="align-top text-zinc-400">
                  <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{fmtTime(r.ts)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span title={`signal ${r.signalId || "unlinked"} · ${r.day} ${r.timeET}`}>{r.label}</span>
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap text-right">
                    <span className={r.side === "long" ? "text-long" : "text-short"}>{r.side.toUpperCase()}</span>{" "}
                    {r.contracts}
                  </td>
                  <td className="px-2 py-1 text-right">{fmt(r.sigEntry)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.fillEntry)}</td>
                  <td className="px-2 py-1 text-right">{fmt(r.exitAvg)}</td>
                  <td className={`px-2 py-1 text-right ${netTone(r.pts ?? 0)}`}>{fmt(r.pts, 1)}</td>
                  <td className="px-2 py-1 text-right text-zinc-500">{r.feesUsd ? `−${fmt(r.feesUsd)}` : "—"}</td>
                  <td className={`px-2 py-1 text-right font-semibold ${netTone(r.netUsd)}`}>{fmtUsd(r.netUsd)}</td>
                  <td className="px-2 py-1 whitespace-nowrap text-zinc-500" title="Tradovate entry order id (from the matched fill)">
                    {r.orderId ? <span className="text-zinc-400">{r.orderId}</span> : "—"}
                  </td>
                  <td className="px-2 py-1 whitespace-nowrap">
                    <span className={`rounded border px-1 py-0.5 text-[9px] ${STATUS_STYLE[r.status]}`}>
                      {STATUS_LABEL[r.status]}
                      {r.status === "closed" && r.result ? ` ${r.result}` : ""}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-2 font-mono text-[10px] text-zinc-600">
        entry/exit are broker fill prices · fees = real fill fees when the fill export carries them, else the
        reconcile fallback ($0.95/side) · the nightly reconcile is the historical record (Journal tab)
      </p>

      {/* ---- manual actions — what the account did that the bot didn't ---- */}
      <div className="mt-4 border-t border-zinc-800 pt-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-bold uppercase tracking-wider text-warn">
            Manual actions — fills/orders the bot cannot account for
          </h3>
          {manualSummary && manualSummary.n > 0 && (
            <span className="font-mono text-[10px] text-zinc-500">
              {manualSummary.trades} trade(s) · {manualSummary.open} open · {manualSummary.orders} order(s) · net{" "}
              <span className={netTone(manualSummary.netUsd)}>{fmtUsd(manualSummary.netUsd)}</span>
            </span>
          )}
        </div>
        {manual.length === 0 ? (
          <p className="font-mono text-xs text-zinc-600">no manual activity — every MNQ fill/order belongs to a tracked trade</p>
        ) : (
          <div className="max-h-[260px] overflow-x-auto overflow-y-auto rounded border border-zinc-800">
            <table className="w-full border-collapse font-mono text-xs">
              <thead className="sticky top-0 z-10 bg-panel">
                <tr className="text-left text-zinc-500">
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">time (NY)</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">kind</th>
                  <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">side · qty</th>
                  <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">entry</th>
                  <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">exit</th>
                  <th className="border-b border-zinc-800 px-2 py-1 text-right font-normal">net $</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">tradovate</th>
                  <th className="border-b border-zinc-800 px-2 py-1 font-normal">note</th>
                </tr>
              </thead>
              <tbody>
                {manual.map((m) => (
                  <tr key={m.key} className="align-top text-zinc-400">
                    <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{fmtTime(m.at)}</td>
                    <td className="px-2 py-1 whitespace-nowrap">
                      <span
                        className={`rounded border px-1 py-0.5 text-[9px] ${
                          m.kind === "manual_order"
                            ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                            : m.closed
                              ? "border-zinc-600 bg-zinc-800/40 text-zinc-300"
                              : "border-warn/50 bg-warn/10 text-warn"
                        }`}
                      >
                        {m.kind === "manual_order" ? "order" : m.closed ? "trade" : "OPEN"}
                      </span>
                    </td>
                    <td className="px-2 py-1 whitespace-nowrap text-right">
                      {m.side ? (
                        <span className={m.side === "long" ? "text-long" : "text-short"}>{m.side.toUpperCase()}</span>
                      ) : (
                        "—"
                      )}{" "}
                      {m.qty || "—"}
                    </td>
                    <td className="px-2 py-1 text-right">{fmt(m.entryPrice)}</td>
                    <td className="px-2 py-1 text-right">{fmt(m.exitPrice)}</td>
                    <td className={`px-2 py-1 text-right font-semibold ${netTone(m.pnlUsd ?? 0)}`}>{fmtUsd(m.pnlUsd)}</td>
                    <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{m.orderId ? <span className="text-zinc-400">{m.orderId}</span> : "—"}</td>
                    <td className="px-2 py-1 break-words text-zinc-500">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
