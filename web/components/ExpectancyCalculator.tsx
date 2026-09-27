"use client";

import { useState } from "react";

function fmt(n: number, digits = 2) {
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export default function ExpectancyCalculator() {
  const [winRate, setWinRate] = useState(50); // %
  const [avgWin, setAvgWin] = useState(1.0); // R
  const [avgLoss, setAvgLoss] = useState(1.0); // R

  const W = winRate / 100;
  const expectancy = W * avgWin - (1 - W) * avgLoss;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : 0;
  const breakeven = payoff > 0 ? 1 / (1 + payoff) : 0;
  const kelly = payoff > 0 ? W - (1 - W) / payoff : 0;

  const payoffRows = [0.5, 1, 1.5, 2, 3];

  const inputCls =
    "w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-zinc-100 outline-none focus:border-long";

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="mb-4 font-semibold text-zinc-100">Your numbers</h3>
        <div className="space-y-4">
          <label className="block">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wider text-zinc-500">
              Win rate (%)
            </span>
            <input
              type="number"
              min={0}
              max={100}
              value={winRate}
              onChange={(e) =>
                setWinRate(Math.max(0, Math.min(100, Number(e.target.value))))
              }
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wider text-zinc-500">
              Average win (R)
            </span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={avgWin}
              onChange={(e) => setAvgWin(Math.max(0.1, Number(e.target.value)))}
              className={inputCls}
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wider text-zinc-500">
              Average loss (R)
            </span>
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={avgLoss}
              onChange={(e) =>
                setAvgLoss(Math.max(0.1, Number(e.target.value)))
              }
              className={inputCls}
            />
          </label>
        </div>

        <div className="mt-5 space-y-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="flex items-center justify-between font-mono text-sm">
            <span className="text-zinc-500">Expectancy / trade</span>
            <span
              className={`text-base font-semibold ${
                expectancy > 0 ? "text-long" : "text-short"
              }`}
            >
              {fmt(expectancy)}R
            </span>
          </p>
          <p className="flex items-center justify-between font-mono text-sm">
            <span className="text-zinc-500">Payoff ratio</span>
            <span className="text-zinc-200">{fmt(payoff)} : 1</span>
          </p>
          <p className="flex items-center justify-between font-mono text-sm">
            <span className="text-zinc-500">Break-even win rate</span>
            <span className="text-zinc-200">{fmt(breakeven * 100, 1)}%</span>
          </p>
          <p className="flex items-center justify-between font-mono text-sm">
            <span className="text-zinc-500">Full Kelly</span>
            <span className={kelly > 0 ? "text-long" : "text-zinc-200"}>
              {fmt(kelly * 100, 1)}%
            </span>
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-5">
        <h3 className="mb-1 font-semibold text-zinc-100">
          Break-even win rate by payoff
        </h3>
        <p className="mb-4 text-sm text-zinc-500">
          W₀ = 1/(1+R) — the win rate you need just to break even at each
          reward:risk.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-zinc-800 font-mono text-xs uppercase tracking-wider text-zinc-500">
                <th className="py-2 pr-4">Payoff (R)</th>
                <th className="py-2 pr-4">Break-even win rate</th>
                <th className="py-2">Scalp reality check</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {payoffRows.map((r) => {
                const w0 = 1 / (1 + r);
                const note =
                  r === 0.5
                    ? "Easier to hit — but 1 small loss erases 2 wins"
                    : r === 1
                      ? "The coin-flip baseline: need >50%"
                      : r === 2
                        ? "Scalp-style: needs >66.7% — unconfirmed reversals don't get there"
                        : r === 3
                          ? "Trend-style: 25% wins is enough"
                          : "In between";
                return (
                  <tr key={r} className="border-b border-zinc-800/60 last:border-0">
                    <td className="py-2 pr-4 text-zinc-200">{r} : 1</td>
                    <td className="py-2 pr-4 text-warn">{fmt(w0 * 100, 1)}%</td>
                    <td className="py-2 font-sans text-xs text-zinc-500">{note}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-4 border-t border-zinc-800 pt-3 text-xs text-zinc-500">
          Reversal scalps measured in the wild win 45–65% — so at 2:1 they are
          structurally underwater unless the setup is genuinely high-confluence.
          That is why confirmation stacking matters more than pattern names.
        </p>
      </div>
    </div>
  );
}
