"use client";

/* MACRO INTERPRETATION — the Macro tab's AI layer (presentational;
 * the fetching lives in lib/useMacroInterpret.ts):
 *   · the COMPLETE COMBINED interpretation across all families (top),
 *     with the NQ tape folded in (the retired briefing's territory)
 *   · per-family AI reads of the metric combinations inside each family
 *   · per-metric AI reads, under each metric's static up/down guide
 * Every read has TWO parts: explain + the impact on reading NQ.
 * DISPLAY-ONLY context — never imported by signal code. */

import type { InterpretRow } from "@/lib/macroInterpret";
import type { InterpretDirection, InterpretStance } from "@/lib/interpretText";
import type { InterpretLoad } from "@/lib/useMacroInterpret";
import { FAMILIES, METRIC_GUIDES, type FamilyDef, type MetricGuide } from "@/lib/macroGuide";

function etStamp(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(t));
  const g: Record<string, string> = {};
  for (const p of parts) g[p.type] = p.value;
  return `${g.month}-${g.day} ${g.hour}:${g.minute} ET`;
}

const STANCE_TONE: Record<InterpretStance, string> = {
  "risk-on": "border-long/30 bg-long/10 text-long",
  "risk-off": "border-short/30 bg-short/10 text-short",
  mixed: "border-warn/30 bg-warn/10 text-warn",
};

function DirArrow({ dir }: { dir: InterpretDirection }) {
  if (dir === "up") return <span className="text-long">▲</span>;
  if (dir === "down") return <span className="text-short">▼</span>;
  if (dir === "flat") return <span className="text-zinc-500">•</span>;
  return null;
}

const fmt = (v: number | null | undefined, dp = 2): string => (v == null ? "—" : v.toFixed(dp));
const signed = (v: number | null | undefined, dp = 2): string => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(dp)}`);

/* legacy rows (pre-explain/nqImpact) carried `read` — tolerate both */
type LooseRead = { id: string; explain?: string; nqImpact?: string; read?: string };
const pickExplain = (r: LooseRead | undefined): string | undefined => r?.explain ?? r?.read;
const pickImpact = (r: LooseRead | undefined): string | undefined => r?.nqImpact;

/* ---------------------------------------------------------------- *
 * per-metric card: value + direction, the static up/down guide +
 * NQ impact, then the AI explain + NQ impact
 * ---------------------------------------------------------------- */
function MetricCard({
  guide,
  value,
  dir,
  ai,
  aiSource,
}: {
  guide: MetricGuide;
  value: string | undefined;
  dir: InterpretDirection;
  ai: LooseRead | undefined;
  aiSource: boolean;
}) {
  const explain = pickExplain(ai);
  const impact = pickImpact(ai);
  return (
    <div className="rounded-lg border border-zinc-800/70 bg-zinc-900/30 p-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="truncate font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-zinc-400">{guide.label}</p>
        <p className="flex items-center gap-1 font-mono text-[12px] font-semibold tabular-nums text-zinc-100">
          {value ?? "—"} <DirArrow dir={dir} />
        </p>
      </div>
      <p className="mt-0.5 font-mono text-[9px] leading-snug text-zinc-600">{guide.what}</p>
      <div className="mt-1.5 space-y-0.5 border-t border-zinc-800/60 pt-1.5">
        {guide.up != null && guide.down != null ? (
          <>
            <p className="font-mono text-[9px] leading-snug text-zinc-500">
              <span className="text-long">▲ up — </span>
              {guide.up}
            </p>
            <p className="font-mono text-[9px] leading-snug text-zinc-500">
              <span className="text-short">▼ down — </span>
              {guide.down}
            </p>
          </>
        ) : (
          <p className="font-mono text-[9px] leading-snug text-zinc-500">{guide.read ?? guide.what}</p>
        )}
        <p className="font-mono text-[9px] leading-snug text-zinc-400">
          <span className="text-info">NQ — </span>
          {guide.nqImpact}
        </p>
      </div>
      <div className="mt-1.5 space-y-0.5 border-t border-zinc-800/60 pt-1.5">
        <p className={`font-mono text-[10px] leading-snug ${explain ? "text-info" : "text-zinc-600"}`}>
          {explain ? <span className="text-zinc-500">{aiSource ? "AI " : "rule "}explain — </span> : null}
          {explain ?? "no read yet"}
        </p>
        {impact && (
          <p className="font-mono text-[10px] leading-snug text-info">
            <span className="text-zinc-500">{aiSource ? "AI " : "rule "}NQ — </span>
            {impact}
          </p>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- *
 * one family: its AI combination read (explain + NQ) + metric cards
 * ---------------------------------------------------------------- */
function FamilySection({ fam, row }: { fam: FamilyDef; row: InterpretRow | null }) {
  const guides = METRIC_GUIDES.filter((g) => g.family === fam.id);
  const famRead = row?.families.find((f) => f.id === fam.id) as (LooseRead & { stance?: InterpretStance }) | undefined;
  const snapMetrics = new Map((row?.snapshot.metrics ?? []).map((m) => [m.id, m]));
  const aiMetrics = new Map((row?.metrics ?? []).map((m) => [m.id, m]));
  const explain = pickExplain(famRead);
  const impact = pickImpact(famRead);
  return (
    <section className="rounded-xl border border-zinc-800 bg-panel p-4">
      <header className="mb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold tracking-tight text-zinc-200">{fam.label}</h3>
          {famRead?.stance && (
            <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider ${STANCE_TONE[famRead.stance]}`}>
              {famRead.stance}
            </span>
          )}
        </div>
        <p className="mt-0.5 font-mono text-[9px] text-zinc-600">{fam.blurb}</p>
        <p className={`mt-1.5 font-mono text-[11px] leading-snug ${explain ? "text-info" : "text-zinc-600"}`}>
          {explain ? <span className="text-zinc-500">combination — </span> : null}
          {explain ?? "no family read yet"}
        </p>
        {impact && (
          <p className="mt-0.5 font-mono text-[11px] leading-snug text-info">
            <span className="text-zinc-500">NQ — </span>
            {impact}
          </p>
        )}
      </header>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {guides.map((g) => {
          const m = snapMetrics.get(g.id);
          return (
            <MetricCard
              key={g.id}
              guide={g}
              value={m?.value}
              dir={m?.direction ?? null}
              ai={aiMetrics.get(g.id)}
              aiSource={row?.source === "llm"}
            />
          );
        })}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- *
 * the combined all-families read — rendered ON TOP, with the tape
 * ---------------------------------------------------------------- */
function CombinedCard({
  row,
  error,
  refreshing,
  cooldownMs,
  refresh,
}: {
  row: InterpretRow | null;
  error: string | null;
  refreshing: boolean;
  cooldownMs: number;
  refresh: () => void;
}) {
  const combined = row?.combined ?? null;
  const tape = row?.snapshot.tape ?? null;
  const cooldownLabel = cooldownMs > 0 ? `cool ${Math.ceil(cooldownMs / 60_000)}m` : null;
  const badge = row ? (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
      {row.source === "llm" ? "DeepSeek" : "deterministic"} · {etStamp(row.generated_at)}
    </span>
  ) : null;
  return (
    <section className="relative mb-4 overflow-hidden rounded-xl border border-zinc-800 bg-panel p-4">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-long/60 via-info/25 to-transparent" />
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="mb-1 font-mono text-[10px] font-medium uppercase tracking-[0.14em] text-info">complete combined macro read</p>
          <p className="text-[15px] font-semibold leading-snug tracking-tight text-zinc-50">
            {combined ? combined.headline : "no interpretation generated yet — press refresh"}
          </p>
        </div>
        {badge}
      </header>

      {/* the tape — the retired AI briefing's bottom line, folded in */}
      {tape && (
        <div className="mb-2 flex flex-wrap gap-1">
          <span className="rounded-full border border-zinc-700/70 bg-zinc-900/50 px-2 py-0.5 font-mono text-[9px] tabular-nums text-zinc-300">
            NQ {fmt(tape.lastClose)}
          </span>
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] tabular-nums ${(tape.changePct ?? 0) >= 0 ? "border-long/25 bg-long/10 text-long" : "border-short/25 bg-short/10 text-short"}`}>
            {signed(tape.changePct)}%
          </span>
          <span className="rounded-full border border-zinc-700/70 bg-zinc-900/50 px-2 py-0.5 font-mono text-[9px] tabular-nums text-zinc-400">
            close {fmt(tape.closePosPct, 0)}% of range
          </span>
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[9px] tabular-nums ${(tape.cumulativeDelta ?? 0) >= 0 ? "border-long/25 bg-long/10 text-long" : "border-short/25 bg-short/10 text-short"}`}>
            Δ {tape.cumulativeDelta != null ? `${tape.cumulativeDelta >= 0 ? "+" : ""}${(tape.cumulativeDelta / 1000).toFixed(1)}k` : "—"}
          </span>
          <span className="rounded-full border border-zinc-700/70 bg-zinc-900/50 px-2 py-0.5 font-mono text-[9px] tabular-nums text-zinc-400">
            1σ ±{fmt(tape.realizedBandPct)}%
          </span>
          <span className="rounded-full border border-zinc-700/70 bg-zinc-900/50 px-2 py-0.5 font-mono text-[9px] tabular-nums text-zinc-400">
            {fmt(tape.sessionHigh, 0)} / {fmt(tape.sessionLow, 0)}
          </span>
          {tape.bars != null && tape.bars === 0 && (
            <span className="rounded-full border border-warn/30 bg-warn/10 px-2 py-0.5 font-mono text-[9px] text-warn">tape not open — prior session</span>
          )}
        </div>
      )}

      {combined && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className={`rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${STANCE_TONE[combined.stance]}`}>
            {combined.stance}
          </span>
          {row?.model && <span className="font-mono text-[10px] text-zinc-500">{row.model}</span>}
        </div>
      )}

      {combined && combined.read.length > 0 && (
        <div className="mb-2 space-y-0.5">
          {combined.read.map((d, i) => (
            <div key={i} className="font-mono text-[11px] leading-snug text-zinc-300">
              <span className="text-zinc-600">why </span>
              {d}
            </div>
          ))}
        </div>
      )}

      {combined && combined.caveats.length > 0 && (
        <p className="mb-2 font-mono text-[9px] leading-snug text-zinc-500">{combined.caveats.join(" · ")}</p>
      )}

      {error && <p className="mb-2 font-mono text-[9px] text-short">{error}</p>}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 pt-2">
        <span className="font-mono text-[9px] text-zinc-600">refreshed daily 09:20 ET · display-only, not a signal</span>
        <button
          onClick={refresh}
          disabled={refreshing}
          className={`rounded border px-2 py-0.5 font-mono text-[10px] ${
            refreshing ? "border-zinc-700 text-zinc-500" : "border-info/40 bg-info/10 text-info hover:border-info/70"
          }`}
        >
          {refreshing ? "regenerating…" : cooldownLabel ? `refresh (${cooldownLabel})` : "refresh now"}
        </button>
      </div>
    </section>
  );
}

export default function MacroInterpretation({
  load,
  refresh,
  refreshing,
}: {
  load: InterpretLoad;
  refresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div>
      {/* the complete combined interpretation — ON TOP */}
      <CombinedCard row={load.row} error={load.error} refreshing={refreshing} cooldownMs={load.cooldownMs} refresh={refresh} />

      {/* per-family combination reads + per-metric guides and AI reads */}
      <div className="space-y-4">
        {FAMILIES.map((f) => (
          <FamilySection key={f.id} fam={f} row={load.row} />
        ))}
      </div>
    </div>
  );
}
