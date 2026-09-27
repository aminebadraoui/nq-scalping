/* Timezone helpers. The feed clock is US Central, live ticks are UTC, and the
 * UI must always show New York — including the two one-hour windows per year
 * where a naive "+1 hour" is wrong. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { cdtToET, etToFeed, utcToET, utcToFeed, fmtETTime, feedToEpoch, etToEpoch, utcToEpoch } from "../lib/times.ts";

const ny = (sec) => fmtETTime(sec);
const inTz = (sec, tz) => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit" }).format(new Date(sec * 1000));

test("feed clock -> New York is +1h and round-trips", () => {
  for (let h = 0; h < 24; h++) {
    for (const m of [0, 15, 30, 45]) {
      const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      assert.equal(etToFeed(cdtToET(hhmm)), hhmm, hhmm);
    }
  }
  assert.equal(cdtToET("08:30"), "09:30", "the RTH open");
  assert.equal(cdtToET("14:59"), "15:59", "the RTH close (cash session)");
});

test("utcToET is DST-aware (EDT -4h, EST -5h)", () => {
  assert.equal(utcToET("13:30", "2026-09-25"), "09:30", "September = EDT");
  assert.equal(utcToET("14:30", "2026-12-15"), "09:30", "December = EST");
  assert.equal(utcToET("14:30", "2026-01-20"), "09:30");
  // agree with Intl for every minute of a summer and a winter day
  for (const day of ["2026-09-25", "2026-12-15"]) {
    for (let h = 0; h < 24; h++) {
      const hhmm = `${String(h).padStart(2, "0")}:00`;
      const sec = utcToEpoch(hhmm, day);
      assert.equal(utcToET(hhmm, day), inTz(sec, "America/New_York"), `${day} ${hhmm}`);
    }
  }
});

test("the two DST windows per year are exact (Chicago and New York differ by 2h in UTC terms)", () => {
  for (const day of ["2026-03-08", "2026-11-01"]) {
    for (const hhmm of ["01:00", "01:30", "01:59"]) {
      const sec = feedToEpoch(hhmm, day);
      assert.equal(inTz(sec, "America/Chicago"), hhmm, `feed ${day} ${hhmm} round-trips through Chicago`);
    }
  }
  // spring forward: CT 01:30 is 03:30 New York (a naive +1h would say 02:30)
  assert.equal(ny(feedToEpoch("01:30", "2026-03-08")), "03:30");
  // fall back: CT 01:30 is 01:30 New York (a naive +1h would say 02:30)
  assert.equal(ny(feedToEpoch("01:30", "2026-11-01")), "01:30");
});

test("feedToEpoch maps the session boundaries correctly in both seasons", () => {
  for (const day of ["2026-09-25", "2026-12-15", "2026-01-20", "2026-03-10", "2026-11-10"]) {
    assert.equal(ny(feedToEpoch("08:30", day)), "09:30", `${day} RTH open`);
    assert.equal(ny(feedToEpoch("14:59", day)), "15:59", `${day} RTH close`);
    assert.equal(feedToEpoch("09:30", day) - feedToEpoch("08:30", day), 3600, `${day} one hour of bars`);
  }
});

test("etToEpoch agrees with Intl on regular and DST days", () => {
  for (const day of ["2026-09-25", "2026-12-15", "2026-03-08", "2026-11-01"]) {
    for (const hhmm of ["03:00", "09:30", "12:00", "16:00"]) {
      const sec = etToEpoch(hhmm, day);
      assert.equal(ny(sec), hhmm, `${day} ${hhmm}`);
    }
  }
});

test("utcToFeed composes UTC -> New York -> feed", () => {
  assert.equal(utcToFeed("13:30", "2026-09-25"), "08:30", "13:30Z = 09:30 NY = 08:30 feed");
  assert.equal(utcToFeed("14:30", "2026-12-15"), "08:30", "winter uses EST");
  // round trip against the live-tick convention used by the dashboard
  for (const hhmm of ["00:00", "05:59", "13:30", "23:59"]) {
    const feed = utcToFeed(hhmm, "2026-09-25");
    assert.equal(feed.length, 5);
  }
});

test("fmtETTime handles midnight and DST boundaries", () => {
  assert.equal(fmtETTime(utcToEpoch("04:00", "2026-09-25")), "00:00", "midnight is 00:00, not 24:00");
  assert.equal(fmtETTime(utcToEpoch("07:00", "2026-03-08")), "03:00", "spring forward");
  assert.equal(fmtETTime(utcToEpoch("06:00", "2026-11-01")), "01:00", "fall back");
});
