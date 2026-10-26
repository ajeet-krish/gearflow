// Race engineer: explains a completed run with computed metrics fed in.
// Medium reasoning effort. Three bullets: what changed, why, what to try next.

import { validateEngineerResult } from "@/contracts/schema";
import type { ParametricSpec, RaceEngineerResult } from "@/contracts/types";
import { META_DEFAULT_SPARK_MODEL } from "./client";
import type { MetaClient } from "./client";
import { TTL_ENGINEER_MS, hashKey, type HashCache } from "./cache";

export interface RunMetrics {
    cl: number;
    cpMin: number;
    reynolds: number;
}

const ENGINEER_SYSTEM = [
    "You are a race engineer commenting on a 2D airfoil study for GearFlow.",
    "Reply with JSON only: { headline, explanation, suggestedChange, caveats }.",
    "suggestedChange follows { field, from, to, rationale, predictedEffect }.",
    "explanation has exactly 3 bullets: what changed, why it matters, what to try next.",
    "Keep the tone plain and generic. No brand or team references.",
    "caveats must note this is 2D potential flow plus a learned surrogate, not wind tunnel data.",
].join(" ");

function toEngineerResult(raw: unknown): RaceEngineerResult {
    const res = raw as RaceEngineerResult;
    validateEngineerResult(res);
    return res;
}

export async function explainRun(
    client: MetaClient,
    cache: HashCache,
    spec: ParametricSpec,
    metrics: RunMetrics
): Promise<RaceEngineerResult> {
    const key = `spark-engineer:${await hashKey({ spec, metrics })}`;
    const hit = cache.get<RaceEngineerResult>(key, { allowStale: true });
    if (hit !== null && !hit.stale) {
        client.reportCacheHit("spark-engineer", META_DEFAULT_SPARK_MODEL, key);
        return hit.value;
    }
    const user = [
        `Geometry: ${JSON.stringify(spec.geometry)}`,
        `Reynolds: ${metrics.reynolds}`,
        `Computed Cl: ${metrics.cl.toFixed(3)}, Cp min: ${metrics.cpMin.toFixed(3)}.`,
        "Explain this run and propose one change.",
    ].join("\n");
    try {
        const result = await client.chatJson("spark-engineer", ENGINEER_SYSTEM, user, toEngineerResult, {
            model: META_DEFAULT_SPARK_MODEL,
            temperature: 0.2,
            reasoningEffort: "medium",
            hash: key,
        });
        cache.set(key, result, TTL_ENGINEER_MS);
        return result;
    } catch {
        if (hit !== null) {
            client.reportCacheHit("spark-engineer", META_DEFAULT_SPARK_MODEL, key);
            return hit.value;
        }
        return {
            headline: "Offline engineer note",
            explanation: "What changed: spec held fixed. Why: Spark is offline so no fresh read. What to try next: rerun with live calls enabled.",
            suggestedChange: {
                field: "alphaDeg",
                from: spec.geometry.alphaDeg,
                to: Math.min(12, spec.geometry.alphaDeg + 1),
                rationale: "Small alpha bump is the cheapest lift check.",
                predictedEffect: "Cl rises slightly until stall onset.",
            },
            caveats: "Offline template note, not a model read. 2D potential flow only.",
        };
    }
}
