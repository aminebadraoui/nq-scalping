"use client";

/* MACRO TAB — every macro box that used to live on the Overview:
 * the AI briefing, the interpretation layer (combined all-families
 * read on top, then per-family combination reads + per-metric guides
 * and AI reads), the market-context band (macro pulse / cross-asset /
 * treasuries), the detail band (earnings / week ahead) and the
 * freshness footer. The data panels poll /api/macro every 60s; the
 * interpretation layer regenerates daily (09:20 ET cron + nightly
 * post-close) with its own manual refresh button. */

import MacroPulseCard from "@/components/MacroPulseCard";
import CrossAssetCard from "@/components/CrossAssetCard";
import TreasuriesCard from "@/components/TreasuriesCard";
import NewsCalendarPanel from "@/components/NewsCalendarPanel";
import EarningsPanel from "@/components/EarningsPanel";
import MacroFooter from "@/components/MacroFooter";
import AiBriefingCard from "@/components/AiBriefingCard";
import MacroInterpretation from "@/components/MacroInterpretation";
import { useMacro } from "@/lib/useMacro";

export default function MacroPage() {
  const macro = useMacro();

  return (
    <main className="mx-auto min-h-screen max-w-[1600px] px-4 py-6 text-zinc-100">
      {/* header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.25em] text-info">macro · market context</p>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-50">
            Cross-asset · rates · calendar — every metric read and interpreted
          </h1>
        </div>
        <span className="font-mono text-[10px] text-zinc-500">data polls 60s · interpretations refreshed daily</span>
      </div>

      {/* the interpretation layer: combined all-families read ON TOP,
          then per-family combination reads + per-metric guides/AI reads.
          Regenerated daily (09:20 ET cron + nightly) — refresh button
          inside the combined card. */}
      <MacroInterpretation />

      {/* the daily NQ situation briefing (moved from the Overview) */}
      <div className="my-4">
        <AiBriefingCard />
      </div>

      {/* market context band: macro pulse / cross-asset / rates */}
      <div className="mt-4">
        <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-zinc-500">market context</p>
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-12 md:col-span-6 xl:col-span-3">
            <MacroPulseCard
              watch={macro.ctx?.watch ?? null}
              news={macro.ctx?.news.data ?? null}
              earnings={macro.ctx?.earnings.data ?? null}
              nqPrice={0}
              realizedBandPct={null}
            />
          </div>
          <div className="col-span-12 md:col-span-6 xl:col-span-6">
            <CrossAssetCard watch={macro.ctx?.watch ?? null} nqPct={null} />
          </div>
          <div className="col-span-12 md:col-span-12 xl:col-span-3">
            <TreasuriesCard
              data={macro.ctx?.bonds.data ?? null}
              intraday={macro.ctx?.bonds.intraday ?? null}
              stale={macro.ctx ? !macro.ctx.bonds.ok : false}
              watch={macro.ctx?.watch ?? null}
            />
          </div>
        </div>
      </div>

      {/* detail layer: earnings 8 / week ahead 4 */}
      <div className="mt-4 grid grid-cols-12 gap-4">
        <div className="col-span-12 xl:col-span-8">
          <EarningsPanel data={macro.ctx?.earnings.data ?? null} stale={macro.ctx ? !macro.ctx.earnings.ok : false} error={macro.ctx?.earnings.error} />
        </div>
        <div className="col-span-12 xl:col-span-4">
          <NewsCalendarPanel week={macro.ctx?.news.data ?? null} stale={macro.ctx ? !macro.ctx.news.ok : false} error={macro.ctx?.news.error} />
        </div>
      </div>

      <MacroFooter ctx={macro.ctx} error={macro.error} />
    </main>
  );
}
