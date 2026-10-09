"use client";

/* ------------------------------------------------------------------ *
 * Pattern explorer — the journal's winner/loser variable view.
 *
 * One row per variable, strongest direction first: what the variable
 * is, which way it points (↑ higher → more wins · ↓ lower → more wins
 * · ⚡ prefers one value · → flat), the effect size in percentage
 * points, and the W%/L% split of every bucket — plus the same split
 * inside each strategy family on expand.
 *
 * The same engine computes the CLI (scripts/winnerLoserPatterns.ts)
 * via GET /api/patterns, so the numbers always agree.
 * ------------------------------------------------------------------ */

import { useEffect, useRef, useState } from "react";
import { familyName } from "@/lib/familyNames";

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
};

type Resp = {
  ok: boolean;
  reason?: string;
  n: number;
  wins: number;
  losses: number;
  baselineWr: number;
  familyBaselines: Array<{ family: string; n: number; wins: number; wr: number }>;
  patterns: Pattern[];
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

export default function PatternExplorer() {
  const [data, setData] = useState<Resp | null>(null);
  const [range, setRange] = useState<"7" | "30" | "90" | "all">("30");
  const [role, setRole] = useState<"all" | "input" | "study" | "post">("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const since = range === "all" ? "" : new Date(Date.now() - Number(range) * 86400_000).toISOString().slice(0, 10);

  const load = () => {
    fetch(`/api/patterns?since=${since}&minN=5`)
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
  }, [range]);

  const patterns = (data?.patterns ?? []).filter((p) => {
    const r = ROLE_OF(p);
    if (role !== "all" && r !== role) return false;
    if (query && !p.key.toLowerCase().includes(query.toLowerCase()) && !p.group.toLowerCase().includes(query.toLowerCase())) return false;
    return true;
  });

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Pattern explorer — winners vs losers, per variable</h2>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
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
        </div>
      </div>

      {data && (
        <div className="mb-3 flex flex-wrap items-center gap-2 font-mono text-[10px] text-zinc-500">
          <span>
            {data.n} trades · <span className="text-long">{data.wins}W</span>/<span className="text-short">{data.losses}L</span> · baseline{" "}
            {pct(data.baselineWr)}
          </span>
          {data.familyBaselines.map((f) => (
            <span key={f.family} className="rounded border border-zinc-800 px-1.5 py-0.5" title={`${f.wins}W / ${f.n - f.wins}L`}>
              {familyName(f.family)} {pct(f.wr)}
            </span>
          ))}
        </div>
      )}

      <p className="mb-2 font-mono text-[9px] leading-snug text-zinc-600">
        ↑ higher values win more · ↓ lower values win more · ⚡ prefers one value · → flat · effect = lift spread between the two extreme cells (pp) ·
        p = Mann-Whitney (numeric) / Fisher extreme 2×2 (categorical) / CMH by family (presence) · q = Benjamini-Hochberg FDR across all variables ·
        significant = q &lt; 0.10 · stable = same direction in both time halves (≥2pp each) · POST-HOC anatomy correlates with the result by construction
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
                  <span className="ml-auto whitespace-nowrap text-[9px] text-zinc-500">
                    n={p.n} · effect {p.effectPp >= 0 ? "+" : ""}
                    {p.effectPp.toFixed(1)}pp · {p.group}
                  </span>
                </div>
                <p className="mt-0.5 font-mono text-[10px] text-zinc-400">
                  {p.directionLabel} · p={p.pValue === null ? "—" : p.pValue < 0.001 ? "<0.001" : p.pValue.toFixed(3)} · q=
                  {p.qValue === null ? "—" : p.qValue < 0.001 ? "<0.001" : p.qValue.toFixed(3)}
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
    </section>
  );
}
