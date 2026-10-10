/* ------------------------------------------------------------------ *
 * Pattern mining — winner/loser analysis over the full variable dump.
 *
 * Pure helpers for the winnerLoserPatterns CLI and the journal's
 * Pattern explorer (GET /api/patterns). Every recorded variable
 * (fire-time features flattened to dotted paths + post-hoc execution
 * anatomy) is bucketed into cells; each cell reports n, win rate, and
 * lift vs the baseline; each VARIABLE reports a statistical direction:
 *
 *   · numeric     — top quantile vs bottom quantile win rate:
 *                   direction "up" = higher values win more,
 *                   "down" = lower values win more, else "flat";
 *   · categorical — best vs worst cell: direction "split",
 *                   label says which value it prefers;
 *   · presence    — present vs absent (blob variables like dom.*).
 *
 * effectPp = the lift spread between the two extreme cells
 * (percentage points). strength is a heuristic grade over effect and
 * sample size (strong ≥ 10pp with n ≥ 15 both sides · mild ≥ 5pp ·
 * else weak) — a reading aid, NOT a significance test.
 *
 * perFamily repeats the same split inside each strategy family, so a
 * pattern can be read as "in which strategy" (families carry different
 * baseline win rates — family lift is vs the FAMILY baseline).
 *
 * The point is pattern SURFACE, not inference: tiny cells never rank,
 * and post-hoc anatomy is labeled as such because its patterns are
 * correlated with the result by construction (MFE ≥ target ⇒ win).
 * Pure + unit-tested.
 * ------------------------------------------------------------------ */

import { flattenFeatures } from "./tradeLedger";
import { familyOf, hourBucketOf } from "./tradeStats";
import { fisherExact, mannWhitneyP, cmhP, bhFdr } from "./patternStats";

export type CellStats = {
  /** cell label: quantile range, category value, or present/absent */
  label: string;
  n: number;
  wins: number;
  /** wins ÷ n (0..1) */
  wr: number;
  /** (wr − baselineWr) × 100, percentage points */
  liftPp: number;
  /** mean numeric value inside the cell (numeric variables only) */
  meanValue: number | null;
};

export type FamilyCell = {
  family: string;
  n: number;
  wins: number;
  wr: number;
  /** (wr − the FAMILY's baseline wr) × 100 */
  liftPp: number;
};

export type VarPattern = {
  /** variable name: dotted feature path or anatomy column */
  key: string;
  /** fire-time = known at signal time · post-hoc = execution anatomy */
  kind: "fire-time" | "post-hoc";
  type: "numeric" | "categorical" | "presence";
  baselineWr: number;
  /** rows where the variable is present (numeric/categorical) */
  n: number;
  cells: CellStats[];
  /** "up" | "down" | "flat" | "split" — the statistical direction */
  direction: "up" | "down" | "flat" | "split";
  /** one-line reading: "higher → more wins" / "prefers buy over none" */
  directionLabel: string;
  /** lift spread between the direction's two extreme cells (pp) */
  effectPp: number;
  /** heuristic grade over effect + sample: strong | mild | weak */
  strength: "strong" | "mild" | "weak";
  /** the same split inside each strategy family */
  perFamily: FamilyCell[];
  /** raw p-value of the type-appropriate test (see patternStats.ts):
   *  Mann-Whitney (numeric) · Fisher extreme 2×2 (categorical) ·
   *  CMH stratified by family (presence) */
  pValue: number | null;
  /** Benjamini-Hochberg FDR q-value across all variables in the run */
  qValue: number | null;
  /** does the direction hold in BOTH time halves (early vs late)?
   *  true = same direction ≥ 2pp each half · false = flipped/flat ·
   *  "insufficient" = a half lacked enough rows to judge */
  stable: boolean | "insufficient" | null;
  /** significant (FDR q < 0.10) · stable · exploratory */
  verdict: "significant" | "stable" | "exploratory";
};

export type WinLossRow = {
  result: "win" | "loss";
  /** flattened fire-time features (dotted paths) */
  flat: Record<string, unknown>;
  /** post-hoc execution anatomy (family is expected here) */
  anatomy: Record<string, unknown>;
};

export const BLOB_CHARS = 60;
/** integer variables with ≤ this many distinct values bin per value
 *  (contracts 1–30, hourET, domClusters) — quantiles are for
 *  continuous or wide integer domains */
export const DISTINCT_VALUE_BINS = 30;

const isBlob = (v: unknown): boolean => {
  if (typeof v === "string") {
    // flattenFeatures stringifies arrays/objects into JSON strings —
    // "[]" is an empty DOM candidate list, not a category value
    if (v.length > BLOB_CHARS || v.startsWith("[") || v.startsWith("{")) return true;
    return false;
  }
  return Array.isArray(v) || (typeof v === "object" && v !== null);
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

export function variableType(values: Array<unknown>): VarPattern["type"] {
  const present = values.filter((v) => v !== null && v !== undefined);
  if (present.length === 0) return "categorical";
  // any blob cell (JSON array/object/long string) makes the variable a
  // presence flag — a blob can't be bucketed by value
  if (present.some(isBlob)) return "presence";
  const numeric = present.filter((v) => num(v) !== null).length;
  if (numeric >= present.length * 0.6) return "numeric";
  return "categorical";
}

/** equal-count quantile thresholds over the numeric values (deduped;
 *  `bins` labels = thresholds.length + 1 buckets). */
export function quantileThresholds(values: number[], bins = 4): number[] {
  const f = [...values].sort((a, b) => a - b);
  if (f.length === 0) return [];
  const out: number[] = [];
  for (let q = 1; q < bins; q++) {
    const idx = Math.min(f.length - 1, Math.floor((q * f.length) / bins));
    const v = f[idx];
    if (out.length === 0 || v > out[out.length - 1]) out.push(v);
  }
  return out;
}

/** bin label for a numeric value under the thresholds */
export function binLabelOf(v: number, thresholds: number[]): string {
  if (thresholds.length === 0) return "all";
  if (v < thresholds[0]) return `(−∞, ${thresholds[0].toFixed(2)})`;
  for (let i = 0; i < thresholds.length - 1; i++) {
    if (v >= thresholds[i] && v < thresholds[i + 1]) {
      return `[${thresholds[i].toFixed(2)}, ${thresholds[i + 1].toFixed(2)})`;
    }
  }
  return `[${thresholds[thresholds.length - 1].toFixed(2)}, +∞)`;
}

const catLabel = (v: unknown): string => {
  if (v === null || v === undefined) return "absent";
  if (typeof v === "boolean") return v ? "yes" : "no";
  const s = String(v);
  return s === "" ? "(empty)" : s;
};

type FamilyCtx = {
  /** family per row (same length as values/results) */
  families: Array<string | null>;
  /** family → baseline win rate (only families present in the rows) */
  baselines: Map<string, number>;
  minN: number;
};

/** the full pattern for one variable */
export function patternFor(
  key: string,
  kind: VarPattern["kind"],
  values: Array<unknown | undefined>, // undefined = variable absent on that row
  results: Array<"win" | "loss">,
  baselineWr: number,
  minN = 5,
  famCtx: FamilyCtx | null = null,
): VarPattern | null {
  const presentCount = values.filter((v) => v !== undefined).length;
  // flag-style booleans (aPlus, firstToday, entryAtRound, …) are recorded
  // only when true — an absent cell means "no", not "another family"
  const flagVals = values.filter((v) => v !== undefined);
  const flagsOnly = flagVals.length > 0 && flagVals.every((v) => typeof v === "boolean");
  if ((flagsOnly ? values.length : presentCount) < minN) return null;
  const type = variableType(values);

  const mkCell = (rows: Array<{ v: unknown | undefined; r: "win" | "loss" }>, label: string, meanValue: number | null): CellStats => {
    const wins = rows.filter((x) => x.r === "win").length;
    const nn = rows.length;
    return {
      label,
      n: nn,
      wins,
      wr: nn > 0 ? wins / nn : 0,
      liftPp: nn > 0 ? (wins / nn - baselineWr) * 100 : 0,
      meanValue,
    };
  };

  const rows = values.map((v, i) => ({ v, r: results[i] }));
  if (flagsOnly) for (const x of rows) if (x.v === undefined) x.v = false;
  let cells: CellStats[] = [];
  /** integer variables with ≤ this many distinct values bin PER VALUE
   *  (contracts 1–30, hourET, domClusters…) instead of quantiles */
  let perValue = false;

  if (type === "presence") {
    const presentRows = rows.filter((x) => x.v !== undefined);
    const absentRows = rows.filter((x) => x.v === undefined);
    cells = [mkCell(presentRows, "present", null), mkCell(absentRows, "absent", null)];
  } else if (type === "numeric") {
    const nums = rows
      .map((x) => ({ ...x, nv: num(x.v) }))
      .filter((x): x is typeof x & { nv: number } => x.nv !== null);
    const distinct = new Set(nums.map((x) => x.nv));
    const smallIntDomain = distinct.size <= DISTINCT_VALUE_BINS && [...distinct].every((v) => Number.isInteger(v));
    if (smallIntDomain) {
      perValue = true;
      const byVal = new Map<number, typeof nums>();
      for (const x of nums) {
        const arr = byVal.get(x.nv) ?? [];
        arr.push(x);
        byVal.set(x.nv, arr);
      }
      cells = [...byVal.entries()]
        .sort(([a], [b]) => a - b)
        .map(([v, arr]) => mkCell(arr.map((x) => ({ v: x.v, r: x.r })), String(v), v));
    } else {
      const thresholds = quantileThresholds(nums.map((x) => x.nv));
      const byBin = new Map<string, typeof nums>();
      for (const x of nums) {
        const label = binLabelOf(x.nv, thresholds);
        const arr = byBin.get(label) ?? [];
        arr.push(x);
        byBin.set(label, arr);
      }
      cells = [...byBin.entries()]
        .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
        .map(([label, arr]) => {
          const mean = arr.reduce((s, x) => s + x.nv, 0) / arr.length;
          return mkCell(arr.map((x) => ({ v: x.v, r: x.r })), label, Math.round(mean * 100) / 100);
        });
    }
  } else {
    const byCat = new Map<string, typeof rows>();
    for (const x of rows) {
      const label = catLabel(x.v);
      const arr = byCat.get(label) ?? [];
      arr.push(x);
      byCat.set(label, arr);
    }
    cells = [...byCat.entries()]
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([label, arr]) => mkCell(arr, label, null));
  }

  if (cells.length < 2) return null;

  /* ---- statistical direction ------------------------------------ */
  let direction: VarPattern["direction"] = "flat";
  let directionLabel = "no clear direction";
  let effectPp = 0;
  const qualifying = (c: CellStats) => c.n >= minN;
  if (type === "numeric") {
    const q = cells.filter(qualifying);
    if (q.length >= 2) {
      const bottom = q[0]; // lowest value bucket
      const top = q[q.length - 1]; // highest value bucket
      effectPp = (top.wr - bottom.wr) * 100;
      if (effectPp >= 2) direction = "up";
      else if (effectPp <= -2) direction = "down";
      directionLabel =
        direction === "up"
          ? `higher → more wins (${(top.wr * 100).toFixed(0)}% vs ${(bottom.wr * 100).toFixed(0)}%)`
          : direction === "down"
            ? `lower → more wins (${(bottom.wr * 100).toFixed(0)}% vs ${(top.wr * 100).toFixed(0)}%)`
            : "no direction — flat across buckets";
    } else {
      directionLabel = perValue ? "not enough rows per value to judge direction" : "no clear direction";
    }
  } else if (type === "presence" && famCtx) {
    // family-balanced present/absent: an "absent" feature usually just
    // means a different family recorded the trade, so the split must be
    // measured INSIDE each family (present vs absent rows of the same
    // family) and then combined — otherwise it reads family mix, not
    // the variable.
    let wLift = 0;
    let wN = 0;
    let any = false;
    for (const [f, s] of famCtx.baselines) {
      const idx = rows
        .map((x, i) => (famCtx.families[i] === f ? i : -1))
        .filter((i) => i >= 0);
      const present = idx.filter((i) => values[i] !== undefined);
      const absent = idx.filter((i) => values[i] === undefined);
      if (present.length < minN || absent.length < minN) continue;
      const wrP = present.filter((i) => results[i] === "win").length / present.length;
      const wrA = absent.filter((i) => results[i] === "win").length / absent.length;
      const weight = present.length + absent.length;
      wLift += (wrP - wrA) * 100 * weight;
      wN += weight;
      any = true;
    }
    if (any) {
      effectPp = wLift / wN;
      if (effectPp >= 2) {
        direction = "split";
        directionLabel = `present → more wins (+${effectPp.toFixed(1)}pp, within families)`;
      } else if (effectPp <= -2) {
        direction = "split";
        directionLabel = `present → fewer wins (${effectPp.toFixed(1)}pp, within families)`;
      } else {
        directionLabel = "no direction — present/absent flat within families";
      }
    } else {
      directionLabel = "not enough present+absent rows inside one family — see cells";
    }
  } else {
    const q = cells.filter(qualifying);
    if (q.length >= 2) {
      const best = [...q].sort((a, b) => b.wr - a.wr)[0];
      const worst = [...q].sort((a, b) => a.wr - b.wr)[0];
      if (best.wr - worst.wr >= 0.02) {
        direction = "split";
        effectPp = (best.wr - worst.wr) * 100;
        directionLabel = `prefers ${best.label} (${(best.wr * 100).toFixed(0)}% W) over ${worst.label} (${(worst.wr * 100).toFixed(0)}% W)`;
      } else {
        directionLabel = "no direction — all cells near baseline";
      }
    }
  }
  const nTotal = flagsOnly ? values.length : presentCount;
  const dirN = Math.min(
    ...cells.filter(qualifying).map((c) => c.n),
    nTotal,
  );
  const strength: VarPattern["strength"] =
    Math.abs(effectPp) >= 10 && dirN >= 15 ? "strong" : Math.abs(effectPp) >= 5 ? "mild" : "weak";

  /* ---- per-family split ------------------------------------------ */
  const perFamily: FamilyCell[] = [];
  if (famCtx) {
    for (const [family, base] of famCtx.baselines) {
      const idx = famCtx.families
        .map((f, i) => (f === family && (values[i] !== undefined || flagsOnly) ? i : -1))
        .filter((i) => i >= 0);
      const n = idx.length;
      if (n < famCtx.minN) continue;
      const wins = idx.filter((i) => results[i] === "win").length;
      perFamily.push({ family, n, wins, wr: wins / n, liftPp: (wins / n - base) * 100 });
    }
    perFamily.sort((a, b) => b.n - a.n);
  }

  /* ---- p-value (type-appropriate test, see patternStats.ts) ----- */
  let pValue: number | null = null;
  if (type === "numeric") {
    const w: number[] = [];
    const l: number[] = [];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === undefined) continue;
      const nv = num(v);
      if (nv === null) continue;
      (results[i] === "win" ? w : l).push(nv);
    }
    pValue = mannWhitneyP(w, l);
  } else if (type === "presence") {
    if (famCtx) {
      const tables: Array<{ a: number; b: number; c: number; d: number }> = [];
      for (const [f] of famCtx.baselines) {
        const idx = rows
          .map((x, i) => (famCtx.families[i] === f ? i : -1))
          .filter((i) => i >= 0);
        const present = idx.filter((i) => values[i] !== undefined);
        const absent = idx.filter((i) => values[i] === undefined);
        if (present.length === 0 || absent.length === 0) continue;
        tables.push({
          a: present.filter((i) => results[i] === "win").length,
          b: present.filter((i) => results[i] === "loss").length,
          c: absent.filter((i) => results[i] === "win").length,
          d: absent.filter((i) => results[i] === "loss").length,
        });
      }
      if (tables.length > 0) pValue = cmhP(tables);
    } else {
      const present = rows.filter((x) => x.v !== undefined);
      const absent = rows.filter((x) => x.v === undefined);
      pValue = fisherExact(
        present.filter((x) => x.r === "win").length,
        present.filter((x) => x.r === "loss").length,
        absent.filter((x) => x.r === "win").length,
        absent.filter((x) => x.r === "loss").length,
      );
    }
  } else {
    const q = cells.filter(qualifying);
    if (q.length >= 2) {
      const best = [...q].sort((a, b) => b.wr - a.wr)[0];
      const worst = [...q].sort((a, b) => a.wr - b.wr)[0];
      pValue = fisherExact(best.wins, best.n - best.wins, worst.wins, worst.n - worst.wins);
    }
  }

  // display order: per-value integers keep their natural 1..30 order;
  // everything else sorts strongest cell first
  if (perValue) cells.sort((a, b) => Number(a.label) - Number(b.label));
  else cells.sort((a, b) => b.liftPp - a.liftPp || b.n - a.n);
  return {
    key, kind, type, baselineWr, n: nTotal, cells, direction, directionLabel, effectPp, strength, perFamily,
    pValue, qValue: null, stable: null, verdict: "exploratory",
  };
}

export type MineOptions = {
  minN?: number;
  exclude?: Set<string>;
  anatomyKeys?: string[];
};

/** fire-time facts re-attached from the trades row when the feature
 *  vector doesn't already carry them (known at signal time) */
export const PRE_TRADE_KEYS: Record<string, (r: Record<string, unknown>) => unknown> = {
  family: (r) => String(r.family ?? "") || familyOf(String(r.verdict ?? "")) || "other",
  side: (r) => String(r.side),
  contracts: (r) => Number(r.contracts ?? 0),
  hourBucket: (r) => String(r.hour_bucket ?? ""),
  firstOfDay: (r) => r.first_of_day === true,
  hourET: (r) => (/^\d{2}:\d{2}$/.test(String(r.time_et ?? "")) ? Number(String(r.time_et).slice(0, 2)) : null),
};

/** true post-hoc anatomy (correlated with the result by construction) */
export const POST_HOC_KEYS: Record<string, (r: Record<string, unknown>) => unknown> = {
  drift: (r) => toNum(r.entry_adverse_pts),
  heldMin: (r) => toNum(r.held_min),
  mfe: (r) => toNum(r.mfe_pts),
  mae: (r) => toNum(r.mae_pts),
  stopRun: (r) => r.stop_run === true,
  targetReached: (r) => r.target_reached === true,
  recovered: (r) => r.recovered === true,
  lossLabel: (r) => String(r.loss_label ?? ""),
};

const toNum = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** map reconciled `trades` rows (the /api/trades/table shape) to the
 *  mining rows: flat fire-time features + post-hoc anatomy + family.
 *  Shared by the CLI and GET /api/patterns so the two stay in sync. */
export function winLossRowsFromDb(raw: Array<Record<string, unknown>>): WinLossRow[] {
  const rows: WinLossRow[] = [];
  for (const r of raw) {
    let features: Record<string, unknown> | null = null;
    if (r.features !== null && r.features !== undefined) {
      try {
        features = typeof r.features === "string" ? JSON.parse(r.features) : (r.features as Record<string, unknown>);
      } catch {
        features = null;
      }
    }
    const flat = flattenFeatures(features);
    for (const [k, fn] of Object.entries(PRE_TRADE_KEYS)) {
      if (!(k in flat)) {
        const v = fn(r);
        if (v !== null && v !== undefined && v !== "") flat[k] = v;
      }
    }
    const anatomy: Record<string, unknown> = { family: String(r.family ?? "") || familyOf(String(r.verdict ?? "")) || "other" };
    for (const [k, fn] of Object.entries(POST_HOC_KEYS)) anatomy[k] = fn(r);
    rows.push({ result: String(r.result) === "win" ? "win" : "loss", flat, anatomy });
  }
  return rows;
}

/** map recorded SIGNAL rows (the all-signals universe) to mining rows:
 *  the hypothetical first-touch outcome decides win/loss (time/open/
 *  unscored rows are skipped), features come from the signal's own
 *  vector, and post-hoc anatomy is absent (so it never mines). The
 *  result measures SIGNAL QUALITY, not money — hypothetical fills. */
export function signalsToWinLossRows(raw: Array<Record<string, unknown>>): WinLossRow[] {
  const rows: WinLossRow[] = [];
  for (const s of raw) {
    const outcome = String(s.outcome ?? "");
    if (outcome !== "win" && outcome !== "loss") continue;
    const timeET = String(s.time_et ?? "");
    rows.push(
      ...winLossRowsFromDb([
        {
          day: String(s.day),
          time_et: timeET,
          side: String(s.side),
          contracts: Number(String(s.size ?? "").match(/^(\d+)\s*MNQ/)?.[1] ?? 0),
          family: familyOf(String(s.verdict ?? "")),
          verdict: String(s.verdict ?? ""),
          hour_bucket: hourBucketOf(timeET),
          first_of_day: undefined,
          features: s.features ?? null,
          result: outcome,
        },
      ]),
    );
  }
  return rows;
}

/** family baselines over the decided rows (anatomy.family) */
export function familyBaselines(rows: WinLossRow[]): Map<string, number> {
  const by = new Map<string, { n: number; w: number }>();
  for (const r of rows) {
    const f = String(r.anatomy.family ?? "other");
    const s = by.get(f) ?? { n: 0, w: 0 };
    s.n++;
    if (r.result === "win") s.w++;
    by.set(f, s);
  }
  return new Map([...by.entries()].map(([f, s]) => [f, s.n > 0 ? s.w / s.n : 0]));
}

/** one mining pass (no FDR, no stability) — the core loop */
function mineOnce(decided: WinLossRow[], minN: number, exclude: Set<string>, anatomyKeys: string[]): VarPattern[] {
  const wins = decided.filter((r) => r.result === "win").length;
  const baselineWr = decided.length > 0 ? wins / decided.length : 0;
  const baselines = familyBaselines(decided);

  const universe = new Map<string, { kind: VarPattern["kind"]; values: Array<unknown | undefined> }>();
  for (const r of decided) {
    for (const [k, v] of Object.entries(r.flat)) {
      if (exclude.has(k)) continue;
      const slot = universe.get(k) ?? { kind: "fire-time" as const, values: new Array<unknown | undefined>(decided.length).fill(undefined) };
      slot.values[decided.indexOf(r)] = v;
      universe.set(k, slot);
    }
  }
  for (const k of anatomyKeys) {
    if (exclude.has(k)) continue;
    const slot = universe.get(k) ?? { kind: "post-hoc" as const, values: new Array<unknown | undefined>(decided.length).fill(undefined) };
    slot.kind = "post-hoc";
    for (let i = 0; i < decided.length; i++) slot.values[i] = (decided[i].anatomy as Record<string, unknown>)[k];
    universe.set(k, slot);
  }

  const famCtx: FamilyCtx = {
    families: decided.map((r) => (typeof r.anatomy.family === "string" ? (r.anatomy.family as string) : null)),
    baselines,
    minN,
  };

  const out: VarPattern[] = [];
  for (const [key, slot] of universe) {
    const p = patternFor(key, slot.kind, slot.values, decided.map((r) => r.result), baselineWr, minN, famCtx);
    if (p) out.push(p);
  }
  return out;
}

/** the significance threshold for the FDR verdict (documented in the codebook) */
export const FDR_Q = 0.1;
/** minimum |effect| in each half for a direction to count as "holding" */
export const STABILITY_MIN_EFFECT_PP = 2;

/**
 * Mine every variable, then the statistical foundation on top:
 *   · q-values — Benjamini-Hochberg FDR over every variable's p-value
 *     in this run (verdict "significant" at q < 0.10);
 *   · stability — the direction is recomputed on the early and late
 *     halves of the time-ordered rows; it "holds" when both halves
 *     show the same non-flat direction with ≥ 2pp effect each;
 *   · verdict — significant > stable > exploratory, which is also the
 *     ranking order, then |effect|, then n.
 */
export function minePatterns(rows: WinLossRow[], opts: MineOptions = {}): VarPattern[] {
  const minN = opts.minN ?? 5;
  const decided = rows.filter((r) => r.result === "win" || r.result === "loss");
  const exclude = opts.exclude ?? new Set<string>();
  const anatomyKeys = opts.anatomyKeys ?? [];

  const full = mineOnce(decided, minN, exclude, anatomyKeys);

  /* FDR across the run's variables */
  const withP = full
    .map((p, i) => ({ p, i }))
    .filter((x) => x.p.pValue !== null)
    .sort((a, b) => (a.p.pValue ?? 1) - (b.p.pValue ?? 1));
  const qs = bhFdr(withP.map((x) => x.p.pValue ?? 1));
  withP.forEach((x, j) => {
    x.p.qValue = qs[j];
  });

  /* stability: early vs late time halves */
  if (decided.length >= minN * 2) {
    const mid = Math.floor(decided.length / 2);
    const A = new Map(mineOnce(decided.slice(0, mid), minN, exclude, anatomyKeys).map((p) => [p.key, p]));
    const B = new Map(mineOnce(decided.slice(mid), minN, exclude, anatomyKeys).map((p) => [p.key, p]));
    for (const p of full) {
      const a = A.get(p.key);
      const b = B.get(p.key);
      if (!a || !b) p.stable = "insufficient";
      else if (
        a.direction !== "flat" &&
        a.direction === b.direction &&
        Math.abs(a.effectPp) >= STABILITY_MIN_EFFECT_PP &&
        Math.abs(b.effectPp) >= STABILITY_MIN_EFFECT_PP
      ) {
        p.stable = true;
      } else {
        p.stable = false;
      }
    }
  } else {
    for (const p of full) p.stable = "insufficient";
  }

  for (const p of full) {
    // significance is claimed only when FDR passes AND the time split
    // does not contradict it (stable true, or unjudgeable) — a
    // significant-but-flipping pattern is non-stationary, not an edge
    const sig = p.qValue !== null && p.qValue < FDR_Q && p.stable !== false;
    p.verdict = sig ? "significant" : p.stable === true ? "stable" : "exploratory";
  }

  const rank: Record<VarPattern["verdict"], number> = { significant: 0, stable: 1, exploratory: 2 };
  full.sort(
    (a, b) =>
      rank[a.verdict] - rank[b.verdict] ||
      Math.abs(b.effectPp) - Math.abs(a.effectPp) ||
      b.n - a.n ||
      a.key.localeCompare(b.key),
  );
  return full;
}
