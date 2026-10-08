"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/* ------------------------------------------------------------------ *
 * TradingToggle — the owner's manual kill switch in the status strip.
 *
 * STOP trading: always allowed, instant, no password (a kill switch
 * must never ask permission). RESUME trading opens a confirm dialog;
 * it asks for the admin password ONLY when the server has one
 * configured (GET /api/trading reports resumePasswordRequired, so the
 * UI adapts instead of guessing). Every flip is audited in the
 * daybook. Keyboard: Esc closes, Enter submits.
 * ------------------------------------------------------------------ */

type ApiState = { ok?: boolean; halted?: boolean; resumePasswordRequired?: boolean; reason?: string };

export default function TradingToggle() {
  const [halted, setHalted] = useState<boolean | null>(null);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [flash, setFlash] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/trading", { cache: "no-store" });
      const j = (await r.json()) as ApiState;
      if (j.ok) {
        setHalted(!!j.halted);
        setPasswordRequired(!!j.resumePasswordRequired);
      }
    } catch {
      /* keep the last known state */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (dialogOpen) setTimeout(() => inputRef.current?.focus(), 30);
  }, [dialogOpen]);

  const showFlash = (msg: string) => {
    setFlash(msg);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlash(""), 5000);
  };

  const close = () => {
    if (busy) return;
    setDialogOpen(false);
    setPassword("");
    setError("");
  };

  const flip = async (halt: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ halt, password }),
      });
      const j = (await r.json()) as ApiState;
      if (!j.ok) {
        setError(j.reason ?? "request failed");
        return;
      }
      setHalted(!!j.halted);
      setPassword("");
      setDialogOpen(false);
      showFlash(halt ? "Trading halted — recorded in the journal." : "Trading resumed — recorded in the journal.");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    if (dialogOpen) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen, busy]);

  if (halted === null) return null;

  const submitResume = () => {
    if (!passwordRequired || password.length > 0) void flip(false);
  };

  return (
    <span className="flex items-center gap-1.5">
      {halted ? (
        <span className="flex items-center gap-1.5 rounded border border-short/50 bg-short/10 px-2 py-0.5 font-mono text-[10px] font-bold text-short">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-short" />
          TRADING HALTED
        </span>
      ) : (
        <span className="flex items-center gap-1.5 rounded border border-long/40 bg-long/10 px-2 py-0.5 font-mono text-[10px] font-bold text-long">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-long" />
          TRADING LIVE
        </span>
      )}
      <button
        onClick={() => (halted ? setDialogOpen(true) : void flip(true))}
        disabled={busy}
        className={
          halted
            ? "rounded border border-long/50 bg-long/10 px-2 py-0.5 font-mono text-[10px] font-bold text-long hover:bg-long/20 disabled:opacity-50"
            : "rounded border border-short/50 bg-short/10 px-2 py-0.5 font-mono text-[10px] font-bold text-short hover:bg-short/20 disabled:opacity-50"
        }
        title={halted ? "Resume live trading" : "Stop all trading immediately (audited in the journal)"}
      >
        {busy && !dialogOpen ? "…" : halted ? "RESUME" : "STOP"}
      </button>
      {flash && <span className="font-mono text-[9px] text-zinc-400">{flash}</span>}

      {dialogOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={close}
          role="presentation"
        >
          <div
            className="w-80 rounded-md border border-zinc-700 bg-panel p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Resume live trading"
          >
            <h2 className="font-mono text-[11px] font-bold uppercase tracking-wider text-zinc-200">
              Resume live trading
            </h2>
            <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-zinc-400">
              {passwordRequired
                ? "The executor will place orders again. Enter the admin password to confirm."
                : "No admin password is configured on the server — this re-arms the executor immediately."}
            </p>
            {passwordRequired && (
              <>
                <label className="mb-1 mt-3 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  admin password
                </label>
                <input
                  ref={inputRef}
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setError("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitResume();
                  }}
                  autoComplete="current-password"
                  className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-[11px] text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-zinc-500"
                  placeholder="ADMIN_PASSWORD"
                />
              </>
            )}
            {error && (
              <p role="alert" className="mt-2 rounded border border-short/40 bg-short/10 px-2 py-1 font-mono text-[10px] text-short">
                {error}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={close}
                disabled={busy}
                className="rounded border border-zinc-700 px-2.5 py-1 font-mono text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={submitResume}
                disabled={busy || (passwordRequired && password.length === 0)}
                className="rounded border border-long/50 bg-long/10 px-2.5 py-1 font-mono text-[10px] font-bold text-long hover:bg-long/20 disabled:opacity-40"
              >
                {busy ? "Resuming…" : "Resume trading"}
              </button>
            </div>
            <p className="mt-3 font-mono text-[9px] text-zinc-600">
              every flip is recorded in the daybook journal (audit trail)
            </p>
          </div>
        </div>
      )}
    </span>
  );
}
