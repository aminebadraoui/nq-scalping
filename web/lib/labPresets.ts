import type { Theory } from "./lab";

/**
 * Starter theories. Two of them exist specifically to be instructive:
 * the "shallow sweep (ratio)" preset reproduces a finding that was withdrawn,
 * so the ratio artifact can be seen rather than taken on faith, and
 * "everything the playbook says" shows how few trades survive when every
 * documented condition is required at once.
 */
export const PRESETS: Theory[] = [
  { name: "Baseline — every reclaim", conditions: [], note: "no filters: what the raw trigger does" },
  {
    name: "Reclaim + one-sided entry bar",
    conditions: [{ feature: "oneSidedEntry", op: "==", value: true }],
    note: "reclaim bar ≥ session-median volume and ≥65% one-sided in the entry direction — strongest single filter found (67% win @ 1R, clustered CI [64–70%], holds on holdout)",
  },
  {
    name: "Current playbook (LVN + divergence)",
    conditions: [
      { feature: "lvnEdge", op: "==", value: true },
      { feature: "hasDiv", op: "==", value: true },
    ],
    note: "what the docs describe today",
  },
  {
    name: "T1 — LVN edge + shallow sweep (ratio)",
    conditions: [
      { feature: "lvnEdge", op: "==", value: true },
      { feature: "sweepDepthR", op: "<=", value: 0.3 },
    ],
    note: "the withdrawn finding — kept as a preset so you can watch the ratio artifact for yourself",
  },
  {
    name: "LVN edge + near VWAP + evening",
    conditions: [
      { feature: "lvnEdge", op: "==", value: true },
      { feature: "distVwapPts", op: "<=", value: 50 },
      { feature: "hourET", op: ">=", value: 18 },
      { feature: "hourET", op: "<=", value: 20 },
    ],
    note: "the current best hypothesis, all-absolute features",
  },
  {
    name: "LVN edge only",
    conditions: [{ feature: "lvnEdge", op: "==", value: true }],
    note: "isolates the location premise",
  },
  {
    name: "Everything the playbook says",
    conditions: [
      { feature: "lvnEdge", op: "==", value: true },
      { feature: "hasAbs", op: "==", value: true },
      { feature: "hasDiv", op: "==", value: true },
    ],
    note: "location + mechanism + fuel — note how few trades survive",
  },
];
