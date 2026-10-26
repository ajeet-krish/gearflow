// Phase 4 hardening: Meta orchestration edge plus error coverage.
// Mocked fetch only, no live network. Commas and colons only in copy.

import { describe, expect, it, vi } from "vitest";
import {
    RE_MAX,
    RE_MIN,
    validateParametricSpec,
    validateSamPolygon,
} from "@/contracts/schema";
import { HashCache, TTL_SAM_MS, TTL_SPARK_MS } from "@/meta/cache";
import { MetaClient } from "@/meta/client";
import { loadOfflinePack } from "@/meta/offlinePack";
import { createPosterSession, generatePoster, posterPrompt } from "@/meta/poster";
import { PRESETS } from "@/meta/presets";
import { promptToSpec, templateSpec } from "@/meta/sparkSpec";
import { explainRun } from "@/meta/sparkEngineer";
import { sketchToSpec } from "@/meta/samSegment";
import { bboxFallbackPolygon, maskIou, maskToPolygon } from "@/meta/samMask";
import type { ParametricSpec } from "@/contracts/types";

function chatResponse(payload: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    } as unknown as Response;
}

function imageResponse(url: string): Response {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ data: [{ url }] }),
    } as unknown as Response;
}

const VALID_SPEC: ParametricSpec = {
    geometry: {
        kind: "naca4",
        naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
        chord: 1,
        alphaDeg: 6,
        nPoints: 100,
    },
    reynolds: 200000,
    rationale: "Hardening probe spec.",
};

const VALID_ENGINEER = {
    headline: "Camber carries the lift",
    explanation: "What changed: alpha held at 6. Why: camber adds circulation. What to try next: thin the section.",
    suggestedChange: {
        field: "alphaDeg",
        from: 6,
        to: 7,
        rationale: "Cheap lift check.",
        predictedEffect: "Cl rises slightly.",
    },
    caveats: "2D potential flow only, not wind tunnel data.",
};

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            mask[y * w + x] = 1;
        }
    }
    return mask;
}

describe("happy path: spark spec parse plus validate", () => {
    it("parses a valid Spark payload into a ParametricSpec", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const { spec, cached } = await promptToSpec(client, cache, "high lift study");
        expect(cached).toBe(false);
        expect(spec.reynolds).toBe(200000);
        expect(spec.geometry.kind).toBe("naca4");
        expect(() => validateParametricSpec(spec)).not.toThrow();
    });
    it("template spec validates and sits inside the solver envelope", () => {
        const spec = templateSpec();
        expect(() => validateParametricSpec(spec)).not.toThrow();
        expect(spec.geometry.alphaDeg).toBeGreaterThanOrEqual(-4);
        expect(spec.geometry.alphaDeg).toBeLessThanOrEqual(12);
        expect(spec.reynolds).toBeGreaterThanOrEqual(RE_MIN);
        expect(spec.reynolds).toBeLessThanOrEqual(RE_MAX);
    });
});

describe("happy path: sam mask to polygon", () => {
    it("traces a filled rectangle into a capped chord normalized polygon", () => {
        const polygon = maskToPolygon(rectMask(64, 32, 10, 10, 50, 22), 64, 32);
        expect(polygon.length).toBeGreaterThanOrEqual(3);
        expect(polygon.length).toBeLessThanOrEqual(120);
        expect(() => validateSamPolygon(polygon)).not.toThrow();
        for (const pt of polygon) {
            expect(Number.isFinite(pt.x)).toBe(true);
            expect(Number.isFinite(pt.y)).toBe(true);
        }
    });
    it("scores mask IoU 1 for identical masks", () => {
        const a = rectMask(16, 16, 2, 2, 8, 8);
        expect(maskIou(a, Uint8Array.from(a))).toBe(1);
    });
});

describe("happy path: cache hit", () => {
    it("serves the second identical Spark prompt from cache with no fetch", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const first = await promptToSpec(client, cache, "high lift study");
        expect(first.cached).toBe(false);
        fetchFn.mockImplementation(async () => {
            throw new Error("network down");
        });
        const second = await promptToSpec(client, cache, "high lift study");
        expect(second.cached).toBe(true);
        expect(second.spec.reynolds).toBe(200000);
    });
    it("distinct prompts hash to distinct cache entries", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        await promptToSpec(client, cache, "prompt A");
        await promptToSpec(client, cache, "prompt B");
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(cache.size()).toBe(2);
    });
});

describe("happy path: offline pack load", () => {
    const packCases = [
        {
            id: "monaco-style",
            label: "Monaco style proxy",
            spec: VALID_SPEC,
            sparkPrompt: "High downforce style proxy.",
            engineer: VALID_ENGINEER,
            samPolygon: [
                { x: 0, y: 0 },
                { x: 0.25, y: 0.05 },
                { x: 0.75, y: 0.03 },
                { x: 1, y: 0 },
                { x: 0.75, y: -0.03 },
                { x: 0.25, y: -0.05 },
            ],
            poster: "/offline-pack/poster-monaco-style.svg",
        },
    ];
    it("loads and validates every offline case", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            json: async () => ({ cases: packCases }),
        } as unknown as Response));
        const cases = await loadOfflinePack("/offline-pack/index.json", fetchFn as unknown as typeof fetch);
        expect(cases).toHaveLength(1);
        expect(cases[0].id).toBe("monaco-style");
        expect(() => validateParametricSpec(cases[0].spec)).not.toThrow();
        expect(() => validateSamPolygon(cases[0].samPolygon)).not.toThrow();
    });
});

describe("edge: cache ttl expiry", () => {
    it("expires entries after the ttl and serves stale only on request", () => {
        const cache = new HashCache(false);
        cache.set("k", { v: 1 }, -1);
        const stale = cache.get<{ v: number }>("k", { allowStale: true });
        expect(stale?.stale).toBe(true);
        expect(stale?.value.v).toBe(1);
        expect(cache.get("k")).toBeNull();
        expect(cache.size()).toBe(0);
    });
    it("keeps fresh entries fresh up to the Spark ttl", () => {
        const cache = new HashCache(false);
        cache.set("fresh", { v: 2 }, TTL_SPARK_MS);
        const hit = cache.get<{ v: number }>("fresh", { allowStale: true });
        expect(hit?.stale).toBe(false);
        expect(hit?.value.v).toBe(2);
    });
    it("serves stale Spark spec when the network fails mid session", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        await promptToSpec(client, cache, "stale probe");
        expect(cache.size()).toBe(1);
        const keys = (cache as unknown as { memory: Map<string, unknown> }).memory.keys();
        const key = [...keys][0];
        const record = (cache as unknown as { memory: Map<string, { value: unknown; expiresAt: number }> }).memory.get(key)!;
        record.expiresAt = Date.now() - 1;
        fetchFn.mockImplementation(async () => {
            throw new Error("network down");
        });
        const retry = await promptToSpec(client, cache, "stale probe");
        expect(retry.cached).toBe(true);
        expect(retry.spec.reynolds).toBe(200000);
    });
    it("sam ttl spans 7 days", () => {
        expect(TTL_SAM_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });
});

describe("edge: bbox fallback", () => {
    it("returns a 6 point proxy when the SAM payload has no mask", async () => {
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
        expect(spec.polygon).toHaveLength(6);
        expect(sam.maskIou).toBe(0);
    });
    it("honors an explicit bbox in the fallback polygon", () => {
        const polygon = bboxFallbackPolygon(256, 256, { x0: 10, y0: 100, x1: 200, y1: 156 });
        expect(polygon).toHaveLength(6);
        expect(() => validateSamPolygon(polygon)).not.toThrow();
    });
    it("falls back when the SAM mask dimensions mismatch the payload", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ mask: [1, 1, 1], width: 64, height: 64, iou: 0.9, confidence: 0.8 }),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array([9, 9, 9])], { type: "image/png" });
        const { sam } = await sketchToSpec(client, cache, file);
        expect(sam.usedFallback).toBe(true);
    });
});

describe("edge: poster session guard", () => {
    it("allows a single render and reuses the url after", async () => {
        let calls = 0;
        const fetchFn = vi.fn(async () => {
            calls += 1;
            return imageResponse("https://example.com/poster.png");
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
    it("refuses a second render once the session url is lost", async () => {
        const fetchFn = vi.fn(async () => imageResponse("https://example.com/x.png"));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const session = createPosterSession();
        session.used = true;
        session.url = null;
        await expect(generatePoster(client, cache, PRESETS[0].spec, session)).rejects.toThrow(
            "already used one render"
        );
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("poster prompt labels the spec without brand marks", () => {
        const prompt = posterPrompt(PRESETS[0].spec);
        expect(prompt).toContain("NACA");
        expect(prompt.toLowerCase()).not.toContain("livery");
        expect(prompt).not.toContain("Logo");
    });
});

describe("edge: presets apply", () => {
    it("ships two local presets with valid specs and no network", async () => {
        expect(PRESETS).toHaveLength(2);
        const ids = PRESETS.map((p) => p.id);
        expect(new Set(ids).size).toBe(2);
        for (const preset of PRESETS) {
            expect(() => validateParametricSpec(preset.spec)).not.toThrow();
            expect(preset.note.toLowerCase()).toContain("not a car model");
        }
    });
    it("preset specs sit inside the slider envelope", () => {
        for (const preset of PRESETS) {
            const g = preset.spec.geometry;
            expect(g.alphaDeg).toBeGreaterThanOrEqual(-4);
            expect(g.alphaDeg).toBeLessThanOrEqual(12);
            expect(preset.spec.reynolds).toBeGreaterThanOrEqual(1000);
            expect(preset.spec.reynolds).toBeLessThanOrEqual(1000000);
        }
    });
});

describe("error: schema reject", () => {
    it("rejects out of range Reynolds numbers", () => {
        for (const reynolds of [10, 999, 1000001, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(() => validateParametricSpec({ ...VALID_SPEC, reynolds })).toThrow();
        }
    });
    it("rejects empty rationale and unknown geometry kind", () => {
        expect(() => validateParametricSpec({ ...VALID_SPEC, rationale: "" })).toThrow();
        expect(() =>
            validateParametricSpec({
                ...VALID_SPEC,
                geometry: { ...VALID_SPEC.geometry, kind: "wing" },
            })
        ).toThrow();
    });
    it("rejects sam polygons outside 3 to 160 points or with non finite coords", () => {
        expect(() => validateSamPolygon([{ x: 0, y: 0 }])).toThrow();
        expect(() => validateSamPolygon(new Array(161).fill({ x: 0.5, y: 0 }))).toThrow();
        expect(() =>
            validateSamPolygon([
                { x: 0, y: 0 },
                { x: 0.5, y: Number.NaN },
                { x: 1, y: 0 },
            ])
        ).toThrow();
    });
    it("repairs once after a schema failure, then falls back to the template", async () => {
        const bad = { ...VALID_SPEC, reynolds: 10 };
        const fetchFn = vi.fn(async () => chatResponse(bad));
        fetchFn.mockImplementationOnce(async () => chatResponse(bad));
        fetchFn.mockImplementationOnce(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const repaired = await promptToSpec(client, cache, "repair probe");
        expect(repaired.spec.reynolds).toBe(200000);
        const alwaysBad = vi.fn(async () => chatResponse(bad));
        const badClient = new MetaClient({ fetchFn: alwaysBad as unknown as typeof fetch });
        const badCache = new HashCache(false);
        const fallback = await promptToSpec(badClient, badCache, "fallback probe");
        expect(fallback.spec.reynolds).toBe(templateSpec().reynolds);
    });
});

describe("error: offline mode performs no fetch", () => {
    it("serves the template spec offline without touching fetch", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ offline: true, fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const { spec, cached } = await promptToSpec(client, cache, "anything");
        expect(fetchFn).not.toHaveBeenCalled();
        expect(spec.rationale.toLowerCase()).toContain("offline");
        expect(cached).toBe(false);
    });
    it("throws typed offline errors on direct chat and segment calls", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({ offline: true, fetchFn: fetchFn as unknown as typeof fetch });
        await expect(
            client.chatJson("spark-spec", "sys", "user", (raw: unknown) => raw)
        ).rejects.toMatchObject({ name: "MetaError", code: "offline" });
        await expect(client.segment(new ArrayBuffer(8))).rejects.toMatchObject({ code: "offline" });
        await expect(client.image("poster prompt")).rejects.toMatchObject({ code: "offline" });
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("engineer explains offline with a template note and no fetch", async () => {
        const fetchFn = vi.fn(async () => chatResponse(VALID_ENGINEER));
        const client = new MetaClient({ offline: true, fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const result = await explainRun(
            client,
            cache,
            VALID_SPEC,
            { cl: 0.9, cpMin: -2.4, reynolds: 200000 }
        );
        expect(fetchFn).not.toHaveBeenCalled();
        expect(result.headline.toLowerCase()).toContain("offline");
    });
});

describe("error: sam empty mask", () => {
    it("maps an all zero mask to the 6 point proxy, not a throw", () => {
        const polygon = maskToPolygon(new Uint8Array(64 * 32), 64, 32);
        expect(polygon).toHaveLength(6);
        expect(() => validateSamPolygon(polygon)).not.toThrow();
    });
    it("treats a sketch with an empty SAM mask as a fallback polygon", async () => {
        const w = 32;
        const h = 32;
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ mask: Array(w * h).fill(0), width: w, height: h, iou: 0.1, confidence: 0.2 }),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array([5, 6, 7])], { type: "image/png" });
        const { spec, sam } = await sketchToSpec(client, cache, file);
        expect(spec.polygon).toHaveLength(6);
        expect(sam.maskIou).toBe(0.1);
    });
});

describe("error: bad reynolds", () => {
    it("rejects Reynolds numbers below 1000 and above 1000000", () => {
        expect(() => validateParametricSpec({ ...VALID_SPEC, reynolds: 500 })).toThrow();
        expect(() => validateParametricSpec({ ...VALID_SPEC, reynolds: 2000000 })).toThrow();
    });
});

describe("error: oversized upload", () => {
    it("rejects masks with mismatched length and tiny dims", () => {
        expect(() => maskToPolygon(new Uint8Array(10), 4, 4)).toThrow();
        expect(() => maskToPolygon(new Uint8Array(9), 3, 3)).toThrow();
        expect(() => maskToPolygon("nope" as unknown as Uint8Array, 16, 16)).toThrow();
    });
    it("rejects oversized polygons beyond the 160 point cap", () => {
        const big = Array.from({ length: 200 }, (_, i) => ({ x: i / 199, y: 0 }));
        expect(() => validateSamPolygon(big)).toThrow();
    });
    it("falls back to bbox when the SAM mask payload is corrupt", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({ mask: [1, 0], width: 64, height: 64 }),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array(64)], { type: "image/png" });
        const { sam } = await sketchToSpec(client, cache, file);
        expect(sam.usedFallback).toBe(true);
        expect(sam.confidence).toBe(0.2);
    });
    it("empty mask pair scores IoU 1 instead of dividing by zero", () => {
        expect(maskIou(new Uint8Array(8), new Uint8Array(8))).toBe(1);
    });
});

describe("error: offline pack load failures", () => {
    it("throws when the index is missing", async () => {
        const fetchFn = vi.fn(async () => ({ ok: false, status: 404 } as unknown as Response));
        await expect(
            loadOfflinePack("/offline-pack/index.json", fetchFn as unknown as typeof fetch)
        ).rejects.toThrow("missing");
    });
    it("throws when the pack has no cases", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            json: async () => ({ cases: [] }),
        } as unknown as Response));
        await expect(
            loadOfflinePack("/offline-pack/index.json", fetchFn as unknown as typeof fetch)
        ).rejects.toThrow("no cases");
    });
    it("throws when a case fails validation", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true,
            json: async () => ({ cases: [{ id: "", label: "", spec: VALID_SPEC }] }),
        } as unknown as Response));
        await expect(
            loadOfflinePack("/offline-pack/index.json", fetchFn as unknown as typeof fetch)
        ).rejects.toThrow();
    });
});
