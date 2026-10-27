import { readFileSync } from "node:fs";
import { simulateHonest } from "../../web/lib/honestFill.ts";
const j = JSON.parse(readFileSync(process.env.PARITY_IN ?? "parity_in.json", "utf8"));
const out = j.cases.map((c: any) => {
  const entry = c.kind === "market" ? { kind: "market" } : { kind: c.kind, price: c.price, ttlBars: c.ttl };
  return simulateHonest(j.bars[c.d], { dir: c.dir, signalIdx: c.i, entry, stopPts: c.sp, targetPts: c.tp, holdBars: 30 });
});
console.log(JSON.stringify(out));
