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

/** the live rules board, filtered to the given groups. Polls
 *  /api/gc?action=health → execution.rules every 15s. The real gate is
 *  crossGuardGate() before every order — this board is the display. */
export function RuleBoard({ groups, title }: { groups: RuleRow["group"][]; title: string }) {
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [now, setNow] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = () => {
    fetch("/api/gc?action=health")
      .then((r) => r.json())
      .then((j) => {
        setRules((j.execution?.rules as RuleRow[] | undefined) ?? null);
        setNow(j.now ?? "");
      })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, 15_000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <section className="mb-8">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-mono text-sm font-semibold uppercase tracking-widest text-zinc-100">{title}</h2>
        <span className="font-mono text-[10px] text-zinc-500">
          {now ? `snapshot ${new Date(now).toLocaleString("en-US", { timeZone: "America/New_York" })} ET` : "…"}
        </span>
      </div>

      {rules === null && (
        <p className="font-mono text-xs text-yellow-400">
          rules unavailable (guard state or account snapshot unreadable) — the gate itself fails closed in that case.
        </p>
      )}

      {rules &&
        groups.map((g) => {
          const rows = rules.filter((r) => r.group === g);
          if (!rows.length) return null;
          return (
            <div key={g} className="mb-5">
              <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-zinc-500">{GROUP_LABEL[g]}</h3>
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
            </div>
          );
        })}
    </section>
  );
}
