// Surrogate provider tests. Uses tiny injected weights (base 2, 8 by 8) so
// the forward pass runs in milliseconds. No network, no weights files.

import { describe, it, expect } from "vitest";
import {
    SURROGATE_IN_CH,
    SURROGATE_OUT_CH,
    buildSurrogateInput,
    decodeSurrogateOutput,
    expectedParamCount,
    sha256Hex,
    unetForward,
    validateManifest,
    SurrogateFlowProvider,
    type LoadedWeights,
    type SurrogateManifest,
} from "./surrogate";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import type { GeometrySpec, GridSpec } from "@/contracts/types";

const TINY_GRID: GridSpec = { nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN } };
const TINY_GEOM: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 12,
};

function testManifest(base: number, nx: number, ny: number): SurrogateManifest {
    return {
        version: "test-1",
        nx,
        ny,
        inCh: SURROGATE_IN_CH,
        outCh: SURROGATE_OUT_CH,
        base,
        norm: {
            sdfMean: 0, sdfStd: 1, alphaScale: 12,
            uMean: 0, uStd: 1, vMean: 0, vStd: 1, cpMean: 0, cpStd: 1,
        },
        weightsFile: "weights.bin",
        weightsSha256: "ab".repeat(32),
        paramCount: expectedParamCount(base),
    };
}

function zeroWeights(base: number, nx: number, ny: number, headBias: [number, number, number]): LoadedWeights {
    const manifest = testManifest(base, nx, ny);
    const params = new Float32Array(manifest.paramCount);
    params[params.length - 3] = headBias[0];
    params[params.length - 2] = headBias[1];
    params[params.length - 1] = headBias[2];
    return { manifest, params };
}

describe("validateManifest", () => {
    it("accepts a well formed production manifest", () => {
        expect(validateManifest(testManifest(2, 128, 128)).version).toBe("test-1");
    });

    it("asserts channel and param count shapes", () => {
        const badCh = { ...testManifest(2, 128, 128), inCh: 5 };
        expect(() => validateManifest(badCh)).toThrow();
        const badCount = { ...testManifest(2, 128, 128), paramCount: 7 };
        expect(() => validateManifest(badCount)).toThrow();
        expect(() => validateManifest(null)).toThrow();
    });

    it("caps base and pins the production grid", () => {
        expect(() => validateManifest(testManifest(0, 128, 128))).toThrow(/base/);
        expect(() => validateManifest(testManifest(65, 128, 128))).toThrow(/base/);
        expect(() => validateManifest(testManifest(2, 8, 8))).toThrow(/128/);
        expect(() => validateManifest(testManifest(2, 64, 64))).toThrow(/128/);
    });

    it("requires a non-null norm and allowlisted weights file plus sha", () => {
        expect(() => validateManifest({ ...testManifest(2, 128, 128), norm: null })).toThrow(/norm/);
        expect(() => validateManifest({ ...testManifest(2, 128, 128), weightsFile: "../evil.bin" })).toThrow(/allowlisted/);
        expect(() => validateManifest({ ...testManifest(2, 128, 128), weightsFile: "sub/dir.bin" })).toThrow(/allowlisted/);
        expect(() => validateManifest({ ...testManifest(2, 128, 128), weightsSha256: "test" })).toThrow(/64 char/);
    });
});

describe("unetForward", () => {
    it("fake runner: zero weights plus head bias give a constant field", () => {
        const weights = zeroWeights(2, 8, 8, [1, 2, 3]);
        const input = new Float32Array(8 * 8 * SURROGATE_IN_CH).fill(0.5);
        const out = unetForward(input, weights, 8, 8);
        expect(out.length).toBe(8 * 8 * SURROGATE_OUT_CH);
        for (let k = 0; k < 8 * 8; k++) {
            expect(out[k * 3]).toBeCloseTo(1, 6);
            expect(out[k * 3 + 1]).toBeCloseTo(2, 6);
            expect(out[k * 3 + 2]).toBeCloseTo(3, 6);
        }
    });

    it("rejects mismatched input and grid shapes", () => {
        const weights = zeroWeights(2, 8, 8, [0, 0, 0]);
        expect(() => unetForward(new Float32Array(10), weights, 8, 8)).toThrow();
        expect(() => unetForward(new Float32Array(8 * 8 * 3), weights, 4, 4)).toThrow();
    });

    it("throws on non-finite outputs", () => {
        const weights = zeroWeights(2, 8, 8, [Number.POSITIVE_INFINITY, 0, 0]);
        const input = new Float32Array(8 * 8 * SURROGATE_IN_CH).fill(0.5);
        expect(() => unetForward(input, weights, 8, 8)).toThrow(/non-finite/);
    });
});

describe("buildSurrogateInput and decodeSurrogateOutput", () => {
    it("encodes 3 channels and zeroes obstacle cells on decode", () => {
        const n = 8 * 8;
        const sdf = new Float32Array(n).fill(0.5);
        const obstacle = new Float32Array(n);
        obstacle[0] = 1;
        const norm = testManifest(2, 8, 8).norm;
        const input = buildSurrogateInput(sdf, obstacle, 6, 8, 8, norm);
        expect(input.length).toBe(n * 3);
        expect(input[2]).toBeCloseTo(0.5, 9);
        const raw = new Float32Array(n * 3).fill(1);
        const field = decodeSurrogateOutput(raw, obstacle, 8, 8, DEFAULT_DOMAIN, norm, 1);
        expect(field.u[0]).toBe(0);
        expect(field.p[0]).toBe(0);
        expect(field.u[1]).toBeCloseTo(1, 6);
    });
});

describe("SurrogateFlowProvider", () => {
    it("falls back to analytic when fetch fails", async () => {
        const provider = new SurrogateFlowProvider({
            grid: TINY_GRID,
            geom: TINY_GEOM,
            fetchFn: (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch,
        });
        expect(await provider.ensureLoaded()).toBe(false);
        const frame = provider.getFrame();
        expect(frame.nx).toBe(8);
        let fluid = 0;
        for (let k = 0; k < frame.u.length; k++) {
            expect(Number.isFinite(frame.u[k])).toBe(true);
            if (frame.obstacle[k] <= 0.5) fluid++;
        }
        expect(fluid).toBeGreaterThan(0);
        expect(provider.meta.backend).toBe("analytic-fallback");
    });

    it("loads from a fake fetch and serves surrogate frames", async () => {
        const weights = zeroWeights(2, 128, 128, [1, 0, 0]);
        const digest = await sha256Hex(weights.params.buffer.slice(0));
        const manifestJson = { ...weights.manifest, weightsSha256: digest };
        const fetchFn = (async (url: string) => {
            if (url.endsWith("model.json")) {
                return { ok: true, status: 200, json: async () => manifestJson, arrayBuffer: async () => new ArrayBuffer(0) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                arrayBuffer: async () => weights.params.buffer.slice(0) as ArrayBuffer,
            };
        }) as unknown as typeof fetch;
        const grid128 = { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } };
        const provider = new SurrogateFlowProvider({ grid: grid128, geom: TINY_GEOM, fetchFn });
        expect(await provider.ensureLoaded()).toBe(true);
        const frame = provider.getFrame();
        expect(provider.meta.backend).toBe("surrogate");
        expect(provider.meta.weightsVersion).toBe("test-1");
        const res = provider.getResult();
        expect(Number.isFinite(res.cl)).toBe(true);
        expect(Number.isFinite(res.cpMin)).toBe(true);
        expect(frame.u.length).toBe(128 * 128);
    });

    it("rejects tampered weights with a sha mismatch", async () => {
        const weights = zeroWeights(2, 128, 128, [1, 0, 0]);
        const tampered = new Float32Array(weights.params);
        tampered[0] += 1;
        const manifestJson = { ...weights.manifest, weightsSha256: await sha256Hex(weights.params.buffer.slice(0)) };
        const fetchFn = (async (url: string) => {
            if (url.endsWith("model.json")) {
                return { ok: true, status: 200, json: async () => manifestJson, arrayBuffer: async () => new ArrayBuffer(0) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                arrayBuffer: async () => tampered.buffer.slice(0) as ArrayBuffer,
            };
        }) as unknown as typeof fetch;
        const provider = new SurrogateFlowProvider({
            grid: { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
            geom: TINY_GEOM,
            fetchFn,
        });
        expect(await provider.ensureLoaded()).toBe(false);
        expect(provider.meta.backend).toBe("analytic-fallback");
    });

    it("rejects traversal weightsFile entries", () => {
        expect(() => validateManifest({ ...testManifest(2, 128, 128), weightsFile: "../evil.bin" })).toThrow();
        expect(() => validateManifest({ ...testManifest(2, 128, 128), weightsFile: "a/b.bin" })).toThrow();
    });

    it("rejects oversize weight buffers before typed array construction", async () => {
        const weights = zeroWeights(2, 128, 128, [0, 0, 0]);
        const manifestJson = { ...weights.manifest };
        const fetchFn = (async (url: string) => {
            if (url.endsWith("model.json")) {
                return { ok: true, status: 200, json: async () => manifestJson, arrayBuffer: async () => new ArrayBuffer(0) };
            }
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                arrayBuffer: async () => new ArrayBuffer(manifestJson.paramCount * 4 + 4),
            };
        }) as unknown as typeof fetch;
        const provider = new SurrogateFlowProvider({
            grid: { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } },
            geom: TINY_GEOM,
            fetchFn,
        });
        expect(await provider.ensureLoaded()).toBe(false);
    });

    it("serves injected weights without fetch", () => {
        const provider = new SurrogateFlowProvider({
            grid: TINY_GRID,
            geom: TINY_GEOM,
            weightsOverride: zeroWeights(2, 8, 8, [1, 0, 0]),
        });
        const frame = provider.getFrame();
        expect(provider.meta.backend).toBe("surrogate");
        expect(frame.nx).toBe(8);
    });
});
