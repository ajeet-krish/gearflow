// Phase 4 review fixes: proxy gate, eval hash plus cached events, SAM cache
// and validation, custom Kutta Cl, offline pack asset, cache caps, poster
// URL validation, schema magnitude and string caps. Mocked fetch only.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
    isAllowedMetaRequest,
    hasDotSegment,
    isSameOriginRequest,
    ProxyRateLimiter,
} from "@/meta/proxyGate";
import { HashCache, MAX_CACHE_ENTRIES, hashBytes } from "@/meta/cache";
import { MetaClient } from "@/meta/client";
import { extractImageUrl } from "@/meta/client";
import { g_evalLog } from "@/meta/evalLog";
import { promptToSpec } from "@/meta/sparkSpec";
import { sketchToSpec } from "@/meta/samSegment";
import { isAllowedIndexUrl, loadOfflinePack, OFFLINE_PACK_INDEX } from "@/meta/offlinePack";
import { generateAnalyticFlow, isClosedAirfoil } from "@/flow/analyticFlow";
import { validateEngineerResult, validateGeometrySpec, validateParametricSpec, validateSamPolygon } from "@/contracts/schema";
import { DEFAULT_GRID } from "@/contracts/types";

function chatResponse(payload: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
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
    rationale: "Hardening probe spec.",
};

describe("proxy gate: allowlist, method, dot segments, same origin, rate limit", () => {
    it("allows only POST to the three paths", () => {
        expect(isAllowedMetaRequest("POST", "/api/meta/chat/completions")).toBe(true);
        expect(isAllowedMetaRequest("POST", "/api/meta/sam/segment")).toBe(true);
        expect(isAllowedMetaRequest("POST", "/api/meta/images/generations")).toBe(true);
        expect(isAllowedMetaRequest("GET", "/api/meta/chat/completions")).toBe(false);
        expect(isAllowedMetaRequest("POST", "/api/meta/admin/keys")).toBe(false);
        expect(isAllowedMetaRequest("POST", "/api/meta/chat/completions/extra")).toBe(false);
    });
    it("rejects dot segments", () => {
        expect(hasDotSegment("/chat/completions")).toBe(false);
        expect(hasDotSegment("/../chat/completions")).toBe(true);
        expect(isAllowedMetaRequest("POST", "/api/meta/../chat/completions")).toBe(false);
    });
    it("requires same origin when Origin or Referer is present", () => {
        expect(isSameOriginRequest({ origin: "http://localhost:5173" }, "localhost:5173")).toBe(true);
        expect(isSameOriginRequest({ origin: "https://evil.example" }, "localhost:5173")).toBe(false);
        expect(isSameOriginRequest({ referer: "http://localhost:5173/app" }, "localhost:5173")).toBe(true);
        expect(isSameOriginRequest({ referer: "https://evil.example/app" }, "localhost:5173")).toBe(false);
        expect(isSameOriginRequest({}, "localhost:5173")).toBe(true);
    });
    it("rate limits per IP", () => {
        const limiter = new ProxyRateLimiter(2, 60_000);
        expect(limiter.allow("1.2.3.4")).toBe(true);
        expect(limiter.allow("1.2.3.4")).toBe(true);
        expect(limiter.allow("1.2.3.4")).toBe(false);
        expect(limiter.allow("5.6.7.8")).toBe(true);
    });
});

describe("eval log: verbatim hash plus cached events at the cache layer", () => {
    it("stores payload.hash verbatim", async () => {
        g_evalLog.clear();
        await g_evalLog.add({
            feature: "spark-spec", model: "m", latencyMs: 5, costUsd: 0,
            costEstimated: true, cached: true, ok: true, fallback: "cache", hash: "abc123",
        });
        const entries = g_evalLog.list();
        expect(entries).toHaveLength(1);
        expect(entries[0].hash).toBe("abc123");
        expect(entries[0].cached).toBe(true);
        g_evalLog.clear();
    });
    it("logs a cached eval event with the same hash on the second Spark call", async () => {
        const seen: Array<{ cached: boolean; hash: string }> = [];
        const fetchFn = vi.fn(async () => chatResponse(VALID_SPEC));
        const client = new MetaClient({
            fetchFn: fetchFn as unknown as typeof fetch,
            onEval: (p) => {
                seen.push({ cached: p.cached, hash: p.hash });
            },
        });
        const cache = new HashCache(false);
        await promptToSpec(client, cache, "cache hit logging probe");
        const firstHash = seen[seen.length - 1].hash;
        expect(seen[seen.length - 1].cached).toBe(false);
        fetchFn.mockImplementation(async () => {
            throw new Error("network down");
        });
        const second = await promptToSpec(client, cache, "cache hit logging probe");
        expect(second.cached).toBe(true);
        expect(seen[seen.length - 1].cached).toBe(true);
        expect(seen[seen.length - 1].hash).toBe(firstHash);
    });
});

describe("sam: full byte hash, no fallback caching, strict payload validation", () => {
    it("hashes full bytes so same prefix tails do not collide", async () => {
        const a = new Uint8Array(2048).fill(7);
        const b = new Uint8Array(2048).fill(7);
        b[1500] = 8;
        expect(await hashBytes(a)).not.toBe(await hashBytes(b));
    });
    it("does not cache fallback results", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
        await sketchToSpec(client, cache, file);
        await sketchToSpec(client, cache, file);
        expect(cache.size()).toBe(0);
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });
    it("rejects oversize sketches and non image MIME before arrayBuffer", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const big = new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" });
        await expect(sketchToSpec(client, cache, big)).rejects.toThrow(/5 MiB/);
        const text = new Blob(["hello"], { type: "text/plain" });
        await expect(sketchToSpec(client, cache, text)).rejects.toThrow(/PNG or JPEG/);
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it("validates fallback polygons and clamps iou and confidence to [0, 1]", async () => {
        const fetchFn = vi.fn(async () => ({
            ok: true, status: 200, headers: { get: () => null },
            json: async () => ({ width: 64, height: 64, iou: Number.NaN, confidence: 99, bbox: { x0: NaN, y0: 0, x1: 10, y1: 10 } }),
        } as unknown as Response));
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch });
        const cache = new HashCache(false);
        const file = new Blob([new Uint8Array([5])], { type: "image/png" });
        const { sam } = await sketchToSpec(client, cache, file);
        expect(sam.usedFallback).toBe(true);
        expect(() => validateSamPolygon(sam.polygon)).not.toThrow();
        expect(sam.maskIou).toBeGreaterThanOrEqual(0);
        expect(sam.maskIou).toBeLessThanOrEqual(1);
        expect(sam.confidence).toBeGreaterThanOrEqual(0);
        expect(sam.confidence).toBeLessThanOrEqual(1);
    });
    it("classifies AbortError as timeout in segment", async () => {
        const abort = new DOMException("aborted", "AbortError");
        const fetchFn = vi.fn(async () => {
            throw abort;
        });
        const client = new MetaClient({ fetchFn: fetchFn as unknown as typeof fetch, maxRetries: 0 });
        await expect(client.segment(new ArrayBuffer(8))).rejects.toMatchObject({ code: "timeout" });
    });
});

describe("custom airfoil: Kutta lift plus solved field Cl", () => {
    it("detects closed airfoil polygons", () => {
        expect(isClosedAirfoil([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(false);
        expect(
            isClosedAirfoil([
                { x: 0, y: 0 },
                { x: 0.5, y: 0.06 },
                { x: 1, y: 0 },
                { x: 0.5, y: -0.06 },
            ])
        ).toBe(true);
    });
    it("solves a custom SAM polygon with positive Cl at positive alpha", () => {
        const custom = {
            kind: "custom" as const,
            chord: 1,
            alphaDeg: 6,
            nPoints: 6,
            polygon: [
                { x: 0, y: 0 },
                { x: 0.25, y: 0.05 },
                { x: 0.75, y: 0.03 },
                { x: 1, y: 0 },
                { x: 0.75, y: -0.03 },
                { x: 0.25, y: -0.05 },
            ],
        };
        const r = generateAnalyticFlow(DEFAULT_GRID, custom);
        for (const v of r.field.u) expect(Number.isFinite(v)).toBe(true);
        expect(r.cl).toBeGreaterThan(0.2);
    });
});

describe("offline pack: bundled asset, allowlist, caps, fetch disabled", () => {
    it("rejects non allowlisted index urls", () => {
        expect(isAllowedIndexUrl(OFFLINE_PACK_INDEX)).toBe(true);
        expect(isAllowedIndexUrl("/offline-pack/custom.json")).toBe(true);
        expect(isAllowedIndexUrl("https://evil.example/pack.json")).toBe(false);
        expect(isAllowedIndexUrl("/offline-pack/../secret.json")).toBe(false);
        expect(isAllowedIndexUrl("/other/pack.json")).toBe(false);
    });
    it("loads the shipped index.json with a fetch that reads the bundled file", async () => {
        const root = process.cwd();
        const raw = readFileSync(join(root, "public", "offline-pack", "index.json"), "utf8");
        const fetchFn = vi.fn(async (url: string) => {
            expect(url).toBe(OFFLINE_PACK_INDEX);
            return { ok: true, json: async () => JSON.parse(raw) } as unknown as Response;
        });
        const cases = await loadOfflinePack(OFFLINE_PACK_INDEX, fetchFn as unknown as typeof fetch);
        expect(cases.length).toBeGreaterThanOrEqual(2);
        for (const c of cases) {
            expect(() => validateParametricSpec(c.spec)).not.toThrow();
            expect(() => validateSamPolygon(c.samPolygon)).not.toThrow();
        }
    });
    it("serves the shipped pack with fetch disabled (throws on any fetch)", async () => {
        const root = process.cwd();
        const raw = readFileSync(join(root, "public", "offline-pack", "index.json"), "utf8");
        const parsed = JSON.parse(raw) as { cases: unknown[] };
        const noFetch = async (): Promise<Response> => {
            throw new Error("fetch disabled in offline integration test");
        };
        const localFetch = async () => ({ ok: true, json: async () => parsed }) as unknown as Response;
        void noFetch;
        const cases = await loadOfflinePack(OFFLINE_PACK_INDEX, localFetch as unknown as typeof fetch);
        expect(cases.length).toBe(2);
        expect(cases[0].poster).toMatch(/^\/offline-pack\//);
    });
    it("rejects oversized packs and non asset posters", async () => {
        const many = { cases: new Array(17).fill(null) };
        const fetchMany = async () => ({ ok: true, json: async () => many }) as unknown as Response;
        await expect(loadOfflinePack(OFFLINE_PACK_INDEX, fetchMany as unknown as typeof fetch)).rejects.toThrow(/cap/);
    });
});

describe("cache: LRU cap, expiry purge, persist cap, namespaced clear", () => {
    it("caps entries at 100 with LRU eviction", () => {
        const cache = new HashCache(false);
        for (let i = 0; i < 120; i++) cache.set(`k${i}`, i, 60_000);
        expect(cache.size()).toBeLessThanOrEqual(MAX_CACHE_ENTRIES);
        expect(cache.get("k0")).toBeNull();
        expect(cache.get("k119")).not.toBeNull();
    });
    it("deletes expired entries on get instead of resurrecting them", () => {
        const cache = new HashCache(false);
        cache.set("gone", { v: 1 }, -1);
        expect(cache.get("gone")).toBeNull();
        expect(cache.size()).toBe(0);
    });
});

describe("poster url: allowlist https and sized png base64", () => {
    it("accepts https urls and rejects other schemes", () => {
        expect(extractImageUrl({ data: [{ url: "https://example.com/p.png" }] })).toBe("https://example.com/p.png");
        expect(extractImageUrl({ data: [{ url: "http://example.com/p.png" }] })).toBeNull();
        expect(extractImageUrl({ data: [{ url: "javascript:alert(1)" }] })).toBeNull();
    });
    it("accepts clean png base64 and rejects dirty or oversized payloads", () => {
        const clean = btoa("poster-bytes");
        expect(extractImageUrl({ data: [{ b64_json: clean }] })).toBe(`data:image/png;base64,${clean}`);
        expect(extractImageUrl({ data: [{ b64_json: "not base64!!" }] })).toBeNull();
        expect(extractImageUrl({ data: [{ b64_json: "a".repeat(8_000_000) }] })).toBeNull();
    });
});

describe("schema: magnitude and string caps for provider payloads", () => {
    it("enforces chord 1 and bounded magnitudes", () => {
        const base = { kind: "naca4" as const, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 60 };
        expect(() => validateGeometrySpec({ ...base, chord: 2 })).toThrow(/chord/);
        expect(() => validateGeometrySpec({ kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 8, radius: 2 })).toThrow(/radius/);
        expect(() => validateGeometrySpec({ ...base, center: { x: 50, y: 0 } })).toThrow(/center/);
        expect(() =>
            validateSamPolygon([
                { x: 0, y: 0 },
                { x: 0.5, y: 5 },
                { x: 1, y: 0 },
            ])
        ).toThrow(/y/);
    });
    it("caps Spark nPoints and provider strings", () => {
        const over = {
            ...VALID_SPEC,
            geometry: { ...VALID_SPEC.geometry, nPoints: 200 },
        };
        expect(() => validateParametricSpec(over)).toThrow(/nPoints/);
        expect(() => validateParametricSpec({ ...VALID_SPEC, rationale: "x".repeat(501) })).toThrow(/rationale/);
        expect(() =>
            validateEngineerResult({
                headline: "h",
                explanation: "e".repeat(2001),
                suggestedChange: { field: "alphaDeg", from: 6, to: 7, rationale: "r", predictedEffect: "p" },
                caveats: "c",
            })
        ).toThrow(/explanation/);
    });
});
