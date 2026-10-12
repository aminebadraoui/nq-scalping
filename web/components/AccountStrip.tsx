"use client";

import { useEffect, useState } from "react";

/* ------------------------------------------------------------------ *
 * AccountStrip — ONE live account line for EVERY tab.
 *
 * Polls /api/account (the single account endpoint backed by the shared
 * CrossTrade read layer) so Overview, Execution, Risk, Journal and the
 * rest always show the same numbers: netLiq, guard day P&L, open P&L,
 * current MNQ position and today's executed-trade net.
 *
 * Display-only. The real gate is crossGuardGate() before every order.
 * ------------------------------------------------------------------ */

type AccountPayload = {
  ok: boolean;
  account: {
    name: string | null;
    accountId: string | number | null;
    netLiq: number | null;
    openPnl: number | null;
    realizedPnl: number | null;
    weekRealizedPnl: number | null;
    stage: string | null;
    at: number | null;
  } | null;
  guard: {
    dayPnl: number;
    dayPeak: number;
    floor: number;
    profitArmed: boolean;
    stage: string;
  } | null;
  position: { dir: "long" | "short"; qty: number } | null;
  today: { netUsd: number; rows: number };
  manual: { count: number; netUsd: number } | null;
} | null;

const usd = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : `${n < 0 ? "−$" : "+$"}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

const usdPlain = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n)
    ? "—"
    : `$${Math.round(n).toLocaleString("en-US")}`;

/** the account payload, polled every 15s (paused in hidden tabs) */
export function useAccount(intervalMs = 15_000): AccountPayload {
  const [p, setP] = useState<AccountPayload>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const r = await fetch("/api/account", { cache: "no-store" });
        if (r.ok) {
          const j = (await r.json()) as AccountPayload;
          if (!stop) setP(j);
        }
      } catch {
        /* keep the last payload */
      }
      if (!stop) timer = setTimeout(load, intervalMs);
    };
    const onVis = () => {
      if (document.visibilityState === "visible") load();
    };
    load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [intervalMs]);
  return p;
}

/** inline account line — embeddable in any panel (journal etc.) */
export function AccountLine({ payload, className = "" }: { payload: AccountPayload; className?: string }) {
  const a = payload?.account ?? null;
  const g = payload?.guard ?? null;
  const pos = payload?.position ?? null;
  const today = payload?.today ?? null;
  if (!payload || !a) {
    return <span className={`font-mono text-[10px] text-zinc-500 ${className}`}>account …</span>;
  }
  return (
    <span className={`font-mono text-[10px] leading-snug text-zinc-400 ${className}`}>
      <span className="text-zinc-500">{a.name ?? "acct"}</span>{" "}
      <span className="text-zinc-200">{usdPlain(a.netLiq)}</span>
      {" · "}day <span className={g && g.dayPnl >= 0 ? "text-long" : "text-short"}>{usd(g?.dayPnl)}</span>
      {" · "}open{" "}
      <span className={(a.openPnl ?? 0) >= 0 ? "text-long" : "text-short"}>{usd(a.openPnl)}</span>
      {pos ? (
        <>
          {" · "}pos{" "}
          <span className={pos.dir === "long" ? "text-long" : "text-short"}>
            {pos.dir.toUpperCase()} {pos.qty}
          </span>
        </>
      ) : (
        <span className="text-zinc-600"> · flat</span>
      )}
      {" · "}today{" "}
      <span className={(today?.netUsd ?? 0) >= 0 ? "text-long" : "text-short"}>{usd(today?.netUsd)}</span>
      {payload.manual && payload.manual.count > 0 && (
        <>
          {" · "}
          <span
            title={`manual actions detected today (${payload.manual.count}) — entries/exits/orders the bot did not make · net ${usd(payload.manual.netUsd)}`}
            className="text-warn"
          >
            ⚠ manual {payload.manual.count}
          </span>
        </>
      )}
    </span>
  );
}

/** the thin strip mounted under the nav on EVERY page */
export default function AccountStrip() {
  const payload = useAccount();
  return (
    <div className="border-b border-zinc-800/60 bg-zinc-950/60">
      <div className="mx-auto flex w-full max-w-[1800px] items-center gap-x-4 gap-y-0.5 px-4 py-1">
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-widest text-zinc-600">account</span>
        <AccountLine payload={payload} className="min-w-0 truncate" />
        <span className="ml-auto hidden shrink-0 font-mono text-[9px] text-zinc-700 lg:inline">
          CrossTrade → Tradovate · single source: /api/account
        </span>
      </div>
    </div>
  );
}
