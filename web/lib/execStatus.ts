/* ------------------------------------------------------------------ *
 * Live exec status derivation — PURE, display-only.
 *
 * Turns the guard snapshot + account snapshot into the status line the
 * dashboard's ExecStatusBar shows. Never gates, sizes, or places
 * anything: the REAL gate is crossGuardGate() before every order — this
 * module only mirrors its inputs for the operator.
 * ------------------------------------------------------------------ */

export type ExecProtections = {
  stage: "eval" | "funded";
  startBalance: number;
  profitTarget: number;
  floor: number;
  highWater: number;
  locked: boolean;
  dayKey: string;
  dayPnl: number;
  dayPeak: number;
  consistencyCap: number;
  dailyFloor: number;
  profitArm: number;
  profitArmed: boolean;
  lastDayPnl: number | null;
  ddHi: number;
  ddLo: number;
  ddHalved: boolean;
  giveback: { armed: boolean; pct: number; floor: number; haltAt: number };
};

export type ExecSnapshot = { equity: number; realized: number };

export type ExecStatus = {
  /** live = orders may be placed · dry = executor off/not configured ·
   *  halted = a guard blocks new entries · watch = degraded but trading */
  state: "live" | "dry" | "halted" | "watch";
  label: string;
  /** one-line reason (or "trading" when nothing is wrong) */
  reason: string;
  /** the active halt reasons (empty = none) */
  halts: string[];
};

export function deriveExecStatus(
  p: ExecProtections | null,
  snap: ExecSnapshot | null,
  opts: { executeLive: boolean; crosstradeConfigured: boolean; guardMargin: number },
): ExecStatus {
  if (!opts.executeLive) return { state: "dry", label: "DRY-RUN", reason: "executor live switch off", halts: [] };
  if (!opts.crosstradeConfigured) return { state: "dry", label: "OFFLINE", reason: "CrossTrade not configured", halts: [] };
  if (p === null) return { state: "watch", label: "WATCH", reason: "guard state unavailable", halts: [] };
  if (snap === null) return { state: "halted", label: "HALTED", reason: "account snapshot unreadable — gate fails closed", halts: ["no-data"] };

  const halts: string[] = [];
  const targetPx = p.stage === "funded" ? p.profitTarget : p.startBalance + p.profitTarget;

  // EOD floor: never let a new trade risk crossing it
  if (snap.equity <= p.floor + opts.guardMargin) {
    halts.push(`floor: equity $${snap.equity.toFixed(0)} within $${opts.guardMargin} of floor $${p.floor.toFixed(0)}${p.locked ? " (locked)" : ""}`);
  }
  // profit target reached = pass
  if (snap.equity >= targetPx) {
    halts.push(`target: equity $${snap.equity.toFixed(0)} ≥ $${targetPx.toFixed(0)} — eval passed, stop`);
  }
  // eval consistency cap ($900/day)
  if (p.stage === "eval" && p.dayPnl >= p.consistencyCap) {
    halts.push(`consistency: day +$${p.dayPnl.toFixed(0)} ≥ cap $${p.consistencyCap}`);
  }
  // day-plan daily loss floor (default −$250)
  if (p.dailyFloor > 0 && p.dayPnl <= -p.dailyFloor) {
    halts.push(`daily floor: day −$${Math.abs(p.dayPnl).toFixed(0)} ≤ −$${p.dailyFloor.toFixed(0)}`);
  }
  // day-plan profit arm: first loss after arming at +$400 ends the day
  if (p.profitArm > 0 && p.profitArmed && p.lastDayPnl !== null && p.dayPnl < p.lastDayPnl) {
    halts.push(`profit arm: first loss after +$${p.profitArm.toFixed(0)} (peak since arm $${p.lastDayPnl.toFixed(0)})`);
  }
  // give-back protection (green-day smoothing, pre-arm safety net)
  if (p.giveback.armed && p.dayPeak > p.giveback.floor) {
    const limit = Math.max(p.giveback.floor, p.giveback.pct * p.dayPeak);
    if (p.dayPnl <= p.dayPeak - limit) {
      halts.push(`give-back: day $${p.dayPnl.toFixed(0)} gave back ≥ $${limit.toFixed(0)} from peak $${p.dayPeak.toFixed(0)}`);
    }
  }

  if (halts.length > 0) {
    return { state: "halted", label: "HALTED", reason: halts.join(" · "), halts };
  }
  return { state: "live", label: "TRADING", reason: "all gates clear", halts: [] };
}
