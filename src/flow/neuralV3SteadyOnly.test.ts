// Steady-only cut tests: manifest harmonicCapable validation, provider and
// adapter threading, and the street plus phase gates. No network, no
// workers, no live solves.

import { describe, expect, it } from "vitest";
import type { FlowField, GeometrySpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    validateV3Manifest,
    SurrogateV3Provider,
    type V3Manifest,
    type V3Norm,
} from "./surrogateV3";
import { NeuralV3Adapter } from "./neuralV3Adapter";
import { shouldAnimateStreet } from "./streetLoop";
import { reconstructAtPhase } from "./phaseReconstruction";

const SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 24,
};

function baseField(): FlowField {
    const nx = 8;
    const ny = 8;
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n).fill(0),
        p: new Float32Array(n).fill(0),
        omega: new Float32Array(n).fill(0),
        obstacle: new Float32Array(n).fill(0),
        uMean: new Float32Array(n).fill(1),
        vMean: new Float32Array(n).fill(0),
        uCos: new Float32Array(n).fill(0.05),
        uSin: new Float32Array(n).fill(0.02),
        vCos: new Float32Array(n).fill(-0.01),
        vSin: new Float32Array(n).fill(0.03),
        strouhalPredicted: 0.2,
        explainedPredicted: 0.8,
        harmonicValid: true,
        harmonicInvalidReason: null,
        validityProbability: 0.9,
        cappedCells: 0,
    };
}

function manifestWith(capable: unknown): Record<string, unknown> {
    const sha = "ab".repeat(32);
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
        harmonicCapable: capable,
        files: {
            model: { path: "model.onnx", sha256: sha },
            norm: { path: "norm.json", sha256: sha },
        },
        normSha256: sha,
        runId: "test-run",
    };
}

describe("v3 manifest harmonicCapable", () => {
    it("accepts true and false", () => {
        expect(validateV3Manifest(manifestWith(true)).harmonicCapable).toBe(true);
        expect(validateV3Manifest(manifestWith(false)).harmonicCapable).toBe(false);
    });

    it("rejects a missing or non-boolean flag", () => {
        const { harmonicCapable: _drop, ...without } = manifestWith(true);
        expect(_drop).toBe(true);
        expect(() => validateV3Manifest(without)).toThrow(/harmonicCapable/);
        expect(() => validateV3Manifest(manifestWith("yes"))).toThrow(/harmonicCapable/);
        expect(() => validateV3Manifest(manifestWith(1))).toThrow(/harmonicCapable/);
    });
});

describe("provider harmonicCapable threading", () => {
    it("is false before load and reflects the manifest after load", async () => {
        const { createHash } = await import("node:crypto");
        const norm: V3Norm = {
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
            fittedOn: "test",
        };
        const modelBytes = new Uint8Array(64).fill(1);
        const normSha = createHash("sha256").update(JSON.stringify(norm)).digest("hex");
        const modelSha = createHash("sha256").update(modelBytes).digest("hex");
        const fetchFor = (capable: boolean): typeof fetch => (async (url: string) => {
            if (url.endsWith("/model.json")) {
                return { ok: true, status: 200, json: async () => ({ ...manifestWith(capable), files: { model: { path: "model.onnx", sha256: modelSha }, norm: { path: "norm.json", sha256: normSha } }, normSha256: normSha }), arrayBuffer: async () => new ArrayBuffer(0) };
            }
            if (url.endsWith("/norm.json")) {
                const text = JSON.stringify(norm);
                return { ok: true, status: 200, json: async () => JSON.parse(text), arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer };
            }
            const copy = modelBytes.slice();
            return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer };
        }) as unknown as typeof fetch;
        const grid = { nx: 128, ny: 128, domain: { ...DEFAULT_DOMAIN } };
        const geom: GeometrySpec = {
            kind: "naca4",
            naca: { code: "0012", m: 0, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 4,
            nPoints: 24,
        };
        for (const capable of [true, false]) {
            const provider = new SurrogateV3Provider({
                grid, geom, fetchFn: fetchFor(capable),
                createSession: async () => ({ run: async () => ({}) }),
                createTensor: (data, dims) => ({ data, dims }),
                allowSynthetic: true,
            });
            expect(provider.harmonicCapable).toBe(false);
            await provider.load();
            expect(provider.harmonicCapable).toBe(capable);
        }
    });
});

describe("adapter steady-only gate", () => {
    function mockPredictor(capable?: boolean): {
        loaded: boolean;
        load(): Promise<void>;
        predictFrame(): Promise<FlowField>;
        harmonicCapable?: boolean;
    } {
        const p: {
            loaded: boolean;
            load(): Promise<void>;
            predictFrame(): Promise<FlowField>;
            harmonicCapable?: boolean;
        } = {
            loaded: true,
            load: async () => {},
            predictFrame: async () => baseField(),
        };
        if (capable !== undefined) p.harmonicCapable = capable;
        return p;
    }

    it("passes valid harmonics through when capable", async () => {
        const adapter = new NeuralV3Adapter(mockPredictor(true));
        expect(adapter.harmonicCapable).toBe(true);
        const res = await adapter.predictFor(SPEC, 1000);
        expect(res.harmonicValid).toBe(true);
        expect(res.harmonicInvalidReason).toBeNull();
    });

    it("forces steady with the steady-only reason when the predictor is not capable", async () => {
        const adapter = new NeuralV3Adapter(mockPredictor(false));
        expect(adapter.harmonicCapable).toBe(false);
        const res = await adapter.predictFor(SPEC, 1000);
        expect(res.harmonicValid).toBe(false);
        expect(String(res.harmonicInvalidReason)).toMatch(/steady-only/);
    });

    it("an explicit override wins over the predictor flag", async () => {
        const off = new NeuralV3Adapter(mockPredictor(true), { harmonicCapable: false });
        expect(off.harmonicCapable).toBe(false);
        const res = await off.predictFor(SPEC, 1000);
        expect(res.harmonicValid).toBe(false);
        const on = new NeuralV3Adapter(mockPredictor(false), { harmonicCapable: true });
        expect(on.harmonicCapable).toBe(true);
        const resOn = await on.predictFor(SPEC, 1000);
        expect(resOn.harmonicValid).toBe(true);
    });
});

describe("street and phase gates off when not capable", () => {
    it("shouldAnimateStreet is false for a steady-only bundle even with valid gates", () => {
        const gate = {
            path: "neural-v3" as const,
            harmonicValid: true,
            lbmEffective: false,
            isFixture: false,
            solveError: null,
            strouhal: 0.2,
            harmonicCapable: false,
        };
        expect(shouldAnimateStreet(gate)).toBe(false);
        expect(shouldAnimateStreet({ ...gate, harmonicCapable: true })).toBe(true);
        expect(shouldAnimateStreet({ ...gate, harmonicCapable: undefined })).toBe(true);
    });

    it("reconstructAtPhase renders the mean field for a steady frame", () => {
        const field = baseField();
        const steady: FlowField = { ...field, harmonicValid: false, harmonicInvalidReason: "harmonic heads disabled (steady-only bundle)" };
        const out = reconstructAtPhase(steady, 1.1);
        expect(out.u[3]).toBeCloseTo(1, 6);
        expect(out.v[3]).toBeCloseTo(0, 6);
        expect(out.omegaIsMean).toBe(true);
    });
});
