"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Condition, FeatureMeta, Metrics, Op, Theory, TheoryResult } from "@/lib/lab";

/* ---------------------------------------------------------------------------
 * The lab: compose a theory, run it against the collected sessions, and read
 * the result honestly. Every panel here exists because a number produced
 * without it misled us at least once — the clustered interval because trades in
 * one session are not independent, the "clean" column because the tie-break
 * convention decided some outcomes, the holdout because thresholds chosen on
 * this data are in-sample, and the ambiguity share because a result you cannot
 * see the assumptions of is a result you cannot trust.
 * ------------------------------------------------------------------------- */

type Bootstrap = {
  ok: boolean;
  features: FeatureMeta[];
  sessions: string[];
  skippedSessions: { date: string; minutes: number }[];
  sampleCount: number;
  baseline: TheoryResult;
  presets: Theory[];
};

const OPS: Op[] = [">=", "<=", ">", "<", "==", "!="];

function pct(x: number) {
  return `${x.toFixed(1)}%`;
}

function MetricBlock({ label, m, tone = "zinc" }: { label: string; m: Metrics; tone?: "zinc" | "long" | "short" }) {
  const naive = m.wilson[1] - m.wilson[0];
  const clustered = m.clustered[1] - m.clustered[0];
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className={`font-mono text-2xl font-semibold ${tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-zinc-100"}`}>
          {m.n ? pct(m.wr) : "—"}
        </span>
        <span className="font-mono text-xs text-zinc-400">n={m.n}</span>
        <span className="font-mono text-xs text-zinc-400">
          exp {m.exp >= 0 ? "+" : ""}
          {m.exp.toFixed(2)}R
        </span>
        <span className="font-mono text-xs text-zinc-400">{m.tradesPerSession.toFixed(1)}/session</span>
        <span className="font-mono text-xs text-zinc-400">
          {m.daysAbove50}/{m.daysTotal} days &gt;50%
        </span>
      </div>
      <div className="mt-2 space-y-0.5 font-mono text-[11px] text-zinc-500">
        <p>
          naive 95% CI {m.wilson[0].toFixed(0)}–{m.wilson[1].toFixed(0)}%
        </p>
        <p className={clustered > naive * 1.4 ? "text-warn" : ""}>
          session-clustered CI {m.clustered[0].toFixed(0)}–{m.clustered[1].toFixed(0)}%
          {naive > 0 ? ` (${(clustered / naive).toFixed(1)}× wider)` : ""}
        </p>
        <p>tie-break-decided trades {m.ambiguousShare.toFixed(0)}%</p>
      </div>
    </div>
  );
}

function SessionTable({ m }: { m: Metrics }) {
  if (!m.sessions.length) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr className="text-left text-zinc-500">
            <th className="py-1 pr-4 font-normal">session</th>
            <th className="py-1 pr-4 font-normal">trades</th>
            <th className="py-1 pr-4 font-normal">wins</th>
            <th className="py-1 pr-4 font-normal">win rate</th>
            <th className="py-1 font-normal">vs 50%</th>
          </tr>
        </thead>
        <tbody>
          {m.sessions.map((s) => (
            <tr key={s.date} className="border-t border-zinc-800/60">
              <td className="py-1 pr-4 text-zinc-300">{s.date}</td>
              <td className="py-1 pr-4 text-zinc-400">{s.n}</td>
              <td className="py-1 pr-4 text-zinc-400">{s.wins}</td>
              <td className="py-1 pr-4 text-zinc-200">{s.wr.toFixed(0)}%</td>
              <td className={`py-1 ${s.wr > 50 ? "text-long" : "text-short"}`}>{s.wr > 50 ? "above" : "below"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function LabPage() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [theory, setTheory] = useState<Theory>({ name: "my theory", conditions: [] });
  const [result, setResult] = useState<TheoryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ name: string; result: TheoryResult }[]>([]);

  useEffect(() => {
    fetch("/api/lab")
      .then((r) => r.json())
      .then((d: Bootstrap) => {
        setBoot(d);
        if (d.baseline) setResult(d.baseline);
      })
      .catch((e) => setError(String(e)));
  }, []);

  const run = useCallback(
    async (t: Theory) => {
      setRunning(true);
      setError(null);
      try {
        const r = await fetch("/api/lab", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ theory: t }),
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error);
        setResult(d.result);
        return d.result as TheoryResult;
      } catch (e) {
        setError(String(e));
        return null;
      } finally {
        setRunning(false);
      }
    },
    [],
  );

  const features = boot?.features ?? [];
  const numeric = useMemo(() => features.filter((f) => f.kind === "number"), [features]);

  const update = (patch: Partial<Theory>) => setTheory((t) => ({ ...t, ...patch }));

  const addCondition = (f: FeatureMeta) =>
    update({
      conditions: [
        ...theory.conditions,
        { feature: f.id, op: f.suggest?.op ?? (f.kind === "boolean" ? "==" : ">="), value: f.suggest?.value ?? (f.kind === "boolean" ? true : 0) },
      ],
    });

  const setCondition = (i: number, patch: Partial<Condition>) =>
    update({ conditions: theory.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const removeCondition = (i: number) => update({ conditions: theory.conditions.filter((_, j) => j !== i) });

  const register = () => {
    // Pre-registration: stamp the theory with the newest session it could have
    // seen, so later runs can report a true forward test.
    const cutoff = boot?.sessions?.[boot.sessions.length - 1];
    const stamped = { ...theory, registeredAt: new Date().toISOString(), dataCutoff: cutoff };
    setTheory(stamped);
    void run(stamped);
  };

  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-6">
      <header className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-50">Theory lab</h1>
        <p className="mt-1 max-w-3xl text-sm leading-relaxed text-zinc-400">
          Compose entry conditions and run them against the collected sessions. Every result shows what
          it is worth: how many trades matched, how wide the honest interval is, how the edge is spread
          across sessions, and how much of the outcome was decided by the backtest&apos;s own tie-break
          convention rather than by the market. A high win rate on fifteen trades is noise, and this page
          is built to say so.
        </p>
        {boot && (
          <p className="mt-2 font-mono text-[11px] text-zinc-500">
            {boot.sampleCount} reclaim samples · {boot.sessions.length} complete sessions ({boot.sessions[0]} …{" "}
            {boot.sessions[boot.sessions.length - 1]}) · {boot.skippedSessions.length} sessions excluded as partially
            retained
          </p>
        )}
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
        {/* ── builder ── */}
        <section className="space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">presets</p>
            <div className="space-y-1.5">
              {(boot?.presets ?? []).map((p) => (
                <button
                  key={p.name}
                  onClick={() => {
                    setTheory(p);
                    void run(p);
                  }}
                  className="block w-full rounded border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900"
                >
                  <span className="block text-sm text-zinc-200">{p.name}</span>
                  {p.note && <span className="block font-mono text-[10px] text-zinc-500">{p.note}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <label className="mb-2 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">theory name</label>
            <input
              value={theory.name}
              onChange={(e) => update({ name: e.target.value })}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-3 py-2 font-mono text-sm text-zinc-200 outline-none focus:border-long/60"
            />

            <p className="mb-2 mt-4 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              conditions ({theory.conditions.length})
            </p>
            <div className="space-y-2">
              {theory.conditions.map((c, i) => {
                const f = features.find((x) => x.id === c.feature);
                return (
                  <div key={i} className="rounded border border-zinc-800 bg-zinc-950/60 p-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">{f?.label ?? c.feature}</span>
                      {f?.ratio && (
                        <span className="rounded border border-warn/40 px-1 font-mono text-[9px] uppercase text-warn">ratio</span>
                      )}
                      <button onClick={() => removeCondition(i)} className="font-mono text-[10px] text-zinc-500 hover:text-short">
                        remove
                      </button>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <select
                        value={c.op}
                        onChange={(e) => setCondition(i, { op: e.target.value as Op })}
                        className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 outline-none"
                      >
                        {OPS.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                      {f?.kind === "boolean" ? (
                        <select
                          value={String(c.value)}
                          onChange={(e) => setCondition(i, { value: e.target.value === "true" })}
                          className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-300 outline-none"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : (
                        <input
                          type="number"
                          step="0.1"
                          value={Number(c.value)}
                          onChange={(e) => setCondition(i, { value: Number(e.target.value) })}
                          className="w-24 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-xs text-zinc-200 outline-none focus:border-long/60"
                        />
                      )}
                      {f && <span className="font-mono text-[10px] text-zinc-500">{f.unit}</span>}
                    </div>
                    {f && <p className="mt-1 font-mono text-[10px] leading-snug text-zinc-500">{f.note}</p>}
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                onClick={() => void run(theory)}
                disabled={running}
                className="rounded border border-long/40 bg-long/10 px-3 py-1.5 font-mono text-xs text-long transition-colors hover:bg-long/20 disabled:opacity-50"
              >
                {running ? "running…" : "run theory"}
              </button>
              <button
                onClick={register}
                disabled={running}
                className="rounded border border-info/40 bg-info/5 px-3 py-1.5 font-mono text-xs text-info transition-colors hover:bg-info/15 disabled:opacity-50"
                title="stamp the theory with the newest session it could have seen, so later runs report a true forward test"
              >
                register &amp; run
              </button>
              <button
                onClick={() => {
                  setTheory({ name: "my theory", conditions: [] });
                  void run({ name: "baseline", conditions: [] });
                }}
                className="rounded border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:bg-zinc-900"
              >
                clear
              </button>
              {result && (
                <button
                  onClick={() => setCompare((c) => [...c.filter((x) => x.name !== theory.name), { name: theory.name, result }])}
                  className="rounded border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-400 transition-colors hover:bg-zinc-900"
                >
                  pin to comparison
                </button>
              )}
            </div>
            {theory.dataCutoff && (
              <p className="mt-2 font-mono text-[10px] text-info">
                registered {theory.registeredAt?.slice(0, 16).replace("T", " ")} · sees data through {theory.dataCutoff}
              </p>
            )}
          </div>

          <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">add a condition</p>
            <div className="flex flex-wrap gap-1.5">
              {numeric.map((f) => (
                <button
                  key={f.id}
                  onClick={() => addCondition(f)}
                  title={f.note}
                  className={`rounded border px-2 py-1 font-mono text-[10px] transition-colors ${
                    f.ratio
                      ? "border-warn/40 text-warn hover:bg-warn/10"
                      : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {f.label}
                </button>
              ))}
              {features
                .filter((f) => f.kind === "boolean")
                .map((f) => (
                  <button
                    key={f.id}
                    onClick={() => addCondition(f)}
                    title={f.note}
                    className="rounded border border-zinc-700 px-2 py-1 font-mono text-[10px] text-zinc-300 transition-colors hover:bg-zinc-800"
                  >
                    {f.label}
                  </button>
                ))}
            </div>
          </div>
        </section>

        {/* ── results ── */}
        <section className="space-y-4">
          {error && (
            <div className="rounded-lg border border-short/40 bg-short/5 p-4 font-mono text-xs text-short">{error}</div>
          )}

          {result && (
            <>
              <div className="rounded-lg border border-zinc-700 bg-zinc-900/70 p-4">
                <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  the number is a range, not a point
                </p>
                <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono">
                  <span className="text-3xl font-semibold text-zinc-100">
                    {result.all.n ? `${result.all.wr.toFixed(0)}–${result.optimistic.wr.toFixed(0)}%` : "—"}
                  </span>
                  <span className="text-xs text-zinc-400">
                    when a trade&apos;s stop and target both fall inside the same bar, the backtest&apos;s convention decides it.
                    {result.all.ambiguousShare > 0
                      ? ` That affects ${result.all.ambiguousShare.toFixed(0)}% of these trades.`
                      : " None of these trades are affected."}
                  </span>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MetricBlock label="ambiguous counted as losses (conservative)" m={result.all} tone="long" />
                <MetricBlock label="ambiguous dropped (flatters)" m={result.clean} />
                <MetricBlock label="ambiguous counted as wins (permissive)" m={result.optimistic} />
              </div>

              {result.warnings.length > 0 && (
                <div className="rounded-lg border border-warn/40 bg-warn/5 p-4">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-warn">read this before believing the number</p>
                  <ul className="space-y-1.5">
                    {result.warnings.map((w, i) => (
                      <li key={i} className="flex gap-2 text-xs leading-relaxed text-zinc-300">
                        <span className="text-warn">·</span>
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                    chronological holdout — split at {result.holdout?.splitAt}
                  </p>
                  <div className="space-y-1 font-mono text-xs">
                    <p className="text-zinc-400">
                      train {result.holdout?.train.wr.toFixed(0) ?? "—"}% (n={result.holdout?.train.n ?? 0})
                    </p>
                    <p className="text-zinc-400">
                      test {result.holdout?.test.wr.toFixed(0) ?? "—"}% (n={result.holdout?.test.n ?? 0})
                    </p>
                    {result.holdout && result.holdout.train.n > 0 && result.holdout.test.n > 0 && (
                      <p className={Math.abs(result.holdout.train.wr - result.holdout.test.wr) > 15 ? "text-warn" : "text-zinc-500"}>
                        gap {Math.abs(result.holdout.train.wr - result.holdout.test.wr).toFixed(0)} pt — a large gap means the
                        effect is not stable across time
                      </p>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">forward test (after registration)</p>
                  {result.forward ? (
                    <div className="space-y-1 font-mono text-xs">
                      <p className="text-zinc-200">
                        {result.forward.n ? pct(result.forward.wr) : "no trades yet"} (n={result.forward.n})
                      </p>
                      <p className="text-zinc-500">sessions after the cutoff only — the only out-of-sample read you get</p>
                    </div>
                  ) : (
                    <p className="font-mono text-xs text-zinc-500">
                      not registered — hit “register &amp; run” and this panel starts scoring only sessions collected after today
                    </p>
                  )}
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">per session</p>
                <SessionTable m={result.all} />
              </div>
            </>
          )}

          {compare.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">pinned theories</p>
                <button onClick={() => setCompare([])} className="font-mono text-[10px] text-zinc-500 hover:text-zinc-300">
                  clear
                </button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full font-mono text-[11px]">
                  <thead>
                    <tr className="text-left text-zinc-500">
                      <th className="py-1 pr-4 font-normal">theory</th>
                      <th className="py-1 pr-4 font-normal">n</th>
                      <th className="py-1 pr-4 font-normal">win</th>
                      <th className="py-1 pr-4 font-normal">clustered CI</th>
                      <th className="py-1 pr-4 font-normal">exp</th>
                      <th className="py-1 pr-4 font-normal">/session</th>
                      <th className="py-1 font-normal">days &gt;50%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compare.map((c) => (
                      <tr key={c.name} className="border-t border-zinc-800/60">
                        <td className="py-1 pr-4 text-zinc-200">{c.name}</td>
                        <td className="py-1 pr-4 text-zinc-400">{c.result.all.n}</td>
                        <td className="py-1 pr-4 text-zinc-200">{c.result.all.n ? pct(c.result.all.wr) : "—"}</td>
                        <td className="py-1 pr-4 text-zinc-400">
                          {c.result.all.clustered[0].toFixed(0)}–{c.result.all.clustered[1].toFixed(0)}%
                        </td>
                        <td className="py-1 pr-4 text-zinc-400">
                          {c.result.all.exp >= 0 ? "+" : ""}
                          {c.result.all.exp.toFixed(2)}R
                        </td>
                        <td className="py-1 pr-4 text-zinc-400">{c.result.all.tradesPerSession.toFixed(1)}</td>
                        <td className="py-1 text-zinc-400">
                          {c.result.all.daysAbove50}/{c.result.all.daysTotal}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-4">
            <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-zinc-500">how to read this honestly</p>
            <ul className="space-y-1.5 text-xs leading-relaxed text-zinc-400">
              <li>
                The <span className="text-zinc-200">clustered</span> interval is the one that matters. Trades inside one
                session share a regime, so the naive binomial interval is too narrow — sometimes half as wide as the truth.
              </li>
              <li>
                A theory reaches its win rate by <span className="text-zinc-200">discarding trades</span>. Check n and
                trades/session first: a 90% theory on ten trades would take months to prove.
              </li>
              <li>
                Win rate is not profit. Expectancy in R is printed beside it, and the exits here are a 1R target with a
                stop two ticks beyond the failed extreme — change those and every number changes.
              </li>
              <li>
                The three win-rate columns differ only in how same-bar stop/target collisions are scored. Those trades are
                all losses under the conservative rule, so the middle column removes a set that is entirely losers and
                therefore <span className="text-zinc-200">overstates</span> the result. Quote the range.
              </li>
              <li>
                Anything flagged <span className="text-warn">ratio</span> divides by the trade&apos;s own risk. Two such
                features produced phantom edges in this project. Confirm the effect in absolute points before believing it.
              </li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  );
}
