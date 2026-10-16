"use client";

import type { ExecHealth } from "@/lib/useExecStatus";
import AccountSettings from "./AccountSettings";
import TradingToggle from "./TradingToggle";

/* ------------------------------------------------------------------ *
 * ExecStatusBar — the live status strip at the top of the dashboard.
 * Mirrors the executor's health endpoint (guard state, account
 * snapshot, day-plan rules, feeds, tape). The parent page polls
 * /api/gc?action=health once (20s) and shares the snapshot with this
 * strip and the HealthPipeline. DISPLAY-ONLY: the real gate is
 * crossGuardGate() before every order.
 * ------------------------------------------------------------------ */

const usd = (n: number) => `${n < 0 ? "−$" : "+$"}${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

function Chip({ on, label, tone = "zinc" }: { on: boolean; label: string; tone?: "long" | "short" | "zinc" | "amber" }) {
  const onCls = tone === "long" ? "text-long border-long/40" : tone === "short" ? "text-short border-short/40" : tone === "amber" ? "text-amber-400 border-amber-400/40" : "text-zinc-300 border-zinc-600";
  return (
    <span className={`rounded border px-1.5 py-0.5 font-mono text-[9px] leading-none ${on ? onCls : "border-zinc-800 text-zinc-600"}`}>
      {label}
    </span>
  );
}

export default function ExecStatusBar({ data }: { data: ExecHealth | null }) {
  const h = data;
  const ex = h?.execution ?? null;
  const p = ex?.protections ?? null;
  const st = p?.status ?? { state: "watch" as const, label: "…", reason: "connecting", halts: [] };
  const feeds = ex?.feeds ?? null;
  const tape = ex?.liveFeed ?? null;
  const market = ex?.market ?? null;

  const badgeCls =
    st.state === "live" ? "bg-long/10 text-long border-long/40"
    : st.state === "halted" ? "bg-short/10 text-short border-short/40"
    : st.state === "dry" ? "bg-zinc-800 text-zinc-300 border-zinc-600"
    : "bg-amber-400/10 text-amber-400 border-amber-400/40";

  const margin = p && p.account ? Math.round(p.account.equity - p.floor) : null;
  const dd = p ? Math.round((p.highWater ?? p.account?.equity ?? 0) - (p.account?.equity ?? 0)) : null;

  return (
    <div className="mb-4 rounded-md border border-zinc-800 bg-panel px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {/* executor state */}
        <span className={`flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-bold ${badgeCls}`}>
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${st.state === "live" ? "bg-long" : st.state === "halted" ? "bg-short" : st.state === "dry" ? "bg-zinc-500" : "bg-amber-400"}`} />
          {st.label}
        </span>
        <span className="font-mono text-[10px] text-zinc-400">
          {ex?.executeLive ? "EXECUTE_LIVE" : "dry-run"} · {ex?.account ?? "no account"} · {ex?.instrument ?? ""}
        </span>
        <AccountSettings />
        <TradingToggle />

        {/* account + day */}
        {p?.account && (
          <>
            <span className="font-mono text-[10px] text-zinc-400">
              eq <span className="text-zinc-200">${Math.round(p.account.equity).toLocaleString("en-US")}</span>
              {" · "}day <span className={p.dayPnl >= 0 ? "text-long" : "text-short"}>{usd(p.dayPnl)}</span>
              {margin !== null && <> {" · "}floor <span className="text-zinc-200">${Math.round(p.floor).toLocaleString("en-US")}</span> (buffer +{Math.round(margin).toLocaleString("en-US")})</>}
            </span>
            <Chip on={!!p.profitArmed} label={`ARM +$${p.profitArm}`} tone={p.profitArmed ? "amber" : "zinc"} />
            <Chip on={!!p.dd.halved} label={`dd ${p.dd.halved ? "HALVED" : "full"}`} tone={p.dd.halved ? "short" : "zinc"} />
          </>
        )}

        {/* rule chips */}
        <span className="hidden items-center gap-1 md:flex">
          <Chip on label={`−$${p?.dailyFloor ?? 250}/day`} />
          <Chip on label={`consist $${p?.consistencyCap ?? 900}`} />
          <Chip on={!(p?.tiers?.length)} label={p?.tiers?.length ? `tiers ${p.tiers.length}` : "no tiers"} />
        </span>

        {/* feeds */}
        {feeds && (
          <span className="hidden items-center gap-1 lg:flex">
            <Chip on={feeds.momentum} label="MOM" tone="long" />
            <Chip on={feeds.rth} label="RTH" tone="long" />
            <Chip on={feeds.openDrive} label="DRIVE" tone="long" />
            <Chip on={feeds.open} label="OPEN" tone="long" />
          </span>
        )}

        {/* tape + market */}
        <span className="font-mono text-[10px] text-zinc-400">
          {tape && (
            <>
              <span className={tape.connected ? "text-long" : "text-short"}>{tape.connected ? "feed ✓" : "feed ✗"}</span>
              {" · "}{tape.minutes}m{tape.ratio !== null ? ` · vol×${tape.ratio.toFixed(1)}` : ""}
            </>
          )}
          {market && (
            <>{" · "}{market.open ? "open" : "closed"}{market.next ? ` · ${market.next.kind} ${new Date(market.next.atMs).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })} ET` : ""}</>
          )}
          {h?.now && <>{" · "}{new Date(h.now).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false })} ET</>}
        </span>
      </div>

      {/* halt reason line — only when something blocks */}
      {st.halts.length > 0 && (
        <p className="mt-1.5 truncate border-t border-zinc-800 pt-1.5 font-mono text-[10px] text-short" title={st.reason}>
          ⛔ {st.reason}
        </p>
      )}
    </div>
  );
}
