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
  /** false = a hydration attempt hit an unreachable DB (definite); the
   *  status bar only halts on a definite failure, never on "not tried" */
  dayBaselineOk?: boolean;
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
  // fail-closed day baseline: hydration DEFINITELY failed (not merely
  // untried) and the account has realized P&L — the gate refuses to
  // re-baseline mid-day
  if (p.dayBaselineOk === false && !p.dayKey && snap.realized !== 0) {
    halts.push("baseline: day reference unrestorable (guard_state) with realized ≠ 0 — fail-closed halt");
  }

  if (halts.length > 0) {
    return { state: "halted", label: "HALTED", reason: halts.join(" · "), halts };
  }
  return { state: "live", label: "TRADING", reason: "all gates clear", halts: [] };
}

/* ------------------------------------------------------------------ *
 * Rules board — the operator-facing list of EVERY live rule that can
 * stop or restrict trading during a day, with its threshold, the live
 * metric it watches, and its current state. PURE — the /api/gc health
 * route assembles the inputs (guard state, account snapshot, feed
 * extras) and the /rules page renders it. Display-only: nothing here
 * gates an order (the REAL gate is crossGuardGate before every order).
 * ------------------------------------------------------------------ */

export type RuleRow = {
  id: string;
  group: "account" | "session" | "card";
  name: string;
  description: string;
  scope: string;
  /** human threshold (e.g. "−$250", "3 cards/day", "always") */
  threshold: string;
  /** live metric value (e.g. "+$120", "2 / 3 cards") */
  current: string;
  /** ok = watching · warn = armed/close · tripped = blocking right now ·
   *  off = disabled for this stage/config */
  state: "ok" | "warn" | "tripped" | "off";
};

export type RulesExtras = {
  windowOpen: boolean;
  windowLabel: string;
  newsNow: string | null;
  newsNote: string;
  tapeTail: number;
  tapeHolding: boolean;
  healStep: number;
  healEpisodes: number;
  rthCap: { count: number; cap: number };
  counterGate: { enabled: boolean; min: number; pts: number; recentWinners: number };
};

const usd = (n: number) => `${n >= 0 ? "+" : "−"}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

export function deriveRulesView(
  p: ExecProtections | null,
  snap: ExecSnapshot | null,
  opts: { executeLive: boolean; crosstradeConfigured: boolean; guardMargin: number },
  extras: RulesExtras,
): RuleRow[] {
  if (!p || !snap) {
    return [
      {
        id: "no-data",
        group: "account",
        name: "No-data halt",
        description: "the account snapshot is unreadable — the gate fails closed and no order can be placed",
        scope: "always",
        threshold: "readable snapshot",
        current: "unreadable",
        state: "tripped",
      },
    ];
  }

  const targetPx = p.stage === "funded" ? p.profitTarget : p.startBalance + p.profitTarget;
  const equity = snap.equity;
  const rows: RuleRow[] = [];

  rows.push({
    id: "target",
    group: "account",
    name: "Profit target",
    description: "equity at the target = the challenge is passed — stop trading",
    scope: p.stage,
    threshold: usd(targetPx),
    current: usd(equity),
    state: equity >= targetPx ? "tripped" : equity >= targetPx - 500 ? "warn" : "ok",
  });

  rows.push({
    id: "floor",
    group: "account",
    name: "Floor halt",
    description: `never open a trade that risks crossing the trailing floor (${p.locked ? "locked" : "trails up at the close"})`,
    scope: p.stage,
    threshold: usd(p.floor + opts.guardMargin),
    current: usd(equity),
    state: equity <= p.floor + opts.guardMargin ? "tripped" : equity <= p.floor + opts.guardMargin + 500 ? "warn" : "ok",
  });

  rows.push({
    id: "consistency",
    group: "account",
    name: "Consistency cap",
    description: "one day's realized profit must stay under 30% of the target or the eval fails",
    scope: "eval only",
    threshold: usd(p.consistencyCap),
    current: usd(p.dayPnl),
    state: p.stage !== "eval" ? "off" : p.dayPnl >= p.consistencyCap ? "tripped" : p.dayPnl >= p.consistencyCap - 200 ? "warn" : "ok",
  });

  rows.push({
    id: "daily-floor",
    group: "account",
    name: "Daily loss floor",
    description: "the day-plan stop — a red day must not bleed past this",
    scope: p.stage,
    threshold: p.dailyFloor > 0 ? `−$${p.dailyFloor}` : "off",
    current: usd(p.dayPnl),
    state: p.dailyFloor <= 0 ? "off" : p.dayPnl <= -p.dailyFloor ? "tripped" : p.dayPnl <= -p.dailyFloor * 0.7 ? "warn" : "ok",
  });

  rows.push({
    id: "profit-arm",
    group: "account",
    name: "Profit arm",
    description: "once the day crosses the arm, one trade at a time — the first losing close ends the day",
    scope: p.stage,
    threshold: p.profitArm > 0 ? usd(p.profitArm) : "off",
    current: p.profitArmed ? `armed · peak-since-arm ${usd(p.lastDayPnl ?? 0)}` : "not armed",
    state: p.profitArm <= 0 ? "off" : p.profitArmed && p.lastDayPnl !== null && p.dayPnl < p.lastDayPnl ? "tripped" : p.profitArmed ? "warn" : "ok",
  });

  rows.push({
    id: "giveback",
    group: "account",
    name: "Give-back protection",
    description: "stop the day once it gives back more than max($250, 50% of the peak) from its peak",
    scope: p.stage,
    threshold: `peak ${usd(p.dayPeak)} · limit ${usd(p.giveback.haltAt)}`,
    current: usd(p.dayPnl),
    state:
      !p.giveback.armed || p.dayPeak <= p.giveback.floor
        ? "ok"
        : p.dayPnl <= p.giveback.haltAt
          ? "tripped"
          : p.dayPnl <= p.giveback.haltAt + 100
            ? "warn"
            : "ok",
  });

  rows.push({
    id: "dd-halving",
    group: "account",
    name: "Drawdown halving",
    description: "challenge drawdown ≥ $600 from the high-water halves the size; restored at ≤ $300",
    scope: p.stage,
    threshold: `${usd(p.ddHi)} → ${usd(p.ddLo)}`,
    current: `${usd(p.highWater - equity)} from high-water`,
    state: p.ddHi <= 0 ? "off" : p.ddHalved ? "warn" : "ok",
  });

  rows.push({
    id: "baseline",
    group: "account",
    name: "Day baseline (fail-closed)",
    description: "a mid-day restart with no DB and no state file refuses to re-baseline the consistency day",
    scope: "always",
    threshold: "restorable day reference",
    current: p.dayBaselineOk === false && !p.dayKey && snap.realized !== 0 ? "unrestorable" : "ok",
    state: p.dayBaselineOk === false && !p.dayKey && snap.realized !== 0 ? "tripped" : "ok",
  });

  rows.push({
    id: "window",
    group: "session",
    name: "Trading window",
    description: "entries only Sunday 18:00 ET → Friday 16:00 ET; Mon–Thu daily 16:00–18:00 halt",
    scope: "always",
    threshold: extras.windowLabel,
    current: extras.windowOpen ? "open" : "closed — no orders",
    state: extras.windowOpen ? "ok" : "tripped",
  });

  rows.push({
    id: "news",
    group: "session",
    name: "News blackout",
    description: "no card, no order around FOMC (10m/20m) and NFP/CPI/PPI (5m/10m)",
    scope: extras.newsNote,
    threshold: "release ± minutes",
    current: extras.newsNow ?? "clear",
    state: extras.newsNow ? "tripped" : "ok",
  });

  rows.push({
    id: "tape-gate",
    group: "session",
    name: "Tape gate",
    description: "cards hold while the last completed bar is not candle-confirmed (the self-heal ladder + pager sit on top)",
    scope: "all cards",
    threshold: "tail ≥ 8 pages",
    current: extras.tapeHolding ? `holding · tail ${extras.tapeTail} · heal step ${extras.healStep} (${extras.healEpisodes} episodes)` : "bars confirmed",
    state: extras.tapeHolding ? (extras.tapeTail >= 8 ? "warn" : "ok") : "ok",
  });

  rows.push({
    id: "rth-cap",
    group: "card",
    name: "RTH daily cap",
    description: "max RTH cards per session day — later setups are skipped and journaled",
    scope: "rth family",
    threshold: extras.rthCap.cap > 0 ? `${extras.rthCap.cap} cards/day` : "off",
    current: extras.rthCap.cap > 0 ? `${extras.rthCap.count} / ${extras.rthCap.cap} used` : "unlimited",
    state: extras.rthCap.cap > 0 && extras.rthCap.count >= extras.rthCap.cap ? "warn" : "ok",
  });

  rows.push({
    id: "counter-gate",
    group: "card",
    name: "RTH counter-gate",
    description: "skip an RTH card within PTS points of an opposite-side RTH winner's exit in the last MIN minutes (owner-approved, full-archive validated)",
    scope: "rth family",
    threshold: extras.counterGate.enabled ? `${extras.counterGate.min} min · ${extras.counterGate.pts} pts` : "off",
    current: `${extras.counterGate.recentWinners} recent winner exit(s)`,
    state: !extras.counterGate.enabled ? "off" : extras.counterGate.recentWinners > 0 ? "warn" : "ok",
  });

  rows.push({
    id: "flat",
    group: "card",
    name: "Flat requirement",
    description: "an entry is refused unless the MNQ book is flat — no stacking on a recent entry or open position",
    scope: "all orders",
    threshold: "flat book",
    current: "checked before every order",
    state: "ok",
  });

  return rows;
}
