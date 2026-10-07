"use client";

import { useEffect, useRef, useState } from "react";

type RuleRow = {
  id: string;
  group: "account" | "session" | "card";
  name: string;
  description: string;
  scope: string;
  threshold: string;
  current: string;
  state: "ok" | "warn" | "tripped" | "off";
};

type RulesPayload = {
  rules: RuleRow[] | null;
  now: string;
};

const GROUP_LABEL: Record<string, string> = {
  account: "Account-level halts (checked before every order — fail closed)",
  session: "Session rules (windows, news, tape)",
  card: "Card-level vetoes (a card is skipped + journaled; trading continues)",
};

const STATE_DOT: Record<RuleRow["state"], string> = {
  ok: "bg-long",
  warn: "bg-yellow-400",
  tripped: "bg-red-500",
  off: "bg-zinc-600",
};

const STATE_LABEL: Record<RuleRow["state"], string> = {
  ok: "watching",
  warn: "armed / close",
  tripped: "BLOCKING",
  off: "disabled",
};

export default function RulesPage() {
  const [data, setData] = useState<RulesPayload | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    fetch("/api/gc?action=health")
      .then((r) => r.json())
      .then((j) => setData({ rules: j.execution?.rules ?? null, now: j.now ?? "" }))
      .catch(() => {});
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const rules = data?.rules ?? null;
  const groups: Array<"account" | "session" | "card"> = ["account", "session", "card"];

  return (
    <div className="mx-auto w-full max-w-[1800px] px-4 py-6">
      <div className="mb-4 flex items-baseline justify-between">
        <h1 className="font-mono text-xl font-semibold tracking-widest text-zinc-100">
          LIVE RULES — everything that can stop trading today
        </h1>
        <span className="font-mono text-xs text-zinc-500">
          {data?.now ? `snapshot ${new Date(data.now).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : "…"}
        </span>
      </div>
      <p className="mb-6 max-w-3xl text-sm text-zinc-400">
        The real gate is <code className="text-zinc-300">crossGuardGate()</code>, which runs before{" "}
        <b>every</b> order and fails closed — any <span className="text-red-400">BLOCKING</span> row here
        means no new entries right now. Card-level vetoes skip one card and journal it to the daybook.
        Full reference:{" "}
        <a href="/docs#rules" className="text-long underline decoration-zinc-700 underline-offset-2">
          docs → Trading rules
        </a>
        .
      </p>

      {rules === null && (
        <p className="font-mono text-sm text-yellow-400">
          rules unavailable (guard state or account snapshot unreadable) — the gate itself fails closed in
          that case.
        </p>
      )}

      {rules &&
        groups.map((g) => {
          const rows = rules.filter((r) => r.group === g);
          if (!rows.length) return null;
          return (
            <section key={g} className="mb-8">
              <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">
                {GROUP_LABEL[g]}
              </h2>
              <div className="overflow-x-auto rounded-lg border border-zinc-800">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-zinc-900/60 text-xs uppercase tracking-wider text-zinc-500">
                    <tr>
                      <th className="px-3 py-2">state</th>
                      <th className="px-3 py-2">rule</th>
                      <th className="px-3 py-2">what it does</th>
                      <th className="px-3 py-2">threshold</th>
                      <th className="px-3 py-2">live value</th>
                      <th className="px-3 py-2">scope</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} className="border-t border-zinc-800/70 align-top">
                        <td className="px-3 py-2 whitespace-nowrap">
                          <span className={`inline-block h-2 w-2 rounded-full ${STATE_DOT[r.state]}`} />{" "}
                          <span className={`font-mono text-xs ${r.state === "tripped" ? "text-red-400" : r.state === "warn" ? "text-yellow-400" : r.state === "off" ? "text-zinc-600" : "text-zinc-400"}`}>
                            {STATE_LABEL[r.state]}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-zinc-200 whitespace-nowrap">{r.name}</td>
                        <td className="px-3 py-2 text-zinc-400">{r.description}</td>
                        <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{r.threshold}</td>
                        <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{r.current}</td>
                        <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">{r.scope}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          );
        })}

      <section className="mb-8 max-w-3xl">
        <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-zinc-500">
          Notes — what is NOT a rule
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-zinc-400">
          <li>
            There is <b>no</b> “stop after N consecutive losses” rule. Loss streaks are capped by the daily
            loss floor (−$250 ≈ 2–3 losses at current sizing) and the firm’s $2,000 max loss.
          </li>
          <li>
            “Loss after a winning streak” IS covered — by the profit arm: once the day crosses +$400, the
            first losing close ends the day.
          </li>
          <li>
            Streak-aware sizing (×0.5 / ×0.75 per consecutive loss, reset on a win) was studied
            (sizingDynamicsStudy, apPlanSweep) but is not enabled live.
          </li>
          <li>
            The RTH counter-gate (MIN15 / PTS5) is owner-approved and validated on the full 651-session
            archive — see docs/research/rth-counter-gate-2026-10-07.md.
          </li>
        </ul>
      </section>
    </div>
  );
}
