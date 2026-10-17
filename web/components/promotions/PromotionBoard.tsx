"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

type Run = {
  id: number;
  run_at: string;
  script: string;
  cli: string;
  sha: string;
  family: string;
  gate: string;
  value: unknown;
  verdict: "passed" | "rejected";
  reasons: string[];
  note: string;
  applied: boolean;
};

type Study = {
  id: string;
  title: string;
  date: string;
  category: string;
  script: string;
  doc: string;
  status: "promoted" | "rejected" | "research";
  run: Run | null;
};

type Override = {
  id: number;
  family: string;
  gate: string;
  value: unknown;
  active: boolean;
  note: string;
  appliedAt: string | null;
  insightTitle: string | null;
};

type Payload = {
  ok: boolean;
  studies: Study[];
  runs: Run[];
  overrides: Override[];
  kelly: Record<string, string | boolean>;
  counts: Record<string, number>;
};

const STATUS_CHIP: Record<Study["status"], { label: string; cls: string }> = {
  promoted: { label: "✓ promoted", cls: "bg-long/15 text-long border-long/40" },
  rejected: { label: "✗ rejected", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
  research: { label: "research only", cls: "bg-zinc-800/60 text-zinc-400 border-zinc-700" },
};

/** /promotions — the promotion pipeline state, polled every 15s from
 *  /api/promotions: study catalog × contract verdicts (pass AND reject)
 *  × live override rows × Kelly knobs. One payload, one truth. */
export function PromotionBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const r = await fetch("/api/promotions", { cache: "no-store" });
        if (!r.ok) throw new Error(`http ${r.status}`);
        setData((await r.json()) as Payload);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    void load();
    timer.current = setInterval(load, 15_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, []);

  if (err && !data) {
    return <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">promotions API unreachable: {err}</p>;
  }
  if (!data) {
    return <p className="text-sm text-zinc-500">loading promotion state…</p>;
  }

  const kellyOn = data.kelly.kellyMode === true && data.kelly.kellyLiveUse === true;
  const ordered = [...data.studies].sort((a, b) => {
    const rank = (s: Study) => (s.status === "promoted" ? 0 : s.status === "rejected" ? 1 : 2);
    return rank(a) - rank(b) || b.date.localeCompare(a.date);
  });

  return (
    <div className="space-y-8">
      {/* summary chips */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">promoted</p>
          <p className="mt-1 text-2xl font-bold text-long">{data.counts.promoted}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">rejected (fail-closed)</p>
          <p className="mt-1 text-2xl font-bold text-red-400">{data.counts.rejected}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">active override rows</p>
          <p className="mt-1 text-2xl font-bold text-zinc-200">{data.counts.activeOverrides}</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">kelly sizing</p>
          <p className={`mt-1 text-2xl font-bold ${kellyOn ? "text-long" : "text-zinc-500"}`}>{kellyOn ? "LIVE" : "off"}</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">mult 0.5 · $100 cap · μ10</p>
        </div>
      </div>

      {/* study × verdict table */}
      <section>
        <h2 className="mb-1 font-mono text-xs uppercase tracking-widest text-zinc-500">studies × promotion verdicts</h2>
        <p className="mb-3 text-xs text-zinc-500">
          every study in the committed catalog, with its latest promotion-contract verdict. Rejections are recorded
          too — the direct path fails closed by design.
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2">status</th>
                <th className="px-3 py-2">study</th>
                <th className="px-3 py-2">gate proposed</th>
                <th className="px-3 py-2">verdict detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {ordered.map((s) => {
                const chip = STATUS_CHIP[s.status];
                return (
                  <tr key={s.id} className="align-top">
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${chip.cls}`}>{chip.label}</span>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/studies`} className="font-medium text-zinc-200 hover:text-long">
                        {s.title}
                      </Link>
                      <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                        {s.script || "research-only"} · {s.category}
                      </p>
                    </td>
                    <td className="px-3 py-2 font-mono text-[11px] text-zinc-400">
                      {s.run ? (
                        <>
                          {s.run.gate} → {JSON.stringify(s.run.value)}
                          <p className="mt-0.5 text-zinc-600">{s.run.family}</p>
                        </>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="max-w-md px-3 py-2 text-xs text-zinc-400">
                      {s.run ? (
                        <>
                          <p className="text-zinc-300">
                            {s.run.verdict === "passed" ? "contract clean" : "rejected"} · {new Date(s.run.run_at).toLocaleString()} ·{" "}
                            <span className="font-mono">{s.run.sha.slice(0, 7)}</span>
                            {s.run.applied ? " · applied" : ""}
                          </p>
                          {s.run.reasons.length > 0 && (
                            <ul className="mt-1 list-inside list-disc space-y-0.5 text-zinc-500">
                              {s.run.reasons.slice(0, 3).map((r, i) => (
                                <li key={i}>{r}</li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        <span className="text-zinc-600">no promotion candidate — journal/study evidence only</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* live override rows */}
      <section>
        <h2 className="mb-1 font-mono text-xs uppercase tracking-widest text-zinc-500">live override rows (strategy_overrides)</h2>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="px-3 py-2">state</th>
                <th className="px-3 py-2">family · gate</th>
                <th className="px-3 py-2">value</th>
                <th className="px-3 py-2">note</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60">
              {data.overrides.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-3 text-xs text-zinc-600">
                    no override rows yet — a contract-passing promotion writes the first one
                  </td>
                </tr>
              )}
              {data.overrides.map((o) => (
                <tr key={o.id}>
                  <td className="px-3 py-2">
                    <span
                      className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${
                        o.active ? "border-long/40 bg-long/15 text-long" : "border-zinc-700 bg-zinc-800/60 text-zinc-500"
                      }`}
                    >
                      {o.active ? "active" : "reverted"}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-300">
                    {o.family} · {o.gate}
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-zinc-400">{JSON.stringify(o.value)}</td>
                  <td className="max-w-md px-3 py-2 text-xs text-zinc-500">{o.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* kelly state */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-400">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">kelly state (server env)</p>
        <p>
          KELLY_MODE <span className="text-zinc-200">{String(data.kelly.kellyMode)}</span> · KELLY_LIVE_USE{" "}
          <span className="text-zinc-200">{String(data.kelly.kellyLiveUse)}</span> · mult{" "}
          <span className="text-zinc-200">{data.kelly.kellyMultDefault}</span> · cap{" "}
          <span className="text-zinc-200">{data.kelly.microCap}</span>
          {data.kelly.error ? <span className="ml-2 text-red-400">db error: {String(data.kelly.error)}</span> : null}
        </p>
        <p className="mt-1 text-zinc-600">
          live sizing switches to the Kelly path only when KELLY_MODE and KELLY_LIVE_USE are both 1; the day tiers and
          dd600→half still apply on top, and the μ10 ceiling keeps Kelly shrink-only vs the flat plan.
        </p>
      </section>
    </div>
  );
}
