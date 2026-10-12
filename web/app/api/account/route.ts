/* ------------------------------------------------------------------ *
 * /api/account — THE account endpoint. One payload for every tab:
 *
 *   account   the linked CrossTrade account from the shared snapshot
 *             cache (netLiq, realized, open P&L, week P&L, account id)
 *   guard     the live guard day reference (day P&L/peak/floor — the
 *             same numbers the executor's gate uses)
 *   position  the current MNQ position (flat when null)
 *   today     today's executed-signal ledger rows (lib/execTracker.ts)
 *
 * Every number here comes from the shared read layer (lib/ctAccount.ts)
 * or the guard itself — the same source the status bar, the gate and
 * the executions panel use, so tabs can never disagree again.
 *
 * Read-only, display-only. No secrets leave the server.
 * ------------------------------------------------------------------ */

import { ctSnapshot, ctPositions, configuredAccount, accountRow } from "@/lib/ctAccount";
import { guardState } from "@/lib/accountGuard";
import { getExecTrades } from "@/lib/execTracker";
import { getManualActions } from "@/lib/manualDetect";
import { stageForAccountName } from "@/lib/risk/challengeRules";

export const dynamic = "force-dynamic";

export async function GET() {
  // cached-or-fresh shared snapshot — the same 30s window the gate and
  // status bar use (a cold first hit warms it instead of showing nothing)
  const snap = await ctSnapshot();
  const acct = accountRow(snap, configuredAccount());
  const s = guardState();

  let position: { dir: "long" | "short"; qty: number; rows: Array<Record<string, unknown>> } | null = null;
  try {
    const rows = (await ctPositions()) ?? [];
    const mnq = rows.filter((p) => {
      const qty = Number(p.netPos ?? p.qty ?? 0);
      const ins = String(p.instrument ?? p.contractName ?? "");
      return qty !== 0 && ins.toUpperCase().includes("MNQ");
    });
    const qty = mnq.reduce((sum, p) => sum + Number(p.netPos ?? p.qty ?? 0), 0);
    if (qty !== 0) position = { dir: qty > 0 ? "long" : "short", qty, rows: mnq };
  } catch {
    position = null;
  }

  const trades = await getExecTrades(50);
  const todayNy = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const [y, m, d] = todayNy.split("/");
  const today = `${y}-${m}-${d}`;
  const todayRows = trades.filter((t) => t.day === today);
  const todayNet = Math.round(todayRows.reduce((sum, t) => sum + t.netUsd, 0) * 100) / 100;

  // manual-action summary for the shared account strip (detector in
  // lib/manualDetect.ts — entries/exits/flattens/orders the bot didn't make)
  const manual = await getManualActions(100);
  const manualToday = manual.filter((m) => m.day === today);
  const manualNet = Math.round(
    manualToday.filter((m) => m.closed).reduce((s, m) => s + (m.pnlUsd ?? 0), 0) * 100,
  ) / 100;

  return Response.json({
    ok: true,
    now: new Date().toISOString(),
    account: acct
      ? {
          name: acct.name ?? null,
          accountId: acct.accountId ?? null,
          environment: acct.environment ?? null,
          broker: acct.broker ?? null,
          netLiq: Number.isFinite(acct.netLiq) ? Number(acct.netLiq) : null,
          openPnl: Number.isFinite(acct.openPnl) ? Number(acct.openPnl) : null,
          realizedPnl: Number.isFinite(acct.realizedPnl) ? Number(acct.realizedPnl) : null,
          weekRealizedPnl: Number.isFinite(acct.weekRealizedPnl) ? Number(acct.weekRealizedPnl) : null,
          stage: stageForAccountName(acct.name ?? ""),
          at: snap?.at ?? null,
        }
      : null,
    guard: {
      stage: s.stage,
      account: s.account,
      startBalance: s.startBalance,
      floor: s.floor,
      highWater: s.highWater,
      locked: s.locked,
      dayKey: s.dayKey,
      dayPnl: Math.round(s.dayPnl),
      dayPeak: Math.round(s.dayPeak),
      dayStartRealized: s.dayStartRealized,
      profitArmed: s.profitArmed,
      lastDayPnl: s.lastDayPnl === null ? null : Math.round(s.lastDayPnl),
    },
    position,
    trades: trades.slice(0, 50),
    today: { rows: todayRows, netUsd: todayNet },
    manual: { count: manualToday.length, netUsd: manualNet, rows: manualToday.slice(0, 50) },
  });
}
