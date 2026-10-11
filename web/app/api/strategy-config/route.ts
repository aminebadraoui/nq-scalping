import type { NextRequest } from "next/server";
import { effectiveConfigSnapshot } from "@/lib/effectiveConfig";
import { getOverrides } from "@/lib/strategyOverrides";
import { loadExecOverrides } from "@/lib/execOverrides";

export const dynamic = "force-dynamic";

/** The effective configuration snapshot — one read for "what exactly is
 *  running right now": strategy declarations + resolved FEED_* flags +
 *  the guard knobs + active strategy_overrides rows + the masked keys of
 *  any operator exec-overrides. No secrets: operator values are never
 *  returned, only their keys. */
export async function GET(_req: NextRequest) {
  const overrides = await getOverrides();
  const operator = Object.keys(loadExecOverrides());
  const cfg = effectiveConfigSnapshot(process.env, overrides, operator);
  return Response.json({ ok: true, config: cfg });
}
