"use client";

import { useCallback, useEffect, useState } from "react";

/* ------------------------------------------------------------------ *
 * AccountSettings — the password-gated execution switch on the
 * dashboard. Sits in the ExecStatusBar next to the masked account
 * name. One click → modal → linked account name / CrossTrade secret
 * key / webhook URL + password → applied INSTANTLY server-side
 * (runtime overrides on the data volume; no redeploy), guard reset
 * decided from the live snapshot (same Tradovate account under a new
 * label → protections kept), audited in the daybook.
 * ------------------------------------------------------------------ */

type SettingsState = {
  ok: boolean;
  passwordSet: boolean;
  account: string | null;
  key: string | null;
  url: string | null;
  override: { CROSSTRADE_ACCOUNT?: string | null; CROSSTRADE_KEY?: string | null; CROSSTRADE_URL?: string | null } | null;
};

export default function AccountSettings() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<SettingsState | null>(null);
  const [account, setAccount] = useState("");
  const [key, setKey] = useState("");
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [forceReset, setForceReset] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/exec-settings", { cache: "no-store" })
      .then((r) => r.json())
      .then((j: SettingsState) => setSt(j))
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fetch("/api/exec-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, account, key, url, resetGuard: forceReset }),
      });
      const j = (await r.json()) as { ok: boolean; account?: string; key?: string | null; url?: string | null; guard?: string; guardReason?: string; error?: string };
      if (r.ok && j.ok) {
        const parts = [
          j.account ? `account ${j.account}` : "",
          j.key ? `key ${j.key}` : "",
          j.url ? "webhook URL" : "",
        ].filter(Boolean);
        setDone(`${parts.join(" · ")} applied — guard ${j.guard === "reset" ? "reset" : "kept"}. ${j.guardReason ?? ""}`);
        setAccount("");
        setKey("");
        setUrl("");
        setPassword("");
        setForceReset(false);
        load();
      } else {
        setError(j.error ?? "failed");
      }
    } catch {
      setError("network error — nothing changed");
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    "w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-info/60";

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setDone(null);
          setError(null);
          load();
        }}
        className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 transition-colors hover:border-zinc-500 hover:text-zinc-200"
        title="change the CrossTrade account / key / webhook URL (password required)"
      >
        change…
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-zinc-950/80 p-4" onClick={() => !busy && setOpen(false)}>
          <div
            className="w-full max-w-md rounded-md border border-zinc-700 bg-panel p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-zinc-200">switch execution account</h3>
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-zinc-700 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400 hover:text-zinc-200"
              >
                ✕
              </button>
            </div>

            <p className="mb-3 font-mono text-[10px] leading-relaxed text-zinc-500">
              current: <span className="text-zinc-300">{st?.account ?? "…"}</span>
              {" · "}key <span className="text-zinc-300">{st?.key ?? "—"}</span>
              {" · "}webhook <span className="text-zinc-300">{st?.url ?? "—"}</span>
              {st?.override && (st.override.CROSSTRADE_ACCOUNT || st.override.CROSSTRADE_KEY || st.override.CROSSTRADE_URL) && (
                <span className="text-amber-400"> · runtime override active</span>
              )}
            </p>

            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              linked Tradovate account name <span className="normal-case text-zinc-600">(CROSSTRADE_ACCOUNT)</span>
            </label>
            <input
              value={account}
              onChange={(e) => setAccount(e.target.value)}
              placeholder="e.g. MFFUEVREOD706880007"
              autoComplete="off"
              spellCheck={false}
              className={inputCls}
            />

            <label className="mb-1 mt-3 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              CrossTrade secret key <span className="normal-case text-zinc-600">(CROSSTRADE_KEY — leave blank to keep)</span>
            </label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={st?.key ? `current ${st.key}` : "Secret Key from the CrossTrade My Account page"}
              autoComplete="off"
              spellCheck={false}
              className={inputCls}
            />

            <label className="mb-1 mt-3 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              personal webhook URL <span className="normal-case text-zinc-600">(CROSSTRADE_URL — leave blank to keep)</span>
            </label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={st?.url ?? "https://app.crosstrade.io/v1/send/<uid>/<channel>"}
              autoComplete="off"
              spellCheck={false}
              className={inputCls}
            />

            <label className="mb-1 mt-3 block font-mono text-[10px] uppercase tracking-wider text-zinc-500">admin password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={st?.passwordSet ? "ADMIN_PASSWORD" : "not configured on server"}
              autoComplete="current-password"
              className={inputCls}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
            />

            <label className="mt-3 flex items-start gap-2 font-mono text-[10px] leading-relaxed text-zinc-400">
              <input
                type="checkbox"
                checked={forceReset}
                onChange={(e) => setForceReset(e.target.checked)}
                className="mt-0.5 accent-long"
              />
              <span>force guard reset — skip the auto-detection (only for a known-new account the live data can&apos;t confirm)</span>
            </label>

            <p className="mt-3 rounded border border-info/30 bg-info/5 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-info">
              Only the fields you fill in change — blank means keep. The guard reset is decided from the live snapshot
              when the account name changes: same realized P&L under the new name → same Tradovate account →
              protections kept. A wrong key or URL fails closed (entries halt), never misfires.
            </p>

            <p className="mt-2 rounded border border-amber-400/30 bg-amber-400/5 px-2 py-1.5 font-mono text-[10px] leading-relaxed text-amber-400">
              Applies instantly (no redeploy). Only switch while flat / outside RTH — an open position on the old
              account is no longer watched.
            </p>

            {error && <p className="mt-2 font-mono text-[10px] text-short">✗ {error}</p>}
            {done && <p className="mt-2 font-mono text-[10px] text-long">✓ {done}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="rounded border border-zinc-700 px-2.5 py-1 font-mono text-xs text-zinc-400 hover:text-zinc-200"
              >
                cancel
              </button>
              <button
                onClick={() => void submit()}
                disabled={busy || (!account.trim() && !key.trim() && !url.trim()) || !password}
                className="rounded border border-long/50 bg-long/10 px-2.5 py-1 font-mono text-xs font-bold text-long transition-colors hover:bg-long/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {busy ? "applying…" : "apply"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
