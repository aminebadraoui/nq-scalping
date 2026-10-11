"use client";

import Link from "next/link";
import {
  STRATEGIES,
  fieldRows,
  labelFor,
  type StrategyDeclaration,
  type StrategyStatus,
} from "@/lib/strategies/registry";
import type { FeedFlags } from "@/components/docs/LiveStrategies";

/* The /strategies condition-by-condition surface, rendered FROM THE
 * STRATEGY REGISTRY (lib/strategies/registry.ts). Every threshold shown
 * below is read from the same config object the live feed trades —
 * this page can no longer drift from the code (architecture review P0,
 * docs/architecture/ARCHITECTURE-REVIEW.md). Live ON/OFF state comes
 * from /api/gc?action=health via the feeds prop. */

/** "FEED_OPEN_DRIVE" → FeedFlags key "openDrive" */
function feedKey(decl: StrategyDeclaration): keyof FeedFlags | null {
  if (!decl.feedFlag) return null;
  const parts = decl.feedFlag.replace(/^FEED_/, "").toLowerCase().split("_");
  const key = parts[0] + parts.slice(1).map((p) => p[0].toUpperCase() + p.slice(1)).join("");
  return key as keyof FeedFlags;
}

function feedState(decl: StrategyDeclaration, feeds: FeedFlags | null): string {
  const key = feedKey(decl);
  if (!key) return "";
  const v = feeds ? feeds[key] : undefined;
  if (v === undefined) return "state unknown (feed not connected)";
  return v ? "ON" : "OFF";
}

const STATUS_ORDER: StrategyStatus[] = ["live", "off", "retired"];
const STATUS_LABEL: Record<StrategyStatus, string> = { live: "LIVE", off: "OFF", retired: "RETIRED" };
const STATUS_DOT: Record<StrategyStatus, string> = {
  live: "bg-long",
  off: "bg-yellow-400",
  retired: "bg-zinc-600",
};
const STATUS_TEXT: Record<StrategyStatus, string> = {
  live: "text-long",
  off: "text-yellow-400",
  retired: "text-zinc-500",
};

function StrategyCard({ s, feeds }: { s: StrategyDeclaration; feeds: FeedFlags | null }) {
  const rows = fieldRows(s);
  const state = feedState(s, feeds);
  return (
    <article
      id={`strategy-${s.id}`}
      className="mb-6 scroll-mt-24 rounded-lg border border-zinc-800 bg-zinc-900/40 p-5"
    >
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-lg font-bold text-zinc-50">{labelFor(s)}</h3>
        <span className={`font-mono text-xs ${STATUS_TEXT[s.status]}`}>
          <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${STATUS_DOT[s.status]}`} />
          {STATUS_LABEL[s.status]}
        </span>
        {s.feedFlag && (
          <span className="font-mono text-xs text-zinc-500">
            {s.feedFlag} = <span className={state === "ON" ? "text-long" : "text-zinc-300"}>{state}</span>
          </span>
        )}
        <span className="font-mono text-[10px] text-zinc-600">strategy id: {s.id}</span>
      </header>

      <p className="mb-3 text-sm leading-relaxed text-zinc-300">{s.doc}</p>

      <div className="mb-4 rounded-md border border-zinc-800/70 bg-zinc-950/40 p-3">
        <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-zinc-500">how a fire becomes a live ticket</p>
        <p className="whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{s.plan}</p>
      </div>

      {rows.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wider text-zinc-500">
              <tr>
                <th className="py-1.5 pr-3">field</th>
                <th className="py-1.5 pr-3">value</th>
                <th className="py-1.5">what it means</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-zinc-800/60 align-top">
                  <td className="py-1.5 pr-3 font-mono text-zinc-300">{r.key}</td>
                  <td className="py-1.5 pr-3 font-mono text-long">{r.value}</td>
                  <td className="py-1.5 text-zinc-400">{r.doc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s.studies.length > 0 && (
        <div className="mb-3">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-zinc-500">measured by</p>
          <div className="flex flex-wrap gap-1.5">
            {s.studies.map((id) => (
              <Link
                key={id}
                href={`/studies#study-${id}`}
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-400 hover:border-info/60 hover:text-zinc-200"
              >
                {id}
              </Link>
            ))}
          </div>
        </div>
      )}

      <p className="font-mono text-[10px] text-zinc-600">
        config: {s.configSource} {s.liveKnobs ? `· live knobs: ${s.liveKnobs}` : ""}
      </p>
    </article>
  );
}

export function StrategyRegistrySection({ feeds = null }: { feeds?: FeedFlags | null }) {
  return (
    <section className="mb-10">
      <h2 className="mb-2 text-xl font-bold text-zinc-50">
        The strategies — condition by condition, rendered from the registry
      </h2>
      <p className="mb-5 max-w-3xl text-sm leading-relaxed text-zinc-400">
        Every threshold below is read from the same config objects the live feed trades (
        <code className="text-zinc-300">lib/strategies/registry.ts</code> → <code className="text-zinc-300">*_PROD</code> in
        the detector modules). This page can no longer disagree with the code — if a value changes, this table changes with
        it. Live ON/OFF state is read from this server via <code className="text-zinc-300">/api/gc?action=health</code>.
      </p>

      {STATUS_ORDER.map((status) => {
        const list = STRATEGIES.filter((s) => s.status === status);
        if (!list.length) return null;
        return (
          <div key={status} className="mb-6">
            <h3 className={`mb-3 font-mono text-xs uppercase tracking-[0.25em] ${status === "live" ? "text-long" : status === "off" ? "text-yellow-500" : "text-zinc-600"}`}>
              {STATUS_LABEL[status]}
            </h3>
            {list.map((s) => (
              <StrategyCard key={s.id} s={s} feeds={feeds} />
            ))}
          </div>
        );
      })}
    </section>
  );
}
