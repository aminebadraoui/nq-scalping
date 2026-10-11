"use client";

import { useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * Execution log — the executor's own records, polled from /api/exec-log
 * every 60s. Display-only; nothing here can start, stop, or alter a
 * trade. See web/lib/execLog.ts for the writer + schema.
 * ------------------------------------------------------------------ */

type ExecLogRow = {
  ts: string | number;
  key: string;
  label: string;
  attempt: string;
  outcome: string;
  reason: string;
};

type ExecLogResponse = {
  ok: boolean;
  rows?: ExecLogRow[];
  note?: string;
  error?: string;
};

const outcomeTone = (outcome: string): string => {
  if (outcome === "ok" || outcome === "filled") return "text-long";
  if (outcome.startsWith("failed")) return "text-short";
  return "text-zinc-400";
};

const fmtTime = (ts: string | number): string => {
  const t = Number(ts);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
};

export default function ExecLogPanel() {
  const [rows, setRows] = useState<ExecLogRow[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/exec-log")
        .then((r) => r.json())
        .then((j: ExecLogResponse) => {
          if (cancelled) return;
          if (!j.ok) {
            setError(j.error ?? "failed to load");
            setLoaded(true);
            return;
          }
          setRows(j.rows ?? []);
          setNote(j.note ?? null);
          setError(null);
          setLoaded(true);
        })
        .catch(() => {
          if (!cancelled) setError("network error");
        });
    };
    tick();
    timerRef.current = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">
          Execution log — the executor&apos;s own records (latest 200)
        </h2>
        {note && <span className="font-mono text-[10px] text-zinc-500">{note}</span>}
      </div>

      {error ? (
        <p className="font-mono text-xs text-short">{error}</p>
      ) : loaded && rows.length === 0 ? (
        <p className="font-mono text-xs text-zinc-600">
          {note ? "no execution records in the database" : "no execution records yet — the executor writes here on every order attempt"}
        </p>
      ) : (
        <div className="max-h-[420px] overflow-x-auto overflow-y-auto rounded border border-zinc-800">
          <table className="w-full border-collapse font-mono text-xs">
            <thead className="sticky top-0 z-10 bg-panel">
              <tr className="text-left text-zinc-500">
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">time (NY)</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">label</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">attempt</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">outcome</th>
                <th className="border-b border-zinc-800 px-2 py-1 font-normal">reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ts}|${i}`} className="align-top text-zinc-400">
                  <td className="px-2 py-1 whitespace-nowrap text-zinc-500">{fmtTime(r.ts)}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.label}</td>
                  <td className="px-2 py-1 whitespace-nowrap">{r.attempt}</td>
                  <td className={`px-2 py-1 whitespace-nowrap ${outcomeTone(r.outcome)}`}>{r.outcome}</td>
                  <td className="px-2 py-1 break-words">{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
