"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";

/* ---------- payload shapes (mirror web/app/api/weekly-review/route.ts) ---------- */

type StatRow = {
  group: string;
  label: string;
  n: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossUsd: number;
  netUsd: number;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  expectancyUsd: number | null;
  stopRuns: number;
  stopRunRate: number | null;
  avgEntryAdversePts: number | null;
  avgMfePts: number | null;
  avgMaePts: number | null;
};

type Edge = {
  family: string;
  n: number;
  wins: number;
  losses: number;
  meanExpR: number | null;
  baselineExpR: number;
  status: "ok" | "watch" | "breach" | "insufficient";
  detail: string;
};

type Cohort = {
  n: number;
  wr: number;
  wrCi: [number, number];
  pf: number;
  expPts: number;
  expR: number;
  sessions: number;
  train?: Cohort;
  test?: Cohort;
};

type StudyReport = {
  script: string;
  cli: string;
  sha: string;
  splitDate: string;
  stack: string;
  family: string;
  gate: string;
  value: unknown;
  note: string;
  baseline: Cohort;
  candidate: Cohort;
  vetoedSharePct?: number;
  vetoed?: Cohort;
  viability?: {
    evalPass: boolean;
    fundedPass: boolean;
    evalTestPass: boolean;
    fundedTestPass: boolean;
  };
  grid?: { variants: number; dsr?: number; pbo?: number };
};

type Study = {
  name: string;
  cli: string;
  exit: number | null;
  verdict: "passed" | "rejected" | "error";
  reasons: string[];
  logTail: string;
  report: StudyReport | null;
};

type ReviewStats = {
  week: string;
  trades: { count: number; overall: StatRow | null; families: StatRow[] };
  edges: Edge[];
  signals: { sent: number; vetoedTotal: number; vetoedByFamily: Array<{ family: string; n: number }> };
  friction: Array<Record<string, unknown>>;
  insights: Array<Record<string, unknown>>;
  promotions: Array<Record<string, unknown>>;
  overrides: { active: Array<Record<string, unknown>>; autoReverts: Array<Record<string, unknown>> };
};

type WeekSummary = {
  week_start: string;
  week_end: string;
  generated_at: string;
  trades: number;
  net: number;
};

type InsightRow = {
  id: number;
  run_at: string;
  strategy: string;
  kind: string;
  severity: string;
  title: string;
  finding: string;
  evidence: unknown;
  proposedAction: { family: string; gate: string; value: unknown; note: string } | null;
  auto_apply: boolean;
  status: string;
  source: string;
};

type Payload = {
  ok: boolean;
  weeks: WeekSummary[];
  review: {
    id: number;
    week_start: string;
    week_end: string;
    generated_at: string;
    sha: string;
    stats: ReviewStats | null;
    studies: Study[];
    narrative: string;
    narrative_source: string;
    telegram_sent: boolean;
  } | null;
  insights: InsightRow[];
};

const VERDICT_CHIP: Record<Study["verdict"], { label: string; cls: string }> = {
  passed: { label: "✓ contract clean", cls: "bg-long/15 text-long border-long/40" },
  rejected: { label: "✗ rejected", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
  error: { label: "⚠ study failed", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
};

const EDGE_CHIP: Record<Edge["status"], { label: string; cls: string }> = {
  ok: { label: "ok", cls: "bg-long/15 text-long border-long/40" },
  watch: { label: "watch", cls: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  breach: { label: "breach", cls: "bg-red-500/10 text-red-400 border-red-500/30" },
  insufficient: { label: "collecting", cls: "bg-zinc-800/60 text-zinc-400 border-zinc-700" },
};

const fmtUsd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const pct = (n: number | null): string => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

function cohortCells(c: Cohort | undefined): string {
  if (!c || c.n === 0) return "n=0";
  return `n=${c.n} · WR ${c.wr.toFixed(1)}% (CI ${c.wrCi[0].toFixed(0)}–${c.wrCi[1].toFixed(0)}) · PF ${c.pf.toFixed(2)} · expR ${c.expR.toFixed(3)}`;
}

/** /review — the Saturday self-improvement loop, polled every 15s from
 *  /api/weekly-review: the week rollup × promotion-contract verdicts ×
 *  the backtest proposals (apply/reject via POST /api/insights) × the
 *  LLM week narrative. */
export function WeeklyBoard() {
  const [data, setData] = useState<Payload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [week, setWeek] = useState<string>("");
  const [busy, setBusy] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async (w: string) => {
    try {
      const r = await fetch(`/api/weekly-review${w ? `?week=${encodeURIComponent(w)}` : ""}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`http ${r.status}`);
      const j = (await r.json()) as Payload;
      setData(j);
      setErr(null);
      if (!w && j.review) setWeek(j.review.week_start);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load("");
    timer.current = setInterval(() => void load(week), 15_000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [load, week]);

  const pickWeek = (w: string) => {
    setWeek(w);
    void load(w);
  };

  const act = async (id: number, action: "apply" | "reject") => {
    setBusy(id);
    try {
      const r = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id }),
      });
      if (!r.ok) throw new Error(`http ${r.status}`);
      void load(week);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (err && !data) {
    return <p className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400">weekly-review API unreachable: {err}</p>;
  }
  if (!data) {
    return <p className="text-sm text-zinc-500">loading the weekly review…</p>;
  }
  if (!data.review) {
    return (
      <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-400">
        no weekly_reviews rows yet — the Saturday job (<span className="font-mono text-xs">scripts/weekly.sh</span>) writes the
        first one after the week closes.
      </p>
    );
  }

  const s = data.review.stats;
  const o = s?.trades.overall ?? null;

  return (
    <div className="space-y-8">
      {/* week selector */}
      <div className="flex flex-wrap items-center gap-2">
        {data.weeks.map((w) => (
          <button
            key={w.week_start}
            onClick={() => pickWeek(w.week_start)}
            className={`rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors ${
              w.week_start === week
                ? "border-long/40 bg-long/15 text-long"
                : "border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {w.week_start.slice(5)} → {w.week_end.slice(5)}
            <span className="ml-1.5 text-zinc-600">
              {w.trades}t · {fmtUsd(w.net)}
            </span>
          </button>
        ))}
      </div>

      {/* recap cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">week {s?.week ?? `${data.review.week_start} → ${data.review.week_end}`}</p>
          <p className="mt-1 text-2xl font-bold text-zinc-200">{s?.trades.count ?? 0} trades</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            generated {new Date(data.review.generated_at).toLocaleString()} · {data.review.sha.slice(0, 7)}
            {data.review.telegram_sent ? " · telegram ✓" : ""}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">net p&amp;l</p>
          <p className={`mt-1 text-2xl font-bold ${(o?.netUsd ?? 0) >= 0 ? "text-zinc-200" : "text-red-400"}`}>{fmtUsd(o?.netUsd ?? 0)}</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            {o ? `${o.wins}W/${o.losses}L · ${pct(o.winRate)} · ${o.stopRuns} stop-runs` : "no matched trades"}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">cards</p>
          <p className="mt-1 text-2xl font-bold text-zinc-200">{s?.signals.sent ?? 0} sent</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">
            {s?.signals.vetoedTotal ?? 0} vetoed
            {s?.signals.vetoedByFamily.length ? ` (${s.signals.vetoedByFamily.map((v) => `${v.family}=${v.n}`).join(", ")})` : ""}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">live overrides</p>
          <p className="mt-1 text-2xl font-bold text-long">{s?.overrides.active.length ?? 0} active</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">{s?.overrides.autoReverts.length ?? 0} auto-reverted all-time</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">study verdicts this week</p>
          <p className="mt-1 text-2xl font-bold text-zinc-200">
            {data.review.studies.filter((st) => st.verdict === "passed").length} passed ·{" "}
            <span className="text-red-400">{data.review.studies.filter((st) => st.verdict !== "passed").length}</span> not
          </p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">fail-closed: a rejected study writes nothing</p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <p className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">narrative</p>
          <p className="mt-1 text-2xl font-bold text-zinc-200">{data.review.narrative_source}</p>
          <p className="mt-1 font-mono text-[10px] text-zinc-600">DeepSeek week story + next-week hypotheses — proposes, never decides</p>
        </div>
      </div>

      {/* edge monitor */}
      {s && s.edges.length > 0 && (
        <section>
          <h2 className="mb-1 font-mono text-xs uppercase tracking-widest text-zinc-500">edge monitor (week close)</h2>
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                <tr>
                  <th className="px-3 py-2">family</th>
                  <th className="px-3 py-2">state</th>
                  <th className="px-3 py-2">live expR vs baseline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {s.edges.map((e) => {
                  const chip = EDGE_CHIP[e.status];
                  return (
                    <tr key={e.family}>
                      <td className="px-3 py-2 font-mono text-[11px] text-zinc-300">{e.family}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${chip.cls}`}>{chip.label}</span>
                      </td>
                      <td className="px-3 py-2 text-xs text-zinc-400">{e.detail}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* studies × promotion verdicts */}
      <section>
        <h2 className="mb-1 font-mono text-xs uppercase tracking-widest text-zinc-500">studies × promotion contract</h2>
        <p className="mb-3 text-xs text-zinc-500">
          the Saturday queue, re-run against the frozen production stack. Every verdict — including rejections — is
          recorded to the{" "}
          <Link href="/promotions" className="text-long hover:underline">
            promotion ledger
          </Link>
          .
        </p>
        {data.review.studies.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">
            no studies this week (WEEKLY_STUDIES=none) — rollup + narrative only.
          </p>
        ) : (
          <div className="space-y-2">
            {data.review.studies.map((st) => {
              const chip = VERDICT_CHIP[st.verdict];
              const r = st.report;
              return (
                <details key={st.name} className="group rounded-lg border border-zinc-800 bg-zinc-900/40">
                  <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                    <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${chip.cls}`}>{chip.label}</span>
                    <span className="font-mono text-xs text-zinc-200">{st.name}</span>
                    {r && (
                      <span className="font-mono text-[11px] text-zinc-500">
                        {r.gate} → {JSON.stringify(r.value)} on {r.family}
                      </span>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-zinc-600">{new Date().toLocaleDateString()} · exit {st.exit}</span>
                  </summary>
                  <div className="space-y-3 border-t border-zinc-800/60 px-3 py-3 text-xs">
                    {st.reasons.length > 0 && (
                      <ul className="list-inside list-disc space-y-0.5 text-zinc-400">
                        {st.reasons.map((r_, i) => (
                          <li key={i}>{r_}</li>
                        ))}
                      </ul>
                    )}
                    {r ? (
                      <>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
                            <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-600">baseline (production stack)</p>
                            <p className="font-mono text-[11px] text-zinc-300">{cohortCells(r.baseline)}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">test: {cohortCells(r.baseline.test)}</p>
                          </div>
                          <div className="rounded border border-zinc-800 bg-zinc-950/40 p-2">
                            <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-600">candidate (with the gate)</p>
                            <p className="font-mono text-[11px] text-zinc-300">{cohortCells(r.candidate)}</p>
                            <p className="mt-0.5 font-mono text-[10px] text-zinc-600">test: {cohortCells(r.candidate.test)}</p>
                          </div>
                        </div>
                        {r.vetoed && (
                          <p className="font-mono text-[10px] text-zinc-500">
                            vetoed {cohortCells(r.vetoed)} · share {r.vetoedSharePct?.toFixed(1) ?? "—"}% · test {cohortCells(r.vetoed.test)}
                          </p>
                        )}
                        {r.viability && (
                          <p className="font-mono text-[10px] text-zinc-500">
                            prop sim: eval {r.viability.evalPass ? "PASS" : "FAIL"} · funded {r.viability.fundedPass ? "PASS" : "FAIL"} · test
                            eval {r.viability.evalTestPass ? "PASS" : "FAIL"} · test funded {r.viability.fundedTestPass ? "PASS" : "FAIL"}
                          </p>
                        )}
                        {r.grid && (
                          <p className="font-mono text-[10px] text-zinc-500">
                            grid {r.grid.variants} variants{r.grid.dsr !== undefined ? ` · DSR ${r.grid.dsr}` : ""}
                            {r.grid.pbo !== undefined ? ` · PBO ${r.grid.pbo}` : ""}
                          </p>
                        )}
                        <p className="font-mono text-[10px] text-zinc-600">
                          split {r.splitDate} · {r.cli}
                        </p>
                        <p className="text-zinc-500">{r.note}</p>
                      </>
                    ) : (
                      <p className="text-zinc-500">
                        no machine-readable report — the study failed or wrote no report-json.
                        <span className="mt-1 block whitespace-pre-wrap font-mono text-[10px] text-zinc-600">{st.logTail.slice(-400)}</span>
                      </p>
                    )}
                  </div>
                </details>
              );
            })}
          </div>
        )}
      </section>

      {/* proposals (backtest source) — the human side of the loop */}
      <section>
        <h2 className="mb-1 font-mono text-xs uppercase tracking-widest text-zinc-500">backtest proposals (approve / reject)</h2>
        <p className="mb-3 text-xs text-zinc-500">
          contract-passed proposals written by the weekly job or promoteFromBacktest. Apply activates the suppressive
          gate within ~5 minutes (no deploy); the edge monitor auto-reverts on breach. Everything else stays on the{" "}
          <Link href="/promotions" className="text-long hover:underline">
            manual path
          </Link>
          .
        </p>
        {data.insights.length === 0 ? (
          <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 text-xs text-zinc-500">no backtest proposals yet.</p>
        ) : (
          <div className="space-y-2">
            {data.insights.map((i) => (
              <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-zinc-200">{i.title}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-zinc-600">
                    {i.strategy} · {new Date(i.run_at).toLocaleString()} · auto_apply {String(i.auto_apply)}
                    {i.proposedAction ? ` · ${i.proposedAction.family}.${i.proposedAction.gate} → ${JSON.stringify(i.proposedAction.value)}` : ""}
                  </p>
                </div>
                {i.status === "proposed" ? (
                  <div className="flex gap-2">
                    <button
                      onClick={() => void act(i.id, "apply")}
                      disabled={busy !== null}
                      className="rounded border border-long/40 bg-long/15 px-2.5 py-1 font-mono text-[11px] text-long transition-colors hover:bg-long/25 disabled:opacity-40"
                    >
                      apply
                    </button>
                    <button
                      onClick={() => void act(i.id, "reject")}
                      disabled={busy !== null}
                      className="rounded border border-zinc-700 bg-zinc-800/60 px-2.5 py-1 font-mono text-[11px] text-zinc-400 transition-colors hover:text-zinc-200 disabled:opacity-40"
                    >
                      reject
                    </button>
                  </div>
                ) : (
                  <span
                    className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
                      i.status === "applied"
                        ? "border-long/40 bg-long/15 text-long"
                        : i.status === "reverted"
                          ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
                          : "border-zinc-700 bg-zinc-800/60 text-zinc-500"
                    }`}
                  >
                    {i.status}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* narrative */}
      <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
        <p className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">
          weekly narrative · {data.review.narrative_source}
          {data.review.narrative_source === "deterministic" ? " (ANALYSIS_LLM_URL/KEY not configured)" : ""}
        </p>
        <div className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-300">{data.review.narrative || "—"}</div>
      </section>
    </div>
  );
}
