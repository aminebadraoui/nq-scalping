/* Weekly news calendar (lib/newsCalendar.ts) — pure parsing tests over
 * ForexFactory-mirror-style fixtures: USD filter, impact tiers,
 * ET-day grouping, Sunday rollover, released marking, static fallback. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNewsWeek, staticWeek, weekDaysOf, nextMonday } from "../lib/newsCalendar.ts";

const mk = (o = {}) => ({
  title: o.title ?? "Test",
  country: o.country ?? "USD",
  date: o.date ?? "2026-10-05T08:30:00-04:00",
  impact: o.impact ?? "High",
  forecast: o.forecast ?? "",
  previous: o.previous ?? "",
  actual: o.actual ?? "",
});

const WEEK_RAW = [
  mk({ title: "CPI m/m", date: "2026-10-06T08:30:00-04:00" }), // Tue High
  mk({ title: "FOMC Statement", date: "2026-10-07T14:00:00-04:00" }),
  mk({ title: "Unemployment Claims", date: "2026-10-08T08:30:00-04:00", impact: "Medium" }),
  mk({ title: "Retail Sales m/m", date: "2026-10-09T08:30:00-04:00" }),
  mk({ title: "EUR CPI", country: "EUR", date: "2026-10-06T05:00:00-04:00" }),
  mk({ title: "US Bank Holiday", date: "2026-10-08T00:00:00-04:00", impact: "Holiday" }),
  mk({ title: "Low-tier Speech", date: "2026-10-07T12:00:00-04:00", impact: "Low" }),
];

test("keeps USD High+Medium, drops Low/Holiday/non-USD; groups by ET day", () => {
  const w = buildNewsWeek(WEEK_RAW, { day: "2026-10-05", minute: 600 });
  assert.equal(w.source, "forexfactory");
  // Tue, Wed, Thu, Fri — Low/Holiday/EUR dropped, Medium kept (panel filters High-only client-side)
  assert.deepEqual(w.days.map((d) => d.day), ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]);
  assert.deepEqual(
    w.days[0].items.map((i) => i.title),
    ["CPI m/m"],
  );
  assert.deepEqual(
    w.days[2].items.map((i) => i.title),
    ["Unemployment Claims"],
  );
});

test("sorts by time within a day and marks released vs upcoming", () => {
  const raw = [
    mk({ title: "Late", date: "2026-10-06T14:00:00-04:00" }),
    mk({ title: "Early", date: "2026-10-06T08:30:00-04:00" }),
  ];
  // "now" = Tue 12:00 ET → Early released, Late upcoming
  const w = buildNewsWeek(raw, { day: "2026-10-06", minute: 720 });
  const [a, b] = w.days[0].items;
  assert.equal(a.title, "Early");
  assert.equal(a.released, true);
  assert.equal(b.title, "Late");
  assert.equal(b.released, false);
});

test("past days are marked released even before their clock time", () => {
  const raw = [mk({ title: "Mon Event", date: "2026-10-05T08:30:00-04:00" })];
  const w = buildNewsWeek(raw, { day: "2026-10-06", minute: 60 }); // now = Tue 01:00 ET
  assert.equal(w.days[0].items[0].released, true);
});

test("Sunday fetch anchors on the upcoming week (FF weekly rollover)", () => {
  // feed already shows next week's events; "now" is Sunday
  const raw = [
    mk({ title: "CPI m/m", date: "2026-10-13T08:30:00-04:00" }),
    mk({ title: "PPI m/m", date: "2026-10-14T08:30:00-04:00" }),
  ];
  const w = buildNewsWeek(raw, { day: "2026-10-11", minute: 600 }); // Sun 10/11
  assert.deepEqual(w.days.map((d) => d.day), ["2026-10-13", "2026-10-14"]);
  // nothing released yet — the whole week is ahead of Sunday
  assert.ok(w.days.every((d) => d.items.every((i) => !i.released)));
});

test("forecast/previous/actual survive, HTML entities unescape", () => {
  const raw = [
    mk({ title: "CPI y/y", date: "2026-10-06T08:30:00-04:00", forecast: "2.4%", previous: "2.5%", actual: "2.6%" }),
  ];
  const [it] = buildNewsWeek(raw, { day: "2026-10-05", minute: 600 }).days[0].items;
  assert.equal(it.forecast, "2.4%");
  assert.equal(it.previous, "2.5%");
  assert.equal(it.actual, "2.6%");
  const rawEnt = [
    mk({ title: "CPI &lt;core&gt; &amp; more", date: "2026-10-06T08:30:00-04:00" }),
  ];
  assert.equal(buildNewsWeek(rawEnt, { day: "2026-10-05", minute: 600 }).days[0].items[0].title, "CPI <core> & more");
});

test("empty or non-USD feed → empty feed week (caller falls back)", () => {
  assert.equal(buildNewsWeek([], { day: "2026-10-05", minute: 600 }).days.length, 0);
  assert.equal(buildNewsWeek([mk({ country: "JPY" })], { day: "2026-10-05", minute: 600 }).days.length, 0);
});

test("weekDaysOf returns Mon–Fri for any day of the week", () => {
  assert.deepEqual(weekDaysOf("2026-10-05"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]); // Mon
  assert.deepEqual(weekDaysOf("2026-10-09"), ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"]); // Fri
  assert.deepEqual(weekDaysOf("2026-10-11"), ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"]); // Sun → next week
});

test("nextMonday skips to the upcoming week from the weekend", () => {
  assert.equal(nextMonday("2026-10-10"), "2026-10-12"); // Sat
  assert.equal(nextMonday("2026-10-11"), "2026-10-12"); // Sun
  assert.equal(nextMonday("2026-10-09"), "2026-10-12"); // Fri
});

test("static fallback: FOMC/CPI/NFP days appear, 8:30 & 14:00 ET, High impact", () => {
  // pick a week with known hardcoded events: 2026-10-13 CPI + 2026-10-14 PPI (see newsGate.ts)
  const w = staticWeek({ day: "2026-10-12", minute: 600 }); // Mon of that week
  assert.equal(w.source, "static");
  const all = w.days.flatMap((d) => d.items);
  assert.ok(all.some((i) => i.title === "CPI" && i.day === "2026-10-13" && i.timeET === "08:30"));
  assert.ok(all.some((i) => i.title === "PPI" && i.day === "2026-10-14" && i.timeET === "08:30"));
  assert.ok(all.every((i) => i.impact === "High"));
});

test("static fallback targets the upcoming week on weekends", () => {
  const w = staticWeek({ day: "2026-10-11", minute: 600 }); // Sunday
  // CPI 10/13 + PPI 10/14 are the week-2 events in newsGate.ts:
  assert.deepEqual(w.days.map((d) => d.day), ["2026-10-13", "2026-10-14"]);
});

/* --- weekend / rollover behavior (the "no news this week" bug) --- */
import { hasUpcoming } from "../lib/newsCalendar.ts";

test("hasUpcoming: true while any event is unreleased, false when the week is done", () => {
  const raw = [mk({ title: "CPI m/m", date: "2026-10-06T08:30:00-04:00" })];
  assert.equal(hasUpcoming(buildNewsWeek(raw, { day: "2026-10-05", minute: 600 })), true); // Mon before
  assert.equal(hasUpcoming(buildNewsWeek(raw, { day: "2026-10-06", minute: 720 })), false); // Tue 12:00, released
});

test("Saturday: the mirror's week is fully released (caller must fall back)", () => {
  // the mirror still serves the week just ended on Saturday
  const raw = [mk({ title: "CPI m/m", date: "2026-10-06T08:30:00-04:00" })];
  const w = buildNewsWeek(raw, { day: "2026-10-10", minute: 600 }); // Sat
  assert.equal(w.days.length, 1); // data present…
  assert.equal(hasUpcoming(w), false); // …but nothing upcoming
});

test("static fallback rolls forward once the current week is done", () => {
  // Fri 10/16 17:00 ET — CPI/PPI week over; next static event = FOMC 10/28
  const w = staticWeek({ day: "2026-10-16", minute: 1020 });
  assert.equal(w.source, "static");
  assert.deepEqual(w.days.map((d) => d.day), ["2026-10-28"]);
  assert.ok(w.days[0].items.some((i) => i.title === "FOMC decision" && i.timeET === "14:00"));
});

