// Spark spec proposal: natural language to ParametricSpec.
// Temperature 0, low reasoning effort, JSON schema response. One repair retry
// with the validator error text, then a template fallback spec.

import { validateGeometrySpec, validateParametricSpec } from "@/contracts/schema";
import type { GeometrySpec, ParametricSpec } from "@/contracts/types";
import { META_DEFAULT_SPARK_MODEL } from "./client";
import type { MetaClient } from "./client";
import { TTL_SPARK_MS, hashKey, type HashCache } from "./cache";

const SPARK_SPEC_SYSTEM = [
    "You propose airfoil geometry for GearFlow, a 2D flow visualizer.",
    "Reply with JSON only: { geometry, reynolds, rationale }.",
    "geometry follows { kind, chord, alphaDeg, nPoints, naca?, radius?, center?, width?, height? }.",
    "Rules: kind is naca4, cylinder, block, or duct.",
    "chord is 1. alphaDeg in [-4, 12]. nPoints is an integer in [32, 160].",
    "For naca4: naca.m in [0, 0.09], naca.p in [0.2, 0.8], naca.t in [0.06, 0.18], code is 4 digits.",
    "reynolds is a number in [1000, 1000000]. rationale is one short sentence.",
    "Generic style study only, no brand or team references.",
].join(" ");

export function templateSpec(): ParametricSpec {
    const geometry: GeometrySpec = {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 100,
    };
    return { geometry, reynolds: 200000, rationale: "Template high lift study spec used when Spark is offline." };
}

function toParametricSpec(raw: unknown): ParametricSpec {
    const obj = raw as Record<string, unknown>;
    const spec: ParametricSpec = {
        geometry: obj.geometry as ParametricSpec["geometry"],
        reynolds: obj.reynolds as number,
        rationale: typeof obj.rationale === "string" ? obj.rationale : "Spark proposed spec.",
    };
    validateParametricSpec(spec);
    validateGeometrySpec(spec.geometry);
    return spec;
}

export async function promptToSpec(
    client: MetaClient,
    cache: HashCache,
    text: string
): Promise<{ spec: ParametricSpec; cached: boolean }> {
    const key = `spark-spec:${await hashKey({ text })}`;
    const hit = cache.get<ParametricSpec>(key, { allowStale: true });
    if (hit !== null && !hit.stale) {
        client.reportCacheHit("spark-spec", META_DEFAULT_SPARK_MODEL, key);
        return { spec: hit.value, cached: true };
    }
    const stale = hit !== null ? hit.value : null;
    const user = `Design point in plain words: ${text}`;
    try {
        const first = await client.chatJson("spark-spec", SPARK_SPEC_SYSTEM, user, toParametricSpec, {
            model: META_DEFAULT_SPARK_MODEL,
            temperature: 0,
            reasoningEffort: "low",
            hash: key,
        });
        cache.set(key, first, TTL_SPARK_MS);
        return { spec: first, cached: false };
    } catch (firstError) {
        if (stale !== null) {
            client.reportCacheHit("spark-spec", META_DEFAULT_SPARK_MODEL, key);
            return { spec: stale, cached: true };
        }
        const reason = firstError instanceof Error ? firstError.message : String(firstError);
        if (reason.includes("offline")) {
            const fallback = templateSpec();
            return { spec: fallback, cached: false };
        }
        try {
            const repaired = await client.chatJson(
                "spark-spec-repair",
                SPARK_SPEC_SYSTEM,
                `${user}\nPrevious reply was rejected: ${reason}. Reply with corrected JSON only.`,
                toParametricSpec,
                { model: META_DEFAULT_SPARK_MODEL, temperature: 0, reasoningEffort: "low", hash: key }
            );
            cache.set(key, repaired, TTL_SPARK_MS);
            return { spec: repaired, cached: false };
        } catch {
            if (stale !== null) {
                client.reportCacheHit("spark-spec", META_DEFAULT_SPARK_MODEL, key);
                return { spec: stale, cached: true };
            }
            return { spec: templateSpec(), cached: false };
        }
    }
}
