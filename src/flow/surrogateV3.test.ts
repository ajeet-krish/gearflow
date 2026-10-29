// v3 surrogate provider tests plus solver honesty label tests. No network:
// the provider path uses injected fetch and session doubles only.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { GeometrySpec, GridSpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    SURROGATE_V3_AUX_CH,
    SURROGATE_V3_NX,
    SURROGATE_V3_NY,
    SURROGATE_V3_OUT_CH,
    buildV3Input,
    bundleIsSyntheticV3,
    decodeV3Output,
    validateV3Manifest,
    validateV3Norm,
    SurrogateV3Provider,
    type V3Manifest,
    type V3Norm,
    type V3Session,
} from "./surrogateV3";
import {
    analyticFallbackLabel,
    frameHonestyLabel,
    honestyStateForFrame,
    lbmSolvedLabel,
    neuralPhaseAveragedLabel,
    neuralSteadyLabel,
} from "./solverRouter";

const GRID: GridSpec = { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } };
const GEOM: GeometrySpec = {
    kind: "naca4",
    naca: { code: "0012", m: 0, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 4,
    nPoints: 24,
};

function sha256Hex(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

function testNorm(): V3Norm {
    return {
        schema: "gearflow-surrogate-norm/v3",
        alphaScale: 12,
        normalization: { operator: "InstanceNormalization", groups: null, eps: 1e-5 },
        inputs: { sdf: { mean: 0, std: 1 }, logRe: { mean: 2, std: 0.5 } },
        outputs: {
            meanU: { mean: 1, std: 0.5 },
            meanV: { mean: 0, std: 0.25 },
            cp: { mean: 0, std: 1 },
            vorticity: { mean: 0, std: 2 },
            tke: { mean: -1, std: 0.5 },
            uCos: { mean: 0, std: 0.1 },
            uSin: { mean: 0, std: 0.1 },
            vCos: { mean: 0, std: 0.2 },
            vSin: { mean: 0, std: 0.2 },
        },
        aux: { strouhal: { mean: 0.2, std: 0.05 } },
        fittedOn: "synthetic-test",
    };
}

function testManifest(modelSha: string, normSha: string, provenance: unknown = { source: "synthetic", detail: "test" }): V3Manifest {
    return {
        version: "3",
        arch: "unet-v3",
        base: 8,
        inCh: 4,
        outCh: 10,
        auxCh: 3,
        nx: 128,
        ny: 128,
        opset: 18,
        harmonicCapable: true,
        files: {
            model: { path: "model.onnx", sha256: modelSha },
            norm: { path: "norm.json", sha256: normSha },
        },
        normSha256: normSha,
        runId: "test-run",
        provenance,
    };
}

function mockFetchBundle(manifest: V3Manifest, norm: V3Norm, modelBytes: Uint8Array): typeof fetch {
    return (async (url: string) => {
        if (url.endsWith("/model.json")) {
            return { ok: true, status: 200, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
        }
        if (url.endsWith("/norm.json")) {
            const text = JSON.stringify(norm);
            return {
                ok: true,
                status: 200,
                json: async () => JSON.parse(text) as unknown,
                arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
            };
        }
        if (url.endsWith("/model.onnx")) {
            const copy = modelBytes.slice();
            return {
                ok: true,
                status: 200,
                json: async () => ({}),
                arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer,
            };
        }
        return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    }) as unknown as typeof fetch;
}

describe("validateV3Manifest", () => {
    it("accepts a well formed v3 manifest", () => {
        const sha = "ab".repeat(32);
        const m = validateV3Manifest(testManifest(sha, sha));
        expect(m.version).toBe("3");
        expect(m.arch).toBe("unet-v3");
        expect(m.outCh).toBe(10);
        expect(m.auxCh).toBe(3);
    });

    it("rejects version 2 and other wrong versions", () => {
        const sha = "ab".repeat(32);
        const good = testManifest(sha, sha);
        expect(() => validateV3Manifest({ ...good, version: "2" })).toThrow(/version/);
        expect(() => validateV3Manifest({ ...good, version: "1" })).toThrow(/version/);
    });

    it("rejects wrong spatial and aux channel counts", () => {
        const sha = "ab".repeat(32);
        const good = testManifest(sha, sha);
        expect(() => validateV3Manifest({ ...good, outCh: 6 })).toThrow(/channel/);
        expect(() => validateV3Manifest({ ...good, inCh: 3 })).toThrow(/channel/);
        expect(() => validateV3Manifest({ ...good, auxCh: 2 })).toThrow(/auxCh/);
        const { auxCh: _dropped, ...withoutAux } = good as unknown as Record<string, unknown>;
        expect(_dropped).toBe(3);
        expect(() => validateV3Manifest(withoutAux)).toThrow(/auxCh/);
    });

    it("pins arch, base, grid, opset, and digests", () => {
        const sha = "ab".repeat(32);
        const good = testManifest(sha, sha);
        expect(() => validateV3Manifest({ ...good, arch: "unet-v2" })).toThrow(/arch/);
        expect(() => validateV3Manifest({ ...good, base: 16 })).toThrow(/locked/);
        expect(() => validateV3Manifest({ ...good, nx: 64 })).toThrow(/grid/);
        expect(() => validateV3Manifest({ ...good, opset: 17 })).toThrow(/opset/);
        expect(() => validateV3Manifest({ ...good, normSha256: "short" })).toThrow(/hex/);
    });
});

describe("validateV3Norm", () => {
    it("accepts the locked v3 sidecar with paired harmonic stats", () => {
        const norm = validateV3Norm(testNorm());
        expect(norm.schema).toBe("gearflow-surrogate-norm/v3");
        expect(norm.outputs.uCos.std).toBe(norm.outputs.uSin.std);
        expect(norm.outputs.vCos.std).toBe(norm.outputs.vSin.std);
        expect(norm.aux.strouhal.mean).toBe(0.2);
    });

    it("rejects the v2 schema and missing aux strouhal", () => {
        const bad = testNorm() as unknown as Record<string, unknown>;
        expect(() => validateV3Norm({ ...bad, schema: "gearflow-surrogate-norm/v2" })).toThrow(/schema/);
        const outputs = { ...(bad.outputs as Record<string, unknown>) };
        delete outputs.uCos;
        expect(() => validateV3Norm({ ...bad, outputs })).toThrow(/uCos/);
        const noAux = { ...bad, aux: {} };
        expect(() => validateV3Norm(noAux)).toThrow(/strouhal/);
    });

    it("rejects non positive std values", () => {
        const norm = testNorm();
        const bad = {
            ...norm,
            outputs: { ...norm.outputs, vSin: { mean: 0, std: 0 } },
        };
        expect(() => validateV3Norm(bad)).toThrow(/std/);
    });
});

describe("buildV3Input", () => {
    it("standardizes SDF with clipping, keeps mask identity, tiles alpha and logRe", () => {
        const n = 128 * 128;
        const sdf = new Float32Array(n).fill(10);
        const obstacle = new Float32Array(n).fill(1);
        obstacle[1] = 0;
        const norm = testNorm();
        const out = buildV3Input(sdf, obstacle, 6, 100, norm);
        expect(out.length).toBe(4 * n);
        const plane = n;
        expect(out[0]).toBeCloseTo((3 - norm.inputs.sdf.mean) / norm.inputs.sdf.std, 6);
        expect(out[plane + 0]).toBe(1);
        expect(out[plane + 1]).toBe(0);
        expect(out[2 * plane + 5]).toBeCloseTo(6 / 12, 9);
        expect(out[3 * plane + 5]).toBeCloseTo((2 - norm.inputs.logRe.mean) / norm.inputs.logRe.std, 9);
    });

    it("rejects non canonical grids, bad masks, and non positive Re", () => {
        const norm = testNorm();
        const n = 128 * 128;
        expect(() => buildV3Input(new Float32Array(10), new Float32Array(10), 0, 100, norm)).toThrow();
        const badMask = new Float32Array(n).fill(0.3);
        expect(() => buildV3Input(new Float32Array(n), badMask, 0, 100, norm)).toThrow(/mask/);
        expect(() => buildV3Input(new Float32Array(n), new Float32Array(n), 0, -5, norm)).toThrow(/Re/);
    });
});

function validRaw(n: number): { spatial: Float32Array; aux: Float32Array } {
    const spatial = new Float32Array(10 * n);
    for (let c = 0; c < n; c += 1) {
        spatial[c] = 0;
        spatial[n + c] = 0;
        spatial[2 * n + c] = 0;
        spatial[3 * n + c] = 0;
        spatial[4 * n + c] = 6;
        spatial[5 * n + c] = 0;
        spatial[6 * n + c] = 1;
        spatial[7 * n + c] = 1;
        spatial[8 * n + c] = 1;
        spatial[9 * n + c] = 1;
    }
    const aux = new Float32Array([0, 2, 2]);
    return { spatial, aux };
}

describe("decodeV3Output", () => {
    it("decodes means, exact zero harmonics, sigmoid recirc, expm1 tke, and zeroes solids", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const spatial = new Float32Array(10 * n);
        const aux = new Float32Array([0, 0, 0]);
        const obstacle = new Float32Array(n);
        obstacle[0] = 1;
        const field = decodeV3Output(spatial, aux, obstacle, norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
        expect(field.uMean?.[1]).toBeCloseTo(1, 6);
        expect(field.vMean?.[1]).toBeCloseTo(0, 6);
        expect(field.k?.[1]).toBeCloseTo(Math.max(Math.expm1(-1), 0), 9);
        expect(field.recirc?.[1]).toBeCloseTo(0.5, 9);
        expect(field.uCos?.[1]).toBe(0);
        expect(field.uSin?.[1]).toBe(0);
        expect(field.vCos?.[1]).toBe(0);
        expect(field.vSin?.[1]).toBe(0);
        expect(field.uMean?.[0]).toBe(0);
        expect(field.k?.[0]).toBe(0);
        expect(field.uCos?.[0]).toBe(0);
        expect(field.strouhalPredicted).toBeCloseTo(0.2, 9);
        expect(field.explainedPredicted).toBeCloseTo(0.5, 9);
        expect(field.harmonicValid).toBe(false);
        expect(field.harmonicInvalidReason).toMatch(/RMS/);
        expect(field.cappedCells).toBe(0);
    });

    it("marks harmonicValid true only when every gate passes", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const { spatial, aux } = validRaw(n);
        const field = decodeV3Output(spatial, aux, new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
        expect(field.harmonicValid).toBe(true);
        expect(field.harmonicInvalidReason).toBeNull();
        expect(field.strouhalPredicted).toBeCloseTo(0.2, 9);
        expect(field.explainedPredicted).toBeCloseTo(1 / (1 + Math.exp(-2)), 9);
        expect(field.validityProbability).toBeCloseTo(1 / (1 + Math.exp(-2)), 9);
    });

    it("gate table: each of the four failure reasons fires alone", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const obstacle = new Float32Array(n);
        const cases: Array<{ name: string; mutate: (spatial: Float32Array, aux: Float32Array) => void; match: RegExp }> = [
            {
                name: "validity probability",
                mutate: (_s, a) => { a[2] = -2; },
                match: /validity probability/,
            },
            {
                name: "explained",
                mutate: (_s, a) => { a[1] = -2; },
                match: /explained/,
            },
            {
                name: "strouhal range",
                mutate: (_s, a) => { a[0] = 8; },
                match: /strouhal/,
            },
            {
                name: "RMS floor",
                mutate: (s, _a) => {
                    for (let c = 0; c < n; c += 1) {
                        s[6 * n + c] = 0;
                        s[7 * n + c] = 0;
                        s[8 * n + c] = 0;
                        s[9 * n + c] = 0;
                    }
                },
                match: /RMS/,
            },
        ];
        for (const gate of cases) {
            const { spatial, aux } = validRaw(n);
            gate.mutate(spatial, aux);
            const field = decodeV3Output(spatial, aux, obstacle, norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
            expect(field.harmonicValid).toBe(false);
            expect(String(field.harmonicInvalidReason)).toMatch(gate.match);
        }
    });

    it("never throws on a failed gate, it degrades instead", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const { spatial, aux } = validRaw(n);
        aux[0] = 100;
        aux[1] = -100;
        aux[2] = -100;
        for (let c = 0; c < n; c += 1) {
            spatial[6 * n + c] = 0;
            spatial[7 * n + c] = 0;
            spatial[8 * n + c] = 0;
            spatial[9 * n + c] = 0;
        }
        let field = decodeV3Output(spatial, aux, new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
        expect(field.harmonicValid).toBe(false);
        expect(field.uMean?.length).toBe(n);
    });

    it("energy cap scales all four amplitudes by one common factor and leaves compliant cells untouched", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const spatial = new Float32Array(10 * n);
        const aux = new Float32Array([0, 2, 2]);
        for (let c = 0; c < n; c += 1) {
            spatial[4 * n + c] = 0;
            spatial[5 * n + c] = 0;
        }
        const hot = 7;
        spatial[6 * n + hot] = 1;
        spatial[7 * n + hot] = 1;
        spatial[8 * n + hot] = 1;
        spatial[9 * n + hot] = 1;
        const calm = 9;
        spatial[6 * n + calm] = 0.0001;
        spatial[7 * n + calm] = 0.0001;
        spatial[8 * n + calm] = 0.0001;
        spatial[9 * n + calm] = 0.0001;
        const field = decodeV3Output(spatial, aux, new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
        const beforeU = 1 * norm.outputs.uCos.std;
        const beforeV = 1 * norm.outputs.vCos.std;
        const ratios = [
            (field.uCos as Float32Array)[hot] / beforeU,
            (field.uSin as Float32Array)[hot] / beforeU,
            (field.vCos as Float32Array)[hot] / beforeV,
            (field.vSin as Float32Array)[hot] / beforeV,
        ];
        for (let k = 1; k < ratios.length; k += 1) {
            expect(Math.abs(ratios[k] - ratios[0]) / ratios[0]).toBeLessThan(1e-6);
        }
        expect(ratios[0]).toBeLessThan(1);
        const energy = (beforeU * beforeU + beforeU * beforeU + beforeV * beforeV + beforeV * beforeV) / 4;
        const tke = Math.max(Math.expm1(0 * norm.outputs.tke.std + norm.outputs.tke.mean), 0);
        const allowed = 1.2 * tke + 1e-4;
        expect(ratios[0]).toBeCloseTo(Math.sqrt(allowed / energy), 5);
        const calmU = new Float32Array([0.0001 * norm.outputs.uCos.std])[0];
        const calmV = new Float32Array([0.0001 * norm.outputs.vCos.std])[0];
        expect((field.uCos as Float32Array)[calm]).toBe(calmU);
        expect((field.uSin as Float32Array)[calm]).toBe(calmU);
        expect((field.vCos as Float32Array)[calm]).toBe(calmV);
        expect((field.vSin as Float32Array)[calm]).toBe(calmV);
        expect(field.cappedCells).toBe(1);
    });

    it("rejects bad shapes and non-finite heads", () => {
        const norm = testNorm();
        const n = 128 * 128;
        expect(() => decodeV3Output(new Float32Array(10), new Float32Array(3), new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1))
            .toThrow(/spatial/);
        expect(() => decodeV3Output(new Float32Array(10 * n), new Float32Array(2), new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1))
            .toThrow(/aux/);
        const bad = new Float32Array(10 * n).fill(Number.NaN);
        expect(() => decodeV3Output(bad, new Float32Array(3), new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1)).toThrow();
    });
});

describe("SurrogateV3Provider", () => {
    it("serves a decoded v3 frame from injected doubles with honest provenance", async () => {
        const n = SURROGATE_V3_NX * SURROGATE_V3_NY;
        const spatial = new Float32Array(SURROGATE_V3_OUT_CH * n);
        const aux = new Float32Array(SURROGATE_V3_AUX_CH);
        const mockSession: V3Session = {
            run: async (feeds) => {
                expect(Array.from(feeds["input"].dims)).toEqual([1, 4, 128, 128]);
                return { output: { data: spatial, dims: [1, 10, 128, 128] }, aux: { data: aux, dims: [1, 3] } };
            },
        };
        const norm = testNorm();
        const modelBytes = new Uint8Array(64).fill(1);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        const provider = new SurrogateV3Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => mockSession,
            createTensor: (data, dims) => ({ data, dims }),
            allowSynthetic: true,
        });
        await provider.load();
        expect(provider.loaded).toBe(true);
        const field = await provider.predictFrame();
        expect(field.nx).toBe(SURROGATE_V3_NX);
        expect(field.ny).toBe(SURROGATE_V3_NY);
        expect(field.uCos?.length).toBe(n);
        expect(field.vSin?.length).toBe(n);
        expect(field.strouhalPredicted).toBeCloseTo(0.2, 9);
        expect(field.harmonicValid).toBe(false);
        expect(String(field.harmonicInvalidReason)).toMatch(/RMS/);
        expect(field.cappedCells).toBe(0);
        expect(provider.getFrame()).toBe(field);
        const prov = provider.getProvenance();
        expect(prov.source).toBe("surrogate");
        expect(prov.label).toMatch(/predicted, not validated/);
        expect(prov.label).toContain("test-run");
    });

    it("rejects a bad manifest with the cause named", async () => {
        const fetchFn = (async (url: string) => {
            if (url.endsWith("/model.json")) return { ok: true, status: 200, json: async () => ({ version: "2" }), arrayBuffer: async () => new ArrayBuffer(0) };
            return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        }) as unknown as typeof fetch;
        const provider = new SurrogateV3Provider({ grid: GRID, geom: GEOM, fetchFn, allowSynthetic: true });
        await expect(provider.load()).rejects.toThrow(/bad manifest/);
    });

    it("refuses synthetic provenance unless tests opt in", async () => {
        const norm = testNorm();
        const modelBytes = new Uint8Array(256).fill(7);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        expect(bundleIsSyntheticV3(manifest, norm)).toBe(true);
        const refused = new SurrogateV3Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => ({ run: async () => ({}) }),
        });
        await expect(refused.load()).rejects.toThrow(/synthetic/);
    });
});

describe("solver honesty labels", () => {
    it("the four labels are mutually exclusive", () => {
        const solved = lbmSolvedLabel();
        const modeled = neuralPhaseAveragedLabel({ strouhal: 0.2, explained: 0.8 });
        const steady = neuralSteadyLabel("validity probability 0.1190 below 0.5");
        const analytic = analyticFallbackLabel("neural-v3 weights unavailable");
        const labels = [solved, modeled, steady, analytic];
        expect(new Set(labels).size).toBe(4);
        for (const label of labels) expect(label).toMatch(/not validated|not time averaged/);
    });

    it("the phase averaged label is modeled and never solved", () => {
        const label = neuralPhaseAveragedLabel({ strouhal: 0.2, explained: 0.8 });
        expect(label.toLowerCase()).toContain("modeled");
        expect(label.toLowerCase()).not.toContain("solved");
        expect(label).toContain("phase averaged");
    });

    it("the steady label includes the gate reason", () => {
        const reason = "strouhal 0.60 outside [0.03, 0.5]";
        const label = neuralSteadyLabel(reason);
        expect(label).toContain(reason);
        expect(label).toContain("steady predicted");
    });

    it("the analytic label is a potential preview fallback", () => {
        const label = analyticFallbackLabel("weights still loading");
        expect(label).toContain("potential");
        expect(label).toContain("preview");
        expect(label).toContain("weights still loading");
    });

    it("the dispatcher maps frames to the four states", () => {
        expect(honestyStateForFrame({ source: "lbm" })).toBe("solved");
        expect(honestyStateForFrame({ source: "neural", harmonicValid: true })).toBe("phase-averaged-modeled");
        expect(honestyStateForFrame({ source: "neural", harmonicValid: false })).toBe("steady-predicted");
        expect(honestyStateForFrame({ source: "neural" })).toBe("steady-predicted");
        expect(honestyStateForFrame({ source: "analytic" })).toBe("analytic-fallback");
        expect(frameHonestyLabel("solved")).toContain("solved");
        expect(frameHonestyLabel("phase-averaged-modeled").toLowerCase()).not.toContain("solved");
        expect(frameHonestyLabel("steady-predicted", "explained 0.10 below 0.35")).toContain("explained 0.10 below 0.35");
    });
});
