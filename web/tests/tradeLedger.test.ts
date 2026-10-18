import { test } from "node:test";
import assert from "node:assert/strict";
import {
  attachVariations,
  buildRowFromDb,
  buildRowsFromDaybook,
  distinctVariables,
  flattenFeatures,
  ledgerCsv,
  type LedgerRow,
} from "../lib/tradeLedger";
import { accountForDay } from "../lib/accountAttribution";

const row = (over: Partial<LedgerRow>): LedgerRow => ({
  key: "k",
  day: "2026-10-07",
  timeET: "09:35",
  ts: 1_700_000_000_000,
  account: "DEMO2323960",
  accountSource: "timeline",
  variationId: null,
  buildSha: null,
  side: "long",
  contracts: 9,
  family: "rth",
  verdict: "RTH …",
  headline: "",
  status: "matched",
  result: "win",
  sigEntry: 31500,
  sigStop: 31493,
  sigTarget: 31515,
  fillEntry: 31500.25,
  exitAvg: 31514.5,
  grossUsd: 100,
  netUsd: 80,
  drift: 0.25,
  mfe: 15,
  mae: 1,
  heldMin: 12,
  stopRun: false,
  targetReached: true,
  recovered: false,
  lossLabel: "",
  size: "9 MNQ",
  source: "live",
  test: false,
  sent: true,
  reason: "",
  features: null,
  settings: null,
  ...over,
});

test("accountForDay: the known switch timeline (deploy/STATE.md)", () => {
  assert.equal(accountForDay("2026-10-05"), "MFFUSFREOD706880008");
  assert.equal(accountForDay("2026-10-14"), "MFFUSFREOD706880008");
  assert.equal(accountForDay("2026-10-15"), "MFFUEVREOD706880009");
  assert.equal(accountForDay("2026-10-16"), "DEMO2323960");
  assert.equal(accountForDay("2026-10-18"), "DEMO2323960");
});

test("flattenFeatures: nested objects become dotted leaves, arrays stringified", () => {
  const f = flattenFeatures({
    flushFrac: 0.62,
    dom: { nq: { wallsN: 2 }, es: { candidates: 1 } },
    gates: ["rth.hour_veto", "mom.enable"],
    nothing: null,
  });
  assert.equal(f.flushFrac, 0.62);
  assert.equal(f["dom.nq.wallsN"], 2);
  assert.equal(f["dom.es.candidates"], 1);
  assert.equal(f.gates, '["rth.hour_veto","mom.enable"]');
  assert.equal("nothing" in f, false, "null leaves are dropped");
});

test("distinctVariables: counts across rows, most common first", () => {
  const rows = [
    row({ features: { a: 1, b: 2, dom: { x: 1 } } }),
    row({ features: { a: 3, dom: { x: 2 } } }),
  ];
  const vars = distinctVariables(rows);
  assert.deepEqual(vars.map((v) => v.key), ["a", "dom.x", "b"]);
  assert.equal(vars[0].count, 2);
});

test("ledgerCsv: core columns then variables, quoted values", () => {
  const rows = [row({ features: { flushFrac: 0.5, note: 'x "quoted", y' } })];
  const csv = ledgerCsv(rows, ["flushFrac", "note"]);
  const lines = csv.split("\n");
  assert.equal(lines[0].split(",")[0], "day");
  assert.ok(lines[0].endsWith("note"));
  const body = lines[1];
  assert.ok(body.includes('"x ""quoted"", y"'), "feature quoting");
  assert.ok(body.includes("0.5"));
});

test("attachVariations: latest boot at or before the trade ts wins", () => {
  const rows = [row({ day: "2026-10-07", ts: 500 })];
  const recs = new Map([
    [
      "2026-10-07",
      [
        { t: "boot", at: 100, sha: "aaa", buildId: "", variationId: "v1", settings: { A: "1" } },
        { t: "boot", at: 400, sha: "bbb", buildId: "", variationId: "v2", settings: { A: "2" } },
        { t: "boot", at: 600, sha: "ccc", buildId: "", variationId: "v3", settings: { A: "3" } },
      ],
    ],
  ]) as never;
  attachVariations(rows, recs);
  assert.equal(rows[0].variationId, "v2", "boot at 600 is after the trade");
  assert.equal(rows[0].buildSha, "bbb");
  assert.equal(rows[0].settings?.A, "2");
});

test("attachVariations: first boot of the day when the row has no ts", () => {
  const rows = [row({ day: "2026-10-07", ts: 0 })];
  const recs = new Map([
    [
      "2026-10-07",
      [
        { t: "boot", at: 100, sha: "aaa", buildId: "", variationId: "v1", settings: {} },
        { t: "boot", at: 400, sha: "bbb", buildId: "", variationId: "v2", settings: {} },
      ],
    ],
  ]) as never;
  attachVariations(rows, recs);
  assert.equal(rows[0].variationId, "v1");
});

test("buildRowsFromDaybook: duplicate signal lines dedupe, newest dayend wins", () => {
  const sig = { t: "signal", at: 100, day: "2026-10-07", timeET: "09:35", symbol: "NQ", side: "long", price: 1, entry: "31500", stop: "31493", target: "31515", size: "9 MNQ", verdict: "RTH card", headline: "h", source: "live", sent: true, reason: "", features: { flushFrac: 0.5 } };
  const rows = buildRowsFromDaybook([
    {
      day: "2026-10-07",
      recs: [
        { ...sig },
        { ...sig }, // duplicate line (local volume + R2 both carry it)
        { t: "dayend", at: 900, summary: { trades: [{ day: "2026-10-07", timeET: "", side: "long", contracts: 9, family: "rth", verdict: "RTH card", entry: 31500, exit: 31515, stop: 31493, target: 31515, grossUsd: 100, netUsd: 80, commissions: 20, result: "win", heldMin: 8, exitReason: "target" }] } },
        { t: "dayend", at: 950, summary: { trades: [{ day: "2026-10-07", timeET: "", side: "long", contracts: 9, family: "rth", verdict: "RTH card", entry: 31500, exit: 31500, stop: 31493, target: 31515, grossUsd: 0, netUsd: -20, commissions: 20, result: "flat", heldMin: 9, exitReason: "time" }] } },
      ] as never[],
    },
  ]);
  assert.equal(rows.length, 1, "one signal after dedupe, one dayend after newest-wins");
  assert.equal(rows[0].result, "flat", "the newest dayend summary wins");
  assert.equal(rows[0].features?.flushFrac, 0.5);
});

test("buildRowFromDb: maps the reconciled row, parses features, attributes account", () => {
  const r = buildRowFromDb({
    signal_key: "sig1",
    day: "2026-10-04",
    time_et: "10:15",
    ts: 1000,
    side: "short",
    contracts: 9,
    verdict: "MOMENTUM — huge-bar expansion …",
    headline: "h",
    status: "matched",
    result: "loss",
    sig_entry: "31500.00",
    sig_stop: "31506.50",
    sig_target: "31485.00",
    fill_entry: "31500.25",
    exit_avg: "31505.75",
    gross_usd: "250",
    net_usd: "220",
    entry_adverse_pts: "0.25",
    mfe_pts: "2",
    mae_pts: "6.5",
    held_min: "4",
    stop_run: true,
    target_reached: false,
    recovered: true,
    loss_label: "stop-run",
    features: JSON.stringify({ flushFrac: 0.7, dom: { nq: { wallsN: 1 } } }),
    sig_size: "9 MNQ",
    sig_source: "live",
    sig_sent: true,
  });
  assert.equal(r.account, "MFFUSFREOD706880008", "timeline fallback for a legacy row");
  assert.equal(r.accountSource, "timeline");
  assert.equal(r.family, "momentum_expansion");
  assert.equal(r.features?.flushFrac, 0.7);
  assert.equal(r.stopRun, true);
  assert.equal(r.sigEntry, 31500);
  assert.equal(r.drift, 0.25);
  assert.equal(r.size, "9 MNQ");
  assert.equal(r.sent, true);
});

test("buildRowFromDb: fire-time account stamp wins over the timeline", () => {
  const r = buildRowFromDb({
    signal_key: "sig2",
    day: "2026-10-04",
    time_et: "10:15",
    ts: 1000,
    side: "short",
    contracts: 9,
    verdict: "RTH …",
    headline: "h",
    status: "matched",
    result: "loss",
    account: "MFFUEVREOD706880006",
    gross_usd: "10",
    net_usd: "8",
  });
  assert.equal(r.account, "MFFUEVREOD706880006");
  assert.equal(r.accountSource, "fire-time");
});

test("buildRowsFromDaybook: pairs summary trades to signals, leftovers become no-fill", () => {
  const rows = buildRowsFromDaybook([
    {
      day: "2026-10-07",
      recs: [
        { t: "signal", at: 100, day: "2026-10-07", timeET: "09:35", symbol: "NQ", side: "long", price: 1, entry: "31500", stop: "31493", target: "31515", size: "9 MNQ", verdict: "RTH card", headline: "h", source: "live", sent: true, reason: "", features: { flushFrac: 0.5 } },
        { t: "signal", at: 200, day: "2026-10-07", timeET: "10:02", symbol: "NQ", side: "short", price: 2, entry: "31400", stop: "31407", target: "31385", size: "9 MNQ", verdict: "RTH card", headline: "h", source: "live", sent: true, reason: "news veto", features: { gate: "news" } },
        {
          t: "dayend",
          at: 999,
          summary: {
            trades: [
              { day: "2026-10-07", timeET: "", side: "long", contracts: 9, family: "rth", verdict: "RTH card", entry: 31500, exit: 31515, stop: 31493, target: 31515, grossUsd: 270, netUsd: 235.5, commissions: 34.5, result: "win", heldMin: 8, exitReason: "target" },
            ],
          },
        },
      ] as never[],
    },
  ]);
  assert.equal(rows.length, 2);
  const win = rows.find((r) => r.result === "win")!;
  const noFill = rows.find((r) => r.status === "no-fill")!;
  assert.equal(win.features?.flushFrac, 0.5, "matched row carries the signal features");
  assert.equal(win.contracts, 9);
  assert.equal(noFill.side, "short");
  assert.equal(noFill.reason, "news veto");
  assert.equal(noFill.account, "MFFUSFREOD706880008", "timeline attribution for the DB-less path");
});
