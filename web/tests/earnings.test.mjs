/* Earnings parsers (lib/earnings.ts) — offline tests over fixtures
 * mirroring the live Nasdaq payloads: surprise table, forward calendar,
 * estimate fallback, sorting. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLastReport,
  parseNextCalendar,
  buildRow,
  estimateNextDate,
  sortRows,
  NQ_MAJOR,
} from "../lib/earnings.ts";

const SURPRISE = {
  data: {
    symbol: "msft",
    earningsSurpriseTable: {
      headers: {},
      rows: [
        { fiscalQtrEnd: "Jun 2026", dateReported: "7/29/2026", eps: 4.74, consensusForecast: "4.21", percentageSurprise: "12.59" },
        { fiscalQtrEnd: "Mar 2026", dateReported: "4/29/2026", eps: 4.27, consensusForecast: "4.07", percentageSurprise: "4.91" },
      ],
    },
    message: null,
    status: { rCode: 200 },
  },
};

test("surprise table → newest report first, money strings parsed", () => {
  const l = parseLastReport(SURPRISE);
  assert.equal(l.lastDate, "2026-07-29");
  assert.equal(l.lastFiscalQ, "Jun 2026");
  assert.equal(l.lastEps, 4.74);
  assert.equal(l.lastConsensus, 4.21);
  assert.equal(l.surprisePct, 12.59);
});

test("surprise table tolerates garbage/missing fields", () => {
  assert.equal(parseLastReport(null).lastDate, null);
  assert.equal(parseLastReport({ data: { earningsSurpriseTable: { rows: [] } } }).lastEps, null);
  const l = parseLastReport({
    data: { earningsSurpriseTable: { rows: [{ fiscalQtrEnd: "", dateReported: "not-a-date", eps: "n/a", consensusForecast: "$1.2", percentageSurprise: "" }] } },
  });
  assert.equal(l.lastDate, null);
  assert.equal(l.lastEps, null);
  assert.equal(l.lastConsensus, 1.2);
  assert.equal(l.surprisePct, null);
});

const CALENDAR_DAY = {
  data: {
    asOf: "Wed, Nov 18, 2026",
    rows: [
      { lastYearRptDt: "11/19/2025", lastYearEPS: "$1.24", time: "time-not-supplied", symbol: "NVDA", name: "NVIDIA Corporation", fiscalQuarterEnding: "Oct/2026", epsForecast: "$2.47" },
      { lastYearRptDt: "11/18/2025", lastYearEPS: "$2.00", time: "time-after-hours", symbol: "MSFT", name: "Microsoft", fiscalQuarterEnding: "Sep/2026", epsForecast: "$4.70" },
      { lastYearRptDt: "11/17/2025", lastYearEPS: "$1.50", time: "time-pre-market", symbol: "AAPL", name: "Apple", fiscalQuarterEnding: "Sep/2026", epsForecast: "$2.60" },
    ],
  },
};

test("forward calendar: date applied, BMO/AMC mapped, TNS = unconfirmed", () => {
  const next = parseNextCalendar(CALENDAR_DAY, "2026-11-18");
  assert.equal(next.length, 3);
  const [nvda, msft, aapl] = next;
  assert.equal(nvda.nextDate, "2026-11-18");
  assert.equal(nvda.nextTime, null); // time-not-supplied
  assert.equal(msft.nextTime, "amc");
  assert.equal(aapl.nextTime, "bmo");
  assert.equal(msft.nextEpsEst, 4.7);
  assert.equal(nvda.lastYearRptDt, "11/19/2025");
});

test("buildRow: confirmed date is not estimated; TNS is estimated", () => {
  const last = parseLastReport(SURPRISE);
  const confirmed = parseNextCalendar(CALENDAR_DAY, "2026-11-18")[1]; // MSFT amc
  const tns = parseNextCalendar(CALENDAR_DAY, "2026-11-18")[0]; // NVDA TNS
  const confirmedRow = buildRow("MSFT", "Microsoft", last, confirmed);
  assert.equal(confirmedRow.nextEstimated, false);
  assert.equal(confirmedRow.nextDate, "2026-11-18");
  const estRow = buildRow("NVDA", "NVIDIA", last, tns);
  assert.equal(estRow.nextEstimated, true);
  assert.equal(estRow.nextDate, "2026-11-18");
});

test("buildRow: no calendar hit → last report + 91d estimate", () => {
  const last = parseLastReport(SURPRISE); // 2026-07-29
  const row = buildRow("MSFT", "Microsoft", last, null);
  assert.equal(row.nextEstimated, true);
  assert.equal(row.nextDate, "2026-10-28"); // 7/29 + 91d
  assert.equal(row.nextTime, null);
});

test("estimateNextDate prefers last-year date, then last report +91d", () => {
  assert.equal(estimateNextDate("11/19/2025", "2026-07-29"), "2026-11-19");
  assert.equal(estimateNextDate(null, "2026-07-29"), "2026-10-28");
  assert.equal(estimateNextDate(null, null), null);
  assert.equal(estimateNextDate("garbage", null), null);
});

test("sortRows: by next date asc, TBA last", () => {
  const last = parseLastReport(SURPRISE);
  const empty = { lastDate: null, lastFiscalQ: null, lastEps: null, lastConsensus: null, surprisePct: null };
  const rows = [
    buildRow("ZZZZ", "Later", last, { nextDate: "2026-11-18", nextTime: "amc", nextFiscalQ: null, nextEpsEst: null, lastYearRptDt: null }),
    buildRow("AAAA", "Sooner", last, { nextDate: "2026-10-28", nextTime: "bmo", nextFiscalQ: null, nextEpsEst: null, lastYearRptDt: null }),
    buildRow("MMMM", "NoDate", empty, null), // no last report → genuinely TBA
  ];
  const sorted = sortRows(rows);
  assert.deepEqual(sorted.map((r) => r.symbol), ["AAAA", "ZZZZ", "MMMM"]);
});

test("NQ_MAJOR is the top-30 universe: unique symbols, 30 rows, has the heavyweights", () => {
  assert.equal(NQ_MAJOR.length, 30);
  assert.equal(new Set(NQ_MAJOR.map((t) => t.symbol)).size, 30);
  for (const s of ["NVDA", "AAPL", "MSFT", "MU", "AMD", "AMZN", "AVGO", "TSLA", "GOOGL", "PLTR", "SPCX"]) {
    assert.ok(NQ_MAJOR.some((t) => t.symbol === s), `missing ${s}`);
  }
});
