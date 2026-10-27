"use client";

/* ------------------------------------------------------------------ *
 * Pattern explorer — the journal's winner/loser variable view.
 *
 * One row per variable, strongest evidence first: direction, effect,
 * p/q/stability and the SIGNIFICANT / STABLE / EXPLORATORY verdict,
 * W%/L% per bucket, per-strategy rows on expand.
 *
 * Everything is doable and visible from here:
 *   · RUN NOW stores the analysis as a reproducible pattern_runs row
 *     (filters + sha + results) — pick any stored run from the
 *     selector, or stay on LIVE;
 *   · unregistered variables (feature drift) carry a badge;
 *   · the full feature registry (codebook-as-code) renders below,
 *     searchable.
 * The CLI (scripts/winnerLoserPatterns.ts) runs the same engine.
 * ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from "react";
import { familyName } from "@/lib/familyNames";
import { FEATURE_REGISTRY, type RegistryEntry } from "@/lib/featureRegistry";
import { adminFetch } from "@/lib/adminFetch";

type Cell = {
  label: string;
  n: number;
  wins: number;
  wr: number;
  liftPp: number;
  meanValue: number | null;
};

type FamilyCell = { family: string; n: number; wins: number; wr: number; liftPp: number };

type Pattern = {
  key: string;
  kind: "fire-time" | "post-hoc";
  group: string;
  type: "numeric" | "categorical" | "presence";
  baselineWr: number;
  n: number;
  direction: "up" | "down" | "flat" | "split";
  directionLabel: string;
  effectPp: number;
  strength: "strong" | "mild" | "weak";
  cells: Cell[];
  perFamily: FamilyCell[];
  pValue: number | null;
  qValue: number | null;
  stable: boolean | "insufficient" | null;
  verdict: "significant" | "stable" | "exploratory";
  registered: boolean;
  doc: string | null;
};

type RunSummary = {
  id: number;
  runAt: string;
  sha: string;
  since: string;
  minN: number;
  universe: "filled" | "signals";
  nTrades: number;
  baselineWr: number;
  significant: number;
  stable: number;
  exploratory: number;
};

type Resp = {
  ok: boolean;
  reason?: string;
  source?: "live" | "run";
  runId?: number | null;
  runAt?: string;
  sha?: string;
  since?: string;
  minN?: number;
  universe?: "filled" | "signals";
  n: number;
  wins: number;
  losses: number;
  baselineWr: number;
  familyBaselines: Array<{ family: string; n: number; wins: number; wr: number }>;
  patterns: Pattern[];
  drift: string[];
  runs: RunSummary[];
};

const ARROW: Record<Pattern["direction"], string> = { up: "↑", down: "↓", flat: "→", split: "⚡" };
const ROLE_OF = (p: Pattern): "input" | "study" | "post" =>
  p.kind === "post-hoc" ? "post" : p.group === "SIGNAL INPUTS" || p.group === "CARD LABELS & GATES" ? "input" : "study";

const ROLE_STYLE: Record<"input" | "study" | "post", string> = {
  input: "border-long/40 bg-long/10 text-long",
  study: "border-info/40 bg-info/10 text-info",
  post: "border-warn/40 bg-warn/10 text-warn",
};
const ROLE_LABEL: Record<"input" | "study" | "post", string> = {
  input: "SIGNAL INPUT",
  study: "STUDY",
  post: "POST-HOC",
};

const VERDICT_STYLE: Record<Pattern["verdict"], string> = {
  significant: "border-long/50 bg-long/10 text-long",
  stable: "border-info/50 bg-info/10 text-info",
  exploratory: "border-zinc-700 bg-zinc-800/40 text-zinc-500",
};
const VERDICT_TITLE: Record<Pattern["verdict"], string> = {
  significant: "FDR-corrected q < 0.10 across every variable in this run, and the time split doesn't contradict it",
  stable: "same direction in BOTH time halves (early vs late), ≥2pp effect each",
  exploratory: "not yet significant or stable — pattern surface only",
};

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const fmtP = (v: number | null): string => (v === null ? "—" : v < 0.001 ? "<0.001" : v.toFixed(3));

function CellBar({ label, n, wins, wr, total }: { label: string; n: number; wins: number; wr: number; total: number }) {
  const losses = n - wins;
  return (
    <div className="flex items-center gap-2 font-mono text-[9px] leading-tight">
      <span className="w-[130px] shrink-0 truncate text-zinc-500" title={label}>
        {label}
      </span>
      <div className="flex h-2.5 min-w-[90px] flex-1 overflow-hidden rounded bg-zinc-800/70" title={`${pct(wr)}W / ${pct(1 - wr)}L · n=${n}${total ? ` · ${((n / total) * 100).toFixed(0)}% of rows` : ""}`}>
        <div className="bg-long/80" style={{ width: `${wr * 100}%` }} />
        <div className="bg-short/70" style={{ width: `${(1 - wr) * 100}%` }} />
      </div>
      <span className="w-[92px] shrink-0 text-right whitespace-nowrap text-zinc-400">
        <span className="text-long">{pct(wr)}W</span>/<span className="text-short">{pct(1 - wr)}L</span> · n={n}
      </span>
    </div>
  );
}

const REGISTRY_ROLE_STYLE: Record<RegistryEntry["role"], string> = ROLE_STYLE;

function RegistryView() {
  const [query, setQuery] = useState("");
  const groups = new Map<string, RegistryEntry[]>();
  for (const e of FEATURE_REGISTRY) {
    if (query && !`${e.key} ${e.doc}`.toLowerCase().includes(query.toLowerCase())) continue;
    const arr = groups.get(e.group) ?? [];
    arr.push(e);
    groups.set(e.group, arr);
  }
  return (
    <details className="mt-3 rounded border border-zinc-800/70 bg-zinc-950/30 px-3 py-2">
      <summary className="cursor-pointer font-mono text-[10px] font-bold uppercase tracking-wider text-zinc-400">
        Feature registry — the codebook ({FEATURE_REGISTRY.length} entries)
      </summary>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="filter registry…"
        className="mt-2 w-56 rounded border border-zinc-800 bg-panel px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 placeholder:text-zinc-600"
      />
      <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {[...groups.entries()].map(([group, entries]) => (
          <div key={group}>
            <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">{group}</p>
            <div className="space-y-0.5">
              {entries.map((e) => (
                <div key={e.key} className="border-b border-zinc-900 py-0.5 font-mono text-[9px]">
                  <div className="flex items-center gap-1">
                    <span className="text-zinc-300">{e.key}</span>
                    <span className={`rounded border px-1 py-px text-[7px] uppercase ${REGISTRY_ROLE_STYLE[e.role]}`}>{e.role}</span>
                    <span className="rounded border border-zinc-800 px-1 py-px text-[7px] uppercase text-zinc-500">{e.type}</span>
                  </div>
                  <p className="text-zinc-600">{e.doc}</p>
                </div>
              ))}
            </div>
          </div>
        ))}
        {groups.size === 0 && <p className="font-mono text-[9px] text-zinc-600">no registry entries match the filter</p>}
      </div>
    </details>
  );
}

export default function PatternExplorer() {
  const [data, setData] = useState<Resp | null>(null);
  const [range, setRange] = useState<"7" | "30" | "90" | "all">("30");
  const [runId, setRunId] = useState<number | null>(null);
  const [universe, setUniverse] = useState<"filled" | "signals">("filled");
  const [role, setRole] = useState<"all" | "input" | "study" | "post">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const since = range === "all" ? "" : new Date(Date.now() - Number(range) * 86400_000).toISOString().slice(0, 10);

  const load = () => {
    fetch(`/api/patterns?since=${since}&minN=5&universe=${universe}${runId ? `&run=${runId}` : ""}`)
      .then((r) => r.json())
      .then((j: Resp) => {
        setData(j.ok ? j : null);
        setLoaded(true);
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 120_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, runId, universe]);

  const runNow = () => {
    setRunning(true);
    adminFetch("/api/patterns", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ since, minN: 5, account: "all", family: "", universe }),
    })
      .then((r) => r.json())
      .then((j: { ok: boolean; runId?: number }) => {
        if (j.ok && j.runId) setRunId(j.runId);
      })
      .catch(() => {})
      .finally(() => setRunning(false));
  };

  const patterns = (data?.patterns ?? []).filter((p) => {
    const r = ROLE_OF(p);
    if (role !== "all" && r !== role) return false;
    if (query && !p.key.toLowerCase().includes(query.toLowerCase()) && !p.group.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });
  const verdictCounts = (list: Pattern[]) => ({
    significant: list.filter((p) => p.verdict === "significant").length,
    stable: list.filter((p) => p.verdict === "stable").length,
    exploratory: list.filter((p) => p.verdict === "exploratory").length,
  });
  const counts = verdictCounts(data?.patterns ?? []);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Pattern explorer — winners vs losers, per variable</h2>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
          <span className="flex overflow-hidden rounded border border-zinc-800">
            <button
              onClick={() => setUniverse("filled")}
              className={`px-1.5 py-0.5 text-[9px] ${universe === "filled" ? "bg-long/15 text-long" : "text-zinc-500 hover:text-zinc-200"}`}
              title="reconciled trades with real fills, real P&L — the money view"
            >
              FILLED
            </button>
            <button
              onClick={() => setUniverse("signals")}
              className={`px-1.5 py-0.5 text-[9px] ${universe === "signals" ? "bg-info/15 text-info" : "text-zinc-500 hover:text-zinc-200"}`}
              title="every recorded card scored by hypothetical first-touch replay — the signal-quality view (not money)"
            >
              ALL SIGNALS
            </button>
          </span>
          {(["7", "30", "90", "all"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`rounded border px-1.5 py-0.5 text-[9px] ${range === r ? "border-info/60 bg-info/10 text-info" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}
            >
              {r === "all" ? "ALL" : `${r}D`}
            </button>
          ))}
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
            className="rounded border border-zinc-800 bg-panel px-1.5 py-0.5 text-[9px] text-zinc-400"
          >
            <option value="all">all roles</option>
            <option value="input">signal inputs</option>
            <option value="study">study only</option>
            <option value="post">post-hoc</option>
          </select>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="filter variable…"
            className="w-36 rounded border border-zinc-800 bg-panel px-1.5 py-0.5 text-[9px] text-zinc-300 placeholder:text-zinc-600"
          />
          <select
            value={runId ?? 0}
            onChange={(e) => setRunId(Number(e.target.value) || null)}
            className="max-w-[260px] rounded border border-zinc-800 bg-panel px-1.5 py-0.5 text-[9px] text-zinc-400"
            title="stored runs — pick one to view its snapshot, or LIVE for the current data"
          >
            <option value={0}>LIVE</option>
            {(data?.runs ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                #{r.id} · {r.runAt.slice(0, 16).replace("T", " ")} · n={r.nTrades} · {r.significant}S/{r.stable}s/{r.exploratory}e{r.universe === "signals" ? " · sig" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={runNow}
            disabled={running}
            className="rounded border border-long/50 bg-long/10 px-1.5 py-0.5 text-[9px] text-long hover:bg-long/20 disabled:opacity-50"
            title="run the analysis now and store it as a reproducible snapshot (pattern_runs)"
          >
            {running ? "running…" : "▶ RUN NOW"}
          </button>
        </div>
      </div>

      {data && (
        <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span>
            {data.source === "run" ? `run #${data.runId}` : "live"} · {data.runAt?.slice(0, 16).replace("T", " ") ?? ""}
            {data.sha ? ` · sha ${data.sha}` : ""}
            {data.since ? ` · since ${data.since}` : " · all time"} · minN {data.minN ?? 5} · {data.universe === "signals" ? "all signals (hypothetical)" : "filled"}
          </span>
          <span>
            {data.n} trades · <span className="text-long">{data.wins}W</span>/<span className="text-short">{data.losses}L</span> · baseline {pct(data.baselineWr)}
          </span>
          <span className="text-zinc-600">
            verdicts: <span className="text-long">{counts.significant} sig</span> · <span className="text-info">{counts.stable} stable</span> · {counts.exploratory} exploratory
          </span>
          {data.drift.length > 0 && (
            <span className="rounded border border-warn/50 bg-warn/10 px-1.5 py-0.5 text-warn" title={data.drift.join(", ")}>
              {data.drift.length} unregistered variable{data.drift.length > 1 ? "s" : ""} — registry drift
            </span>
          )}
          {data.familyBaselines.map((f) => (
            <span key={f.family} className="rounded border border-zinc-800 px-1.5 py-0.5" title={`${f.wins}W / ${f.n - f.wins}L`}>
              {familyName(f.family)} {pct(f.wr)}
            </span>
          ))}
        </div>
      )}

      <p className="mb-2 font-mono text-[9px] leading-snug text-zinc-600">
        {universe === "signals" ? (
          <span className="text-info">ALL-SIGNALS universe: outcomes are HYPOTHETICAL first-touch replay scores (assume a limit fill at the signal entry — no slippage, no commissions). Signal-quality view only, never money. </span>
        ) : (
          <span>FILLED universe: reconciled trades with real fills and P&L. </span>
        )}
        ↑ higher values win more · ↓ lower values win more · ⚡ prefers one value · → flat · effect = lift spread between the two extreme cells (pp) ·
        p = Mann-Whitney (numeric) / Fisher extreme 2×2 (categorical) / CMH by family (presence) · q = Benjamini-Hochberg FDR across all variables ·
        significant = q &lt; 0.10 and not contradicted by the time split · stable = same direction in both halves (≥2pp each) · POST-HOC anatomy correlates with the result by construction ·
        integers with ≤30 distinct values (contracts, hour) bin per value, not brackets
      </p>

      {!loaded && <p className="font-mono text-xs text-zinc-600">loading…</p>}
      {loaded && !data && <p className="font-mono text-xs text-zinc-600">no pattern data yet — the dataset fills with reconciled trades (reconcileTrades runs nightly)</p>}
      {loaded && data && patterns.length === 0 && <p className="font-mono text-xs text-zinc-600">no variables match the filters</p>}

      <div className="max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
        {patterns.map((p) => {
          const r = ROLE_OF(p);
          const open = expanded === p.key;
          return (
            <div key={p.key} className="rounded border border-zinc-800/70 px-2 py-1.5">
              <button onClick={() => setExpanded(open ? null : p.key)} className="block w-full text-left">
                <div className="flex flex-wrap items-center gap-1.5 font-mono">
                  <span className={`text-[12px] font-bold ${p.direction === "down" ? "text-short" : p.direction === "flat" ? "text-zinc-500" : "text-long"}`}>
                    {ARROW[p.direction]}
                  </span>
                  <span className="text-[11px] font-semibold text-zinc-100">{p.key}</span>
                  <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${ROLE_STYLE[r]}`}>{ROLE_LABEL[r]}</span>
                  <span className="rounded border border-zinc-800 px-1 py-0.5 text-[8px] uppercase text-zinc-500">{p.type}</span>
                  <span className={`rounded border px-1 py-0.5 text-[8px] uppercase ${VERDICT_STYLE[p.verdict]}`} title={VERDICT_TITLE[p.verdict]}>
                    {p.verdict}
                  </span>
                  {!p.registered && (
                    <span
                      className="rounded border border-warn/50 bg-warn/10 px-1 py-0.5 text-[8px] uppercase text-warn"
                      title="not in lib/featureRegistry.ts — the feature was added or renamed without registering it (drift)"
                    >
                      unregistered
                    </span>
                  )}
                  <span className="ml-auto whitespace-nowrap text-[9px] text-zinc-500">
                    n={p.n} · effect {p.effectPp >= 0 ? "+" : ""}
                    {p.effectPp.toFixed(1)}pp · {p.group}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-400" title={p.doc ?? undefined}>
                  {p.directionLabel} · p={fmtP(p.pValue)} · q={fmtP(p.qValue)}
                  <span className="text-zinc-600">
                    {" "}
                    · {p.stable === true ? "holds in both time halves" : p.stable === false ? "flips or flattens across halves" : "stability n/a (sample too small)"}
                  </span>
                </p>
              </button>

              <div className="mt-1.5 space-y-0.5 border-t border-zinc-800/60 pt-1">
                {p.cells.slice(0, open ? undefined : 4).map((c) => (
                  <CellBar key={c.label} label={c.label} n={c.n} wins={c.wins} wr={c.wr} total={p.n} />
                ))}
                {!open && p.cells.length > 4 && (
                  <p className="font-mono text-[8px] text-zinc-600">…{p.cells.length - 4} more cells — click to expand</p>
                )}
              </div>

              {open && (
                <div className="mt-2 grid grid-cols-1 gap-3 md:grid-cols-2">
                  <div>
                    <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">all cells (sorted by lift)</p>
                    <div className="space-y-0.5">
                      {p.cells.map((c) => (
                        <div key={c.label} className="flex items-center justify-between gap-2 border-b border-zinc-900 py-0.5 font-mono text-[9px]">
                          <span className="truncate text-zinc-500" title={c.label}>{c.label}</span>
                          <span className="whitespace-nowrap text-zinc-400">
                            n={c.n} · <span className="text-long">{pct(c.wr)}W</span>/<span className="text-short">{pct(1 - c.wr)}L</span> · lift{" "}
                            {c.liftPp >= 0 ? "+" : ""}
                            {c.liftPp.toFixed(1)}pp{c.meanValue !== null ? ` · mean ${c.meanValue}` : ""}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div>
                    <p className="mb-1 text-[9px] font-bold uppercase tracking-wider text-zinc-500">per strategy (lift vs that family&apos;s baseline)</p>
                    {p.perFamily.length ? (
                      <div className="space-y-0.5">
                        {p.perFamily.map((f) => (
                          <div key={f.family} className="flex items-center justify-between gap-2 border-b border-zinc-900 py-0.5 font-mono text-[9px]">
                            <span className="text-zinc-400">{familyName(f.family)}</span>
                            <span className="whitespace-nowrap text-zinc-400">
                              n={f.n} · <span className="text-long">{pct(f.wr)}W</span>/<span className="text-short">{pct(1 - f.wr)}L</span> · lift{" "}
                              {f.liftPp >= 0 ? "+" : ""}
                              {f.liftPp.toFixed(1)}pp
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="font-mono text-[9px] text-zinc-600">no family has enough rows for this variable</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <RegistryView />
    </section>
  );
}
