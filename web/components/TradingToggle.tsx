"use client";

import { useCallback, useEffect, useState } from "react";

/* ------------------------------------------------------------------ *
 * TradingToggle — the owner's manual kill switch in the status strip.
 * STOP trading: always allowed, instant, no password (a kill switch
 * must never ask permission). RESUME trading: password-gated when
 * ADMIN_PASSWORD is configured on the server. Every flip is audited in
 * the daybook; this component polls the state every 20s.
 * ------------------------------------------------------------------ */

export default function TradingToggle() {
  const [halted, setHalted] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/trading", { cache: "no-store" });
      const j = (await r.json()) as { ok?: boolean; halted?: boolean };
      if (j.ok) setHalted(!!j.halted);
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const flip = async (halt: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ halt, password }),
      });
      const j = (await r.json()) as { ok?: boolean; halted?: boolean; reason?: string };
      if (!j.ok) {
        setError(j.reason ?? "failed");
      } else {
        setHalted(!!j.halted);
        setPassword("");
        setError("");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (halted === null) return null;

  if (halted) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="flex items-center gap-1.5 rounded border border-short/50 bg-short/10 px-2 py-0.5 font-mono text-[10px] font-bold text-short">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-short" />
          TRADING HALTED
        </span>
        <button
          onClick={() => void flip(false)}
          disabled={busy}
          className="rounded border border-long/50 bg-long/10 px-2 py-0.5 font-mono text-[10px] font-bold text-long hover:bg-long/20 disabled:opacity-50"
          title="Resume trading (password-gated when ADMIN_PASSWORD is set)"
        >
          {busy ? "…" : "RESUME"}
        </button>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="password"
          className="w-20 rounded border border-zinc-700 bg-panel px-1.5 py-0.5 font-mono text-[9px] text-zinc-300 placeholder:text-zinc-600"
          title="Required to RESUME only when ADMIN_PASSWORD is configured"
        />
        {error && <span className="font-mono text-[9px] text-short">{error}</span>}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <span className="flex items-center gap-1.5 rounded border border-long/40 bg-long/10 px-2 py-0.5 font-mono text-[10px] font-bold text-long">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-long" />
        TRADING LIVE
      </span>
      <button
        onClick={() => void flip(true)}
        disabled={busy}
        className="rounded border border-short/50 bg-short/10 px-2 py-0.5 font-mono text-[10px] font-bold text-short hover:bg-short/20 disabled:opacity-50"
        title="Stop all trading immediately (audited in the daybook)"
      >
        {busy ? "…" : "STOP"}
      </button>
      {error && <span className="font-mono text-[9px] text-short">{error}</span>}
    </span>
  );
}
