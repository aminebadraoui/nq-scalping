import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMffTrades, matchMff, mffTs } from "../lib/mffImport";

const TXT = `MNQZ6
10
Oct 01, 6:43:09 PM
$30796.25
LONG
3m 3sec
Oct 01, 6:46:13 PM
$30804.25
+$141.00
MNQZ6
9
Oct 02, 12:59:43 PM
$31062.75
LONG
1m 1sec
Oct 02, 1:00:45 PM
$31086.25
+$405.90
MNQZ6
18
Oct 02, 2:20:11 PM
$31029.5
LONG
2m 29sec
Oct 02, 2:22:40 PM
$31021.5
-$322.20
MNQZ6
9
Oct 02, 2:15:02 PM
$31049.5
LONG
6sec
Oct 02, 2:15:08 PM
$31044.5
-$107.10
MNQZ6
MESZ6
1
Oct 01, 7:01:52 PM
$7731
LONG
20m 40sec
Oct 01, 7:22:31 PM
$7733.5
+$10.60
MESZ6
`;

test("parseMffTrades: blocks, times, net/gross/fees split", () => {
  const rows = parseMffTrades(TXT);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].qty, 10);
  assert.equal(rows[0].direction, "long");
  assert.equal(rows[0].netUsd, 141);
  assert.equal(rows[0].grossUsd, 160, "8 pts × 10 × $2");
  assert.equal(rows[0].feesUsd, 19, "10 × 2 sides × $0.95");
  assert.equal(rows[0].day, "2026-10-01");
  const grouped = rows[2];
  assert.equal(grouped.grossUsd, -288, "signed gross: the 18-lot is a loss");
  assert.equal(grouped.feesUsd, 34.2, "18 × 2 sides × $0.95");
  const mes = rows[4];
  assert.equal(mes.grossUsd, 12.5, "MES: 2.5 pts × 1 × $5");
  assert.equal(mes.feesUsd, 1.9, "MES fees $0.95/side too");
  assert.equal(mes.netUsd, 10.6);
});

test("mffTs: PM/AM and ET→epoch", () => {
  const t = mffTs("Oct 01, 6:43:09 PM");
  assert.equal(t, Date.parse("2026-10-01T22:43:09Z"), "EDT is UTC-4");
  const a = mffTs("Oct 02, 11:28:07 AM");
  assert.equal(a, Date.parse("2026-10-02T15:28:07Z"));
});

test("matchMff: exact match + proportional split for grouped trades", () => {
  const rows = parseMffTrades(TXT);
  const bots = [
    { signal_key: "s1", ts: 0, side: "long", contracts: 10, gross_usd: 0, fill_entry_at: "2026-10-01T22:43:09Z" },
    { signal_key: "s2", ts: 0, side: "long", contracts: 9, gross_usd: 0, fill_entry_at: "2026-10-02T16:59:43Z" },
    { signal_key: "s3", ts: 0, side: "long", contracts: 9, gross_usd: 0, fill_entry_at: "2026-10-02T18:20:11Z" },
    { signal_key: "phantom", ts: 0, side: "short", contracts: 9, gross_usd: 0, fill_entry_at: "2026-10-02T16:59:09Z" },
  ];
  const { assignments, manual, matchedKeys } = matchMff(rows, bots);
  assert.equal(assignments.length, 3);
  const s1 = assignments.find((a) => a.signalKey === "s1")!;
  assert.equal(s1.netUsd, 141);
  assert.equal(s1.feesUsd, 19);
  const s3 = assignments.find((a) => a.signalKey === "s3")!;
  assert.equal(s3.netUsd, -161.1, "9 of the 18 contracts = half the loss");
  assert.equal(matchedKeys.has("phantom"), false, "no MFF trade for the phantom short");
  // manual: the 2:15 loss + the MES + the leftover 9 of the 18-lot
  assert.equal(manual.length, 3);
  const leftover = manual.find((m) => m.key.startsWith("MNQZ6") && m.splitQty === 9 && m.splitNet === -161.1);
  assert.ok(leftover, "the other 9 contracts land in the manual bucket");
});
