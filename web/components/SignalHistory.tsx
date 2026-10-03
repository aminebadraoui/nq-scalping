"use client";

import { useEffect, useRef, useState } from "react";

type CompactCandidate = {
  side: "bid" | "ask";
  price: number;
  size: number;
  refillSize: number;
  refills: number;
  absorbed: number;
  consistency: number;
  confidence: number;
};

type DomContext = {
  nq: {
    ts: number;
    candidates: CompactCandidate[];
    nearEntry: CompactCandidate[];
    nearStop: CompactCandidate[];
    nearTarget: CompactCandidate[];
  };
  es: { ts: number; candidates: CompactCandidate[] };
};

type HistoryEntry = {
  ts: number;
  timeET: string;
  day: string;
  symbol: string;
  side: "long" | "short" | "none";
  price: number;
  entry: string;
  stop: string;
  target: string;
  size?: string;
  verdict: string;
  headline: string;
  source: string;
  test: boolean;
  sent: boolean;
  reason: string;
  dom?: DomContext | null;
};

type SignalResponse = {
  ok: boolean;
  live: boolean;
  note: string | null;
  lastError: string | null;
  history: HistoryEntry[];
};

const SIDE_STYLE: Record<HistoryEntry["side"], string> = {
  long: "border-long/50 bg-long/10 text-long",
  short: "border-short/50 bg-short/10 text-short",
  none: "border-zinc-700 bg-zinc-800/40 text-zinc-400",
};

const SIDE_LABEL: Record<HistoryEntry["side"], string> = {
  long: "LONG",
  short: "SHORT",
  none: "—",
};

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function SignalHistory() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [live, setLive] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      fetch("/api/signal")
        .then((r) => r.json())
        .then((j: SignalResponse) => {
          if (cancelled || !j.ok) return;
          setEntries(j.history ?? []);
          setLive(j.live);
          setNote(j.lastError ?? j.note ?? null);
          setLoaded(true);
        })
        .catch(() => {});
    };
    tick();
    timerRef.current = setInterval(tick, 30000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Signal history</h2>
        <span className={`font-mono text-[10px] ${live ? "text-long" : "text-zinc-500"}`}>
          {live === null ? "…" : live ? "feed live" : "feed idle"}
        </span>
      </div>

      <p className="mb-2 font-mono text-[10px] leading-snug text-zinc-500">
        every Telegram push from the always-on signal feed — the completed reversal sequence
        (location + mechanism + trigger), most recent first
      </p>

      {note && <p className="mb-2 font-mono text-[10px] text-warn">{note}</p>}

      {loaded && entries.length === 0 && (
        <p className="font-mono text-xs text-zinc-600">
          no signals pushed yet — a card is sent the moment the sequence completes
        </p>
      )}

      <div className="max-h-[560px] space-y-1.5 overflow-y-auto pr-1">
        {entries.map((e) => (
          <div key={`${e.ts}|${e.day}|${e.side}|${e.price}`} className="rounded border border-zinc-800/70 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2 font-mono text-[10px]">
              <span className="text-zinc-400">
                {e.day} {e.timeET || "—"} NY
              </span>
              <span className="flex items-center gap-1.5">
                {e.test && <span className="rounded border border-zinc-700 px-1 py-0.5 text-[9px] text-zinc-500">manual</span>}
                <span className={`rounded border px-1 py-0.5 text-[9px] ${e.sent ? "border-info/40 bg-info/10 text-info" : "border-short/40 bg-short/10 text-short"}`}>
                  {e.sent ? "✓ sent" : "✗ failed"}
                </span>
                <span className={`rounded border px-1 py-0.5 text-[9px] font-semibold ${SIDE_STYLE[e.side]}`}>
                  {SIDE_LABEL[e.side]}
                </span>
              </span>
            </div>

            <div className="mt-1 flex items-baseline justify-between gap-2">
              <span className="font-mono text-[13px] font-semibold text-zinc-100">
                {e.symbol} {fmt(e.price)}
              </span>
              <span className="break-words text-right font-mono text-[10px] leading-snug text-zinc-500">{e.verdict}</span>
            </div>

            <div className="mt-1 grid grid-cols-1 gap-0.5 font-mono text-[10px] leading-snug text-zinc-400">
              <span><span className="text-zinc-600">ENTRY</span> {e.entry || "—"}</span>
              <span><span className="text-zinc-600">STOP</span> {e.stop || "—"}</span>
              <span><span className="text-zinc-600">TARGET</span> {e.target || "—"}</span>
              <span><span className="text-zinc-600">SIZE</span> {e.size || "—"}</span>
            </div>

            {/* the DOM picture captured at signal time — observational only */}
            {e.dom && (
              <div className="mt-1 border-t border-zinc-800/60 pt-0.5 font-mono text-[9px] leading-snug text-zinc-500">
                <div className="text-zinc-600">DOM @ signal</div>
                {(
                  [
                    ["entry", e.dom.nq.nearEntry],
                    ["stop", e.dom.nq.nearStop],
                    ["target", e.dom.nq.nearTarget],
                  ] as [string, CompactCandidate[]][]
                ).map(([label, rows]) =>
                  rows.map((c, i) => (
                    <div key={`${label}|${i}`} className="flex justify-between">
                      <span>
                        <span className={c.side === "bid" ? "text-long" : "text-short"}>{c.side === "bid" ? "BID" : "ASK"}</span>{" "}
                        {fmt(c.price)} near {label} · refills {c.refills} · slice {c.refillSize} · abs {c.absorbed}
                      </span>
                      <span title={`confidence ${(c.confidence * 100).toFixed(0)}%`}>
                        {(c.confidence * 100).toFixed(0)}%
                      </span>
                    </div>
                  )),
                )}
                {e.dom.es.candidates.map((c, i) => (
                  <div key={`es|${i}`} className="flex justify-between">
                    <span>
                      <span className="text-zinc-600">ES</span>{" "}
                      <span className={c.side === "bid" ? "text-long" : "text-short"}>{c.side === "bid" ? "BID" : "ASK"}</span>{" "}
                      {fmt(c.price)} · refills {c.refills} · slice {c.refillSize} · abs {c.absorbed}
                    </span>
                    <span title={`confidence ${(c.confidence * 100).toFixed(0)}%`}>
                      {(c.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
                {e.dom.nq.candidates.length === 0 && e.dom.es.candidates.length === 0 && <div>no refill signatures in the window</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
