"use client";

/* NQ earnings — two ledgers side by side:
 *   LEFT  "REPORTED"  — every NDX name that has reported, most recent first
 *   RIGHT "UPCOMING"  — every NDX name with a known next date, soonest first
 * Display-only context. */

import { useRef, useState, type ReactNode } from "react";
import type { QuarterData, ReportedRow, QuarterRow } from "@/lib/earnings";
import { daysAway, shortDate, surpriseLabel, etNow } from "@/lib/macroFmt";
import { BentoCard } from "./BentoCard";

function monthLabel(dayISO: string): string {
  const [y, m] = dayISO.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1))).toUpperCase();
}

function Skeleton() {
  return (
    <div className="space-y-2 p-2">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className="h-7 animate-pulse rounded bg-zinc-800/60" />
      ))}
    </div>
  );
}

function Surprise({ pct }: { pct: number | null }) {
  return (
    <span className={`ml-1.5 ${pct == null ? "text-zinc-600" : pct > 0 ? "text-long" : pct < 0 ? "text-short" : "text-zinc-400"}`}>
      {surpriseLabel(pct)}
    </span>
  );
}

export default function EarningsPanel({
  data,
  stale,
  error,
}: {
  data: QuarterData | null;
  stale: boolean;
  error?: string;
}) {
  const nowDay = etNow().day;

/* group by month label; rows arrive pre-sorted (reported desc, upcoming asc) */
function groupByMonth<T>(rows: T[], dayOf: (r: T) => string | null): { label: string; rows: T[] }[] {
  const out: { label: string; rows: T[] }[] = [];
  let last = "";
  for (const r of rows) {
    const d = dayOf(r);
    const gk = d ? monthLabel(d) : "UNKNOWN";
    if (gk !== last) {
      last = gk;
      out.push({ label: gk, rows: [] });
    }
    out[out.length - 1].rows.push(r);
  }
  return out;
}

  const reportedGroups = data ? groupByMonth<ReportedRow>(data.reported, (r) => r.reportedDate ?? r.fiscalQ) : [];
  const upcomingGroups = data ? groupByMonth<QuarterRow>(data.upcoming, (r) => r.nextDate) : [];

  return (
    <BentoCard
      kicker="Equities"
      title="NQ earnings · full quarter"
      tone="long"
      badge={
        <span className="flex items-center gap-1.5">
          {data && (
            <span className={stale ? "text-warn" : "text-zinc-500"}>
              {data.provider}
              {stale ? " · stale" : ""}
            </span>
          )}
          <span className="text-zinc-500">{data ? `${data.reported.length} reported · ${data.upcoming.length} upcoming` : "loading…"}</span>
        </span>
      }
    >
      {error && <p className="mb-2 font-mono text-[10px] text-warn">feed error: {error}</p>}

      {!data ? (
        <Skeleton />
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* LEFT — reported, most recent first */}
          <div>
            <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-long">Reported · most recent first</p>
            <Ledger>
              <table className="w-full text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-800 bg-[#101013] font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1 pl-2 pr-2 font-medium">ticker</th>
                    <th className="py-1 pr-2 font-medium">reported</th>
                    <th className="py-1 pr-2 text-right font-medium">eps</th>
                    <th className="py-1 pr-2 text-right font-medium">est</th>
                    <th className="py-1 pr-2 font-medium">surprise</th>
                  </tr>
                </thead>
                <tbody>
                  {reportedGroups.map((g) => (
                    <ReportedGroup key={g.label} label={g.label} rows={g.rows} />
                  ))}
                </tbody>
              </table>
            </Ledger>
          </div>

          {/* RIGHT — upcoming, soonest first */}
          <div>
            <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.2em] text-info">Upcoming · soonest first</p>
            <Ledger>
              <table className="w-full text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-zinc-800 bg-[#101013] font-mono text-[9px] uppercase tracking-wider text-zinc-500">
                    <th className="py-1 pl-2 pr-2 font-medium">ticker</th>
                    <th className="py-1 pr-2 font-medium">next earnings</th>
                    <th className="py-1 pr-2 text-right font-medium">eps est</th>
                    <th className="py-1 pr-2 font-medium">time</th>
                  </tr>
                </thead>
                <tbody>
                  {upcomingGroups.map((g) => (
                    <UpcomingGroup key={g.label} label={g.label} rows={g.rows} nowDay={nowDay} />
                  ))}
                </tbody>
              </table>
            </Ledger>
          </div>
        </div>
      )}
      <p className="mt-2 font-mono text-[9px] leading-snug text-zinc-600">
        finnhub calendar (nasdaq scan fallback) · est = unconfirmed · BMO/AMC only when confirmed · surprise excludes revenue
      </p>
    </BentoCard>
  );
}

function ReportedGroup({ label, rows }: { label: string; rows: ReportedRow[] }) {
  return (
    <>
      <tr>
        <td colSpan={5} className="pt-1.5 pb-0.5 pl-2 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.symbol} className="border-b border-zinc-800/40 last:border-0">
          <td className="py-0.5 pl-2 pr-2 whitespace-nowrap">
            <span className="font-semibold text-zinc-100">{r.symbol}</span>
            <span className="ml-1.5 hidden text-[9px] text-zinc-500 2xl:inline">{r.name}</span>
          </td>
          <td className="py-0.5 pr-2 whitespace-nowrap text-zinc-400">{r.reportedDate ? shortDate(r.reportedDate) : r.fiscalQ ?? "—"}</td>
          <td className="py-0.5 pr-2 text-right tabular-nums text-zinc-200 whitespace-nowrap">{r.eps == null ? "—" : r.eps.toFixed(2)}</td>
          <td className="py-0.5 pr-2 text-right tabular-nums text-zinc-500 whitespace-nowrap">{r.consensus == null ? "—" : r.consensus.toFixed(2)}</td>
          <td className="py-0.5 pr-2 whitespace-nowrap">
            <Surprise pct={r.surprisePct} />
          </td>
        </tr>
      ))}
    </>
  );
}

function UpcomingGroup({ label, rows, nowDay }: { label: string; rows: QuarterRow[]; nowDay: string }) {
  return (
    <>
      <tr>
        <td colSpan={4} className="pt-1.5 pb-0.5 pl-2 font-mono text-[9px] font-semibold uppercase tracking-wider text-zinc-500">
          {label}
        </td>
      </tr>
      {rows.map((r) => {
        const d = daysAway(r.nextDate!, nowDay);
        return (
          <tr key={r.symbol} className="border-b border-zinc-800/40 last:border-0">
            <td className="py-0.5 pl-2 pr-2 whitespace-nowrap">
              <span className="font-semibold text-zinc-100">{r.symbol}</span>
              <span className="ml-1.5 hidden text-[9px] text-zinc-500 2xl:inline">{r.name}</span>
            </td>
            <td className="py-0.5 pr-2 whitespace-nowrap">
              <span className={d === 0 ? "text-info" : "text-zinc-200"}>{shortDate(r.nextDate!)}</span>
              <span className="ml-1.5 text-[9px] text-zinc-500">{d === 0 ? "today" : d === 1 ? "tomorrow" : `in ${d}d`}</span>
            </td>
            <td className="py-0.5 pr-2 text-right tabular-nums text-zinc-400 whitespace-nowrap">{r.nextEpsEst == null ? "—" : r.nextEpsEst.toFixed(2)}</td>
            <td className="py-0.5 pr-2 whitespace-nowrap">
              {r.nextEstimated ? (
                <span className="rounded border border-zinc-700 px-1 font-mono text-[8px] text-zinc-500">EST</span>
              ) : (
                <span className={`rounded border px-1 font-mono text-[8px] ${r.nextTime === "bmo" ? "border-info/50 text-info" : "border-warn/50 text-warn"}`}>
                  {r.nextTime === "bmo" ? "BMO" : "AMC"}
                </span>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}


/* internal-scroll ledger with sticky header + conditional scroll shadow */
function Ledger({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  return (
    <div
      ref={ref}
      onScroll={() => setScrolled((ref.current?.scrollTop ?? 0) > 0)}
      className={`max-h-[320px] overflow-y-auto rounded border border-zinc-800 bg-zinc-900/30 ${
        scrolled ? "shadow-[inset_0_6px_8px_-6px_rgba(0,0,0,0.6)]" : ""
      }`}
    >
      <div className="[&_thead]:sticky [&_thead]:top-0">{children}</div>
    </div>
  );
}
