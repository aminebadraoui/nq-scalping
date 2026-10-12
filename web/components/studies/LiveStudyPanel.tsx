/* The LIVE half of a study card: for every strategy the study measured,
 * its realized live record (from the daybook's nightly-consolidated
 * sessions) next to the backtest baseline — updated daily. Server
 * component: awaits the cached archive once per request. */

import { getLiveArchive } from "@/lib/liveArchiveServer";
import type { LiveFamily, LiveEdgeStatus } from "@/lib/liveArchive";
import { labelFor, type StrategyDeclaration } from "@/lib/strategies/registry";

export const STATUS_TONE: Record<LiveEdgeStatus, string> = {
  ok: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
  watch: "border-amber-800 bg-amber-950/40 text-amber-300",
  breach: "border-red-900 bg-red-950/40 text-red-400",
  insufficient: "border-zinc-700 bg-zinc-900/40 text-zinc-500",
};

export const STATUS_WORD: Record<LiveEdgeStatus, string> = {
  ok: "edge ok",
  watch: "edge watch",
  breach: "edge breach",
  insufficient: "insufficient data",
};

const money = (n: number) =>
  `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

const pct = (x: number | null) => (x === null ? "—" : `${Math.round(x * 100)}%`);

const expR = (x: number | null) => (x === null ? "—" : x.toFixed(2));

const DAY_CELLS = 10;

/** one family's live row inside a study card */
function FamilyRow({ s, fam }: { s: StrategyDeclaration; fam?: LiveFamily }) {
  if (!fam || fam.n === 0) {
    return (
      <div className="mt-2 rounded border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="font-mono text-[11px] font-semibold text-zinc-200">{labelFor(s)}</span>
          <span className="font-mono text-[10px] text-zinc-500">
            {s.id} · {s.status}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
          no live fills recorded for this family yet — the nightly consolidation adds each trading session.
        </p>
      </div>
    );
  }
  const days = fam.byDay.slice(-DAY_CELLS);
  return (
    <div className="mt-2 rounded border border-zinc-800/70 bg-zinc-950/40 px-3 py-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] font-semibold text-zinc-200">{labelFor(s)}</span>
        <span className="font-mono text-[10px] text-zinc-500">
          {s.id} · {s.status === "live" ? "LIVE" : s.status}
        </span>
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${STATUS_TONE[fam.status]}`} title={`realized expR ${expR(fam.meanExpR)} vs backtest baseline ${fam.baselineExpR}`}>
          {STATUS_WORD[fam.status]}
        </span>
      </div>
      <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
        <b className="text-zinc-200">{fam.n}</b> fills · WR <b className="text-zinc-200">{pct(fam.wr)}</b> · PF{" "}
        <b className="text-zinc-200">{fam.pf === null ? "—" : fam.pf.toFixed(2)}</b> · net{" "}
        <b className={fam.netUsd >= 0 ? "text-emerald-300" : "text-red-400"}>{money(fam.netUsd)}</b>
        {" · "}expR <b className="text-zinc-200">{expR(fam.meanExpR)}</b> vs backtest <b className="text-zinc-200">{fam.baselineExpR}</b>
      </p>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="font-mono text-[9px] text-zinc-600">{days[0]?.day ?? "—"}</span>
        <div className="flex gap-[3px]">
          {days.map((d) => (
            <span
              key={d.day}
              title={`${d.day} · ${d.n} fill${d.n === 1 ? "" : "s"} · ${d.wins}W/${d.losses}L · net ${money(d.netUsd)}`}
              className={`h-3 w-3 rounded-sm ${d.netUsd > 0 ? "bg-emerald-500/80" : d.netUsd < 0 ? "bg-red-500/80" : "bg-zinc-700"}`}
            />
          ))}
        </div>
        <span className="font-mono text-[9px] text-zinc-600">last {days[days.length - 1]?.day ?? "—"}</span>
      </div>
      <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-zinc-600">
        {fam.daysTraded} live session{fam.daysTraded === 1 ? "" : "s"} · {fam.firstDay}
        {fam.firstDay !== fam.lastDay ? ` → ${fam.lastDay}` : ""} · each square = one session net (green win / red loss /
        grey flat)
      </p>
    </div>
  );
}

export async function LiveStudyPanel({ studyId, strategies }: { studyId: string; strategies: StrategyDeclaration[] }) {
  // dedupe strategies that share a family so the panel never repeats a row
  const unique = [...new Map(strategies.map((s) => [s.family, s])).values()];
  const archive = unique.length > 0 ? await getLiveArchive() : null;

  return (
    <div className="border-t border-zinc-800/60 bg-zinc-950/25 px-4 pb-4 pt-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-mono text-[10px] uppercase tracking-wider text-sky-300">
          live · updated daily <span className="normal-case tracking-normal text-zinc-600">(nightly consolidation · {studyId})</span>
        </p>
        {archive?.lastDay && (
          <p className="font-mono text-[10px] text-zinc-500">
            last session <b className="text-zinc-300">{archive.lastDay}</b> · {archive.sessions} consolidated
          </p>
        )}
      </div>
      {unique.length === 0 ? (
        <p className="mt-2 text-xs leading-relaxed text-zinc-600">
          no live strategy wired to this study yet — the backtest above is the only record.
        </p>
      ) : (
        <>
          {unique.map((s) => (
            <FamilyRow key={s.family} s={s} fam={archive?.families.find((f) => f.family === s.family)} />
          ))}
          {!archive?.lastDay && (
            <p className="mt-2 text-[11px] leading-relaxed text-zinc-600">
              no consolidated live sessions in the archive yet — the nightly pipeline writes one per trading day (17:45 ET
              Mon–Fri).
            </p>
          )}
        </>
      )}
    </div>
  );
}
