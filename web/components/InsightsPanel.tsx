"use client";

import { useEffect, useRef, useState } from "react";

type Insight = {
  id: string;
  run_at: string;
  strategy: string;
  kind: "rule_proposal" | "observation" | "execution" | "narrative";
  severity: "info" | "warn" | "opportunity";
  title: string;
  finding: string;
  evidence: Record<string, unknown>;
  proposedAction: { family: string; gate: string; value: unknown; note: string } | null;
  auto_apply: boolean;
  status: "proposed" | "applied" | "rejected" | "superseded";
  source: string;
};

type Override = {
  id: string;
  created_at: string;
  family: string;
  gate: string;
  value: unknown;
  active: boolean;
  note: string;
  insight_title: string | null;
};

type Response = { ok: boolean; insights: Insight[]; overrides: Override[] };

const SEV_STYLE: Record<Insight["severity"], string> = {
  info: "border-info/40 bg-info/10 text-info",
  warn: "border-warn/50 bg-warn/10 text-warn",
  opportunity: "border-long/50 bg-long/10 text-long",
};

const STATUS_STYLE: Record<string, string> = {
  proposed: "border-info/40 bg-info/10 text-info",
  applied: "border-long/50 bg-long/10 text-long",
  rejected: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
  superseded: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
};

const ev = (e: Record<string, unknown>, k: string): string => {
  const v = e[k];
  if (v === null || v === undefined) return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
};

export default function InsightsPanel() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [overrides, setOverrides] = useState<Override[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    fetch("/api/insights")
      .then((r) => r.json())
      .then((j: Response) => {
        if (!j.ok) return;
        setInsights(j.insights ?? []);
        setOverrides(j.overrides ?? []);
        setLoaded(true);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 60_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const post = (body: Record<string, unknown>) => {
    setBusy(JSON.stringify(body));
    fetch("/api/insights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
      .then((r) => r.json())
      .then(() => {
        setBusy(null);
        load();
      })
      .catch(() => setBusy(null));
  };

  const activeOverrides = overrides.filter((o) => o.active);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Insights — self-improvement</h2>
        <span className="font-mono text-[10px] text-zinc-500">
          {activeOverrides.length} active gate{activeOverrides.length === 1 ? "" : "s"}
        </span>
      </div>

      <p className="mb-2 font-mono text-[10px] leading-snug text-zinc-500">
        the nightly miner proposes gate changes from the trade record; approve here and the live feed applies them within
        minutes — no deploy
      </p>

      {activeOverrides.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {activeOverrides.map((o) => (
            <div key={o.id} className="flex items-center justify-between gap-2 rounded border border-long/40 bg-long/5 px-1.5 py-1">
              <span className="font-mono text-[9px] text-long">
                {o.family}.{o.gate} = {JSON.stringify(o.value)} · {o.note}
              </span>
              <button
                onClick={() => post({ action: "disable", overrideId: Number(o.id) })}
                className="rounded border border-zinc-700 px-1 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-short hover:text-short"
              >
                disable
              </button>
            </div>
          ))}
        </div>
      )}

      {loaded && insights.length === 0 && (
        <p className="font-mono text-xs text-zinc-600">no insights yet — run scripts/strategyInsights.ts</p>
      )}

      <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
        {insights.map((i) => (
          <div key={i.id} className="rounded border border-zinc-800/70 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="break-words font-mono text-[11px] font-semibold text-zinc-100">{i.title}</span>
              <span className="flex shrink-0 items-center gap-1">
                <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${SEV_STYLE[i.severity]}`}>{i.severity}</span>
                <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${STATUS_STYLE[i.status] ?? STATUS_STYLE.proposed}`}>
                  {i.status}
                </span>
              </span>
            </div>

            <div className="mt-0.5 flex items-center justify-between gap-2 font-mono text-[9px] text-zinc-600">
              <span>
                {i.strategy} · {i.kind}
                {i.source === "llm" ? " · LLM" : ""}
              </span>
              <span className="whitespace-nowrap">
                {Object.entries(i.evidence)
                  .slice(0, 3)
                  .map(([k, v]) => `${k}=${ev(i.evidence, k)}`)
                  .join(" ")}
              </span>
            </div>

            <p className="mt-1 break-words font-mono text-[10px] leading-snug text-zinc-400">{i.finding}</p>

            {i.status === "proposed" && i.proposedAction && (
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="break-words font-mono text-[9px] text-info">
                  → {i.proposedAction.family}.{i.proposedAction.gate}: {i.proposedAction.note}
                  {i.auto_apply ? " (auto when SELF_IMPROVE=1)" : ""}
                </span>
                <span className="flex shrink-0 gap-1">
                  <button
                    disabled={busy !== null}
                    onClick={() => post({ action: "apply", id: Number(i.id) })}
                    className="rounded border border-long/50 bg-long/10 px-1.5 py-0.5 font-mono text-[9px] text-long hover:bg-long/20 disabled:opacity-40"
                  >
                    apply
                  </button>
                  <button
                    disabled={busy !== null}
                    onClick={() => post({ action: "reject", id: Number(i.id) })}
                    className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[9px] text-zinc-400 hover:border-short hover:text-short disabled:opacity-40"
                  >
                    reject
                  </button>
                </span>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
