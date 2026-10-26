// Phase 4 Meta orchestration tests. Mocked fetch only, no live network.

import { describe, expect, it, vi } from "vitest";
import { validateEngineerResult, validateParametricSpec, validateSamPolygon } from "@/contracts/schema";
import { buildPolygons } from "@/geometry/parametric";
import { HashCache } from "./cache";
import { MetaClient, MetaError } from "./client";
import { promptToSpec } from "./sparkSpec";
import { sketchToSpec } from "./samSegment";
import { createPosterSession, generatePoster } from "./poster";
import { PRESETS } from "./presets";

function chatResponse(payload: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as unknown as Response;
}

const VALID_SPEC = {
    geometry: {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 100,
    },
    reynolds: 200000,
    rationale: "Test spec.",
};

describe("schema validators", () => {
    it("rejects sam polygons outside 3 to 160 points", () => {
        expect(() => validateSamPolygon([{ x: 0, y: 0 }])).toThrow();
        expect(() => validateSamPolygon(new Array(161).fill({ x: 0.5, y: 0 })) ).toThrow();
    });
    it("rejects non finite polygon points", () => {
        expect(() => validateSamPolygon([
            { x: 0, y: 0 },
            { x: 0.5, y: NaN },
            { x: 1, y: 0 },
        ])).toThrow();
    });
    it("rejects parametric specs with out of range reynolds", () => {
        expect(() => validateParametricSpec({ ...VALID_SPEC, reynolds: 10 })).toThrow();
        expect(() => validateParametricSpec({ ...VALID_SPEC, rationale: "" })).toThrow();
    });
    it("rejects engineer results missing the change block", () => {
        expect(() => validateEngineerResult({ headline: "h", explanation: "e", caveats: "c" })).toThrow();
    });
});

describe("spark spec cache", () => {
    it("serves the cached spec on the second call", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const first = await promptToSpec(client, cache, "high lift study");
        expect(first.cached).toBe(false);
        expect(fetchFn).toHaveBeenCalledTimes(1);
        fetchFn.mockImplementation(async () => {
            throw new Error("network down");
        });
        const second = await promptToSpec(client, cache, "high lift study");
        expect(second.cached).toBe(true);
        expect(second.spec.reynolds).toBe(200000);
    });
});

describe("cache ttl", () => {
    it("expires entries and optionally serves stale", async () => {
        const cache = new HashCache(false);
        cache.set("k", { v: 1 }, -1);
        const stale = cache.get<{ v: number }>("k", { allowStale: true });
        expect(stale?.stale).toBe(true);
        expect(stale?.value.v).toBe(1);
        expect(cache.get("k")).toBeNull();
        expect(cache.size()).toBe(0);
    });
});

describe("offline gate", () => {
    it("throws a typed offline error without fetching", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ offline: true, fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const { spec } = await promptToSpec(client, cache, "anything");
        expect(fetchFn).not.toHaveBeenCalled();
        expect(spec.rationale).toContain("offline");
        await expect(
            client.chatJson("spark-spec", "sys", "user", (raw: unknown) => raw)
        ).rejects.toMatchObject({ name: "MetaError", code: "offline" });
    });
    it("marks raw client errors with MetaError codes", () => {
        const err = new MetaError("timeout", "slow", "spark-spec");
        expect(err.code).toBe("timeout");
        expect(err.feature).toBe("spark-spec");
    });
});

describe("sam bbox fallback", () => {
    it("returns a custom spec with the fallback flag when the mask is missing", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({}),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
        const { spec, sam } = await sketchToSpec(client, cache, file);
        expect(spec.kind).toBe("custom");
        expect(sam.usedFallback).toBe(true);
        expect(spec.polygon?.length ?? 0).toBeGreaterThanOrEqual(3);
    });
});

describe("poster session guard", () => {
    it("allows a single render and reuses the url after", async () => {
        let calls = 0;
        const fetchFn = vi.fn(async () => {
            calls += 1;
            return {
                ok: true,
                status: 200,
                headers: { get: () => null },
                json: async () => ({ data: [{ url: "https://example.com/poster.png" }] }),
            } as unknown as Response;
        });
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const session = createPosterSession();
        const first = await generatePoster(client, cache, PRESETS[0].spec, session);
        expect(first.cached).toBe(false);
        const second = await generatePoster(client, cache, PRESETS[0].spec, session);
        expect(second.cached).toBe(true);
        expect(second.url).toBe(first.url);
        expect(calls).toBe(1);
    });
});

describe("custom polygon geometry", () => {
    it("builds a single CCW polygon from a custom spec", () => {
        const spec = {
            kind: "custom" as const,
            chord: 1,
            alphaDeg: 0,
            nPoints: 4,
            polygon: [
                { x: 0, y: 0 },
                { x: 0.5, y: 0.06 },
                { x: 1, y: 0 },
                { x: 0.5, y: -0.06 },
            ],
        };
        const polys = buildPolygons(spec);
        expect(polys).toHaveLength(1);
        expect(polys[0].length).toBeGreaterThanOrEqual(3);
    });
});
