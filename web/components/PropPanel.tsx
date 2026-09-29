"use client";

import { useState } from "react";
import { RAPID_EOD_50K, estimateEval, riskPerContract } from "@/lib/propRules";

const f = (n: number, dp = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/**
 * Position-size the sweep-reclaim strategy for the MyFundedFutures Rapid EOD
 * 50k eval. Slider = MNQ contracts; the card shows the risk/trade, the daily
 * and weekly expectancy, and the EV time to the $3,000 target. Full pass/ruin
 * numbers come from gcdata/prop_sim.py (Monte Carlo over the real sequence).
 */
export default function PropPanel() {
  const [contracts, setContracts] = useState(20);
  const riskPerTrade = contracts * riskPerContract();
  const e = estimateEval(RAPID_EOD_50K, riskPerTrade);
  const maxR = RAPID_EOD_50K.maxMicro * riskPerContract();

  return (
    <section className="rounded-md border border-zinc-800 bg-panel p-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-bold uppercase tracking-wider text-zinc-400">Prop Eval · {RAPID_EOD_50K.name}</h2>
        <span className="font-mono text-[10px] text-zinc-600">MNQ · $2/pt</span>
      </div>

      <div className="mb-2 flex items-center gap-2 font-mono text-[11px]">
        <span className="text-zinc-500">contracts</span>
        <input
          type="range"
          min={1}
          max={RAPID_EOD_50K.maxMicro}
          value={contracts}
          onChange={(ev) => setContracts(Number(ev.target.value))}
          className="flex-1 accent-emerald-500"
        />
        <span className="w-10 text-right font-bold text-zinc-100">{contracts}</span>
      </div>

      <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
        <div className="rounded border border-zinc-800 p-2">
          <div className="text-zinc-500">risk / trade</div>
          <div className="text-sm font-bold text-zinc-100">${f(riskPerTrade)}</div>
        </div>
        <div className="rounded border border-zinc-800 p-2">
          <div className="text-zinc-500">expected / day</div>
          <div className="text-sm font-bold text-long">+${f(e.dailyProfit)}</div>
        </div>
        <div className="rounded border border-zinc-800 p-2">
          <div className="text-zinc-500">income / week (90%)</div>
          <div className="text-sm font-bold text-long">${f(e.weeklyIncome)}</div>
        </div>
        <div className="rounded border border-zinc-800 p-2">
          <div className="text-zinc-500">to $3,000 target</div>
          <div className="text-sm font-bold text-info">≈ {f(e.daysToPass)} days</div>
        </div>
      </div>

      <div className="mt-2 space-y-1 font-mono text-[9px] text-zinc-500">
        <div>max 30 micro = ${f(maxR)}/trade risk at median 1R</div>
        <div>Monte Carlo (real 2.5y seq): median ~16d @30 · ~24d @20 · ~41d @12 · ~1.5% blow-up at 30</div>
        <div>30% consistency + 4-day min force spreading — no 1-day flips.</div>
      </div>
    </section>
  );
}
