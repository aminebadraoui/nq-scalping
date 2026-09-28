import type { NextRequest } from "next/server";
import {
  LAB_FEATURES,
  buildLabSamples,
  evaluateTheory,
  type Condition,
  type Theory,
} from "@/lib/lab";
import { PRESETS } from "@/lib/labPresets";

/**
 * Theory lab endpoint.
 *
 *   GET                     → feature vocabulary, session inventory, baseline
 *   POST { theory }         → evaluated metrics for that theory
 *
 * The theory is a declarative list of conditions over a fixed feature
 * vocabulary, so nothing user-supplied is ever executed — a lab where you can
 * type arbitrary code would be a remote-code-execution hole, not a feature.
 */
export async function GET(req: NextRequest) {
  try {
    const { samples, dates, skipped } = await buildLabSamples({ force: req.nextUrl.searchParams.has("refresh") });
    const baseline = evaluateTheory({ name: "baseline", conditions: [] }, samples, dates);
    return Response.json({
      ok: true,
      features: LAB_FEATURES,
      sessions: dates,
      skippedSessions: skipped,
      sampleCount: samples.length,
      baseline,
      presets: PRESETS,
    });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { theory?: Theory };
    const theory = body.theory;
    if (!theory || !Array.isArray(theory.conditions)) {
      return Response.json({ ok: false, error: "theory.conditions must be an array" }, { status: 400 });
    }
    const valid = new Set(LAB_FEATURES.map((f) => f.id));
    for (const c of theory.conditions as Condition[]) {
      if (!valid.has(c.feature as never)) {
        return Response.json({ ok: false, error: `unknown feature: ${c.feature}` }, { status: 400 });
      }
    }
    const { samples, dates } = await buildLabSamples();
    return Response.json({ ok: true, result: evaluateTheory(theory, samples, dates) });
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}

