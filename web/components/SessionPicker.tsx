"use client";

/** One collected dataset, as listed by /api/gc?action=datasets (newest first). */
export type DatasetInfo = {
  date: string;
  sessions: ("RTH" | "ETH")[];
  candles: Record<"RTH" | "ETH", number>;
};

/**
 * Session browser: every collected date, grouped with its available session
 * windows (ETH = full day 18:00→16:59 NY, RTH = 09:30→16:00 NY). Tapping a
 * chip loads that session into the workspace (chart + footprint ladder);
 * the newest date doubles as the LIVE view (live ticks keep streaming into
 * it). Sorted newest-first by the API.
 */
export default function SessionPicker({
  datasets,
  selected,
  isLive,
  onPick,
}: {
  datasets: DatasetInfo[];
  selected: { date: string; session: "RTH" | "ETH" } | null;
  /** true when the selected date is the newest collected (live ticks blend in) */
  isLive: boolean;
  onPick: (date: string, session: "RTH" | "ETH") => void;
}) {
  const latest = datasets[0]?.date ?? null;
  return (
    <div className="flex items-center gap-2 overflow-x-auto rounded-md border border-zinc-800 bg-panel px-3 py-2">
      <span className="mr-1 shrink-0 font-mono text-[9px] uppercase tracking-wider text-zinc-500">sessions</span>
      {datasets.map((d) => {
        const dateActive = selected?.date === d.date;
        const chipBase =
          "rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none transition-colors";
        return (
          <div key={d.date} className="flex shrink-0 items-center gap-1">
            <span className={`font-mono text-[10px] ${dateActive ? "text-zinc-200" : "text-zinc-600"}`}>
              {d.date.slice(5)}
              {d.date === latest ? " ⚡" : ""}
            </span>
            {d.sessions.map((s) => {
              const active = dateActive && selected?.session === s;
              return (
                <button
                  key={s}
                  onClick={() => onPick(d.date, s)}
                  title={`${d.date} ${s} · ${d.candles[s] ?? 0} minutes${d.date === latest ? " — live ticks keep streaming into this session" : ""}`}
                  className={`${chipBase} ${
                    active
                      ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                      : "border-zinc-700 bg-zinc-950/40 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  }`}
                >
                  {s}
                </button>
              );
            })}
          </div>
        );
      })}
      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-500">
        {selected ? (
          <>
            viewing <span className="text-zinc-300">{selected.date}</span>{" "}
            <span className={selected.session === "ETH" ? "text-info" : "text-warn"}>{selected.session}</span>
            {isLive ? <span className="text-long"> · live</span> : null}
          </>
        ) : (
          "no sessions collected yet"
        )}
      </span>
    </div>
  );
}
