import { loadSessionMinutes, archiveDates } from "../lib/archive";
const t0 = Date.now();
const dates = await archiveDates();
console.log("dates:", dates.length, "first:", dates[0], "last:", dates[dates.length - 1]);
const m = await loadSessionMinutes(dates[0]);
console.log("first session bars:", m?.length, "t0:", m?.[0]?.t, "d:", m?.[0]?.d, "sample:", JSON.stringify(m?.[390]));
console.log("elapsed s:", (Date.now() - t0) / 1000);
