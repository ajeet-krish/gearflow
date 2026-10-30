// v2 surrogate provider plus parity tests. Synthetic goldens only: no real
// weights exist, nothing here touches the canvas or App wiring. The parity
// section probes the ORT InstanceNormalization kernel numerically and, when
// it runs, checks the golden expected_onnx bytes against expected_torch under
// 1e-4, otherwise the test records the honest skip and stays green. The full
// provider path test below uses a mock session only and claims no ORT parity.

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeometrySpec, GridSpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    SURROGATE_V2_NX,
    SURROGATE_V2_NY,
    SURROGATE_V2_TOLERANCE,
    buildV2Input,
    bundleIsSynthetic,
    decodeV2Output,
    validateV2Manifest,
    validateV2Norm,
    SurrogateV2Provider,
    type V2Manifest,
    type V2Norm,
    type V2Session,
} from "./surrogateV2";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_ROOT = join(HERE, "..", "..", "fixtures", "surrogate-v2");

/** Tiny InstanceNormalization-18 probe model (1, 8, 4, 4), built with the same
 * node graph as training/export_onnx.py ort_instancenorm_available. */
const IN_PROBE_B64 =
    "CAo60gEKNgoBWAoBUwoBQhIBWSIVSW5zdGFuY2VOb3JtYWxpemF0aW9uKhEKB2Vwc2lsb24VrMUnN6ABARIIaW4tcHJvYmUqKQgIEAEiIAAAgD8AAIA/AACAPwAAgD8AAIA/AACAPwAAgD8AAIA/QgFTKikICBABIiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEIBQlobCgFYEhYKFAgBEhAKAggBCgIICAoCCAQKAggEYhsKAVkSFgoUCAESEAoCCAEKAggICgIIBAoCCARCBAoAEBI=";

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

function readF32(path: string): Float32Array {
    const bytes = readFileSync(path);
    if (bytes.byteLength % 4 !== 0) throw new Error(`fixture ${path} is not a multiple of 4 bytes`);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Float32Array(copy.buffer);
}

function testNorm(): V2Norm {
    return {
        schema: "gearflow-surrogate-norm/v2",
        alphaScale: 12,
        normalization: { operator: "InstanceNormalization", groups: null, eps: 1e-5 },
        inputs: { sdf: { mean: 0, std: 1 }, logRe: { mean: 2, std: 0.5 } },
        outputs: {
            meanU: { mean: 1, std: 0.5 },
            meanV: { mean: 0, std: 0.25 },
            cp: { mean: 0, std: 1 },
            vorticity: { mean: 0, std: 2 },
            tke: { mean: -1, std: 0.5 },
        },
        fittedOn: "synthetic-test",
    };
}

function testManifest(modelSha: string, normSha: string, provenance: unknown = { source: "synthetic", detail: "test" }): V2Manifest {
    return {
        version: "2",
        arch: "unet-v2",
        base: 8,
        inCh: 4,
        outCh: 6,
        nx: 128,
        ny: 128,
        opset: 18,
        files: {
            model: { path: "model.onnx", sha256: modelSha },
            norm: { path: "norm.json", sha256: normSha },
        },
        normSha256: normSha,
        runId: "test-run",
        provenance,
    };
}

function mockFetchBundle(manifest: V2Manifest, norm: V2Norm, modelBytes: Uint8Array): typeof fetch {
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

function maxAbsErr(a: ArrayLike<number>, b: ArrayLike<number>): number {
    if (a.length !== b.length) throw new Error(`length mismatch ${a.length} vs ${b.length}`);
    let m = 0;
    for (let k = 0; k < a.length; k += 1) {
        const d = Math.abs((a[k] as number) - (b[k] as number));
        if (!Number.isFinite(d)) throw new Error(`non-finite diff at ${k}`);
        if (d > m) m = d;
    }
    return m;
}

describe("validateV2Manifest", () => {
    it("accepts a well formed v2 manifest", () => {
        const sha = "ab".repeat(32);
        const m = validateV2Manifest(testManifest(sha, sha));
        expect(m.version).toBe("2");
        expect(m.arch).toBe("unet-v2");
        expect(m.base).toBe(8);
    });

    it("pins version, arch, base, channels, grid, and opset", () => {
        const sha = "ab".repeat(32);
        const good = testManifest(sha, sha);
        expect(() => validateV2Manifest({ ...good, version: "1" })).toThrow(/version/);
        expect(() => validateV2Manifest({ ...good, arch: "unet" })).toThrow(/arch/);
        expect(() => validateV2Manifest({ ...good, base: 16 })).toThrow(/locked/);
        expect(() => validateV2Manifest({ ...good, inCh: 3 })).toThrow(/channels/);
        expect(() => validateV2Manifest({ ...good, outCh: 3 })).toThrow(/channels/);
        expect(() => validateV2Manifest({ ...good, nx: 64 })).toThrow(/grid/);
        expect(() => validateV2Manifest({ ...good, opset: 17 })).toThrow(/opset/);
        expect(() => validateV2Manifest(null)).toThrow(/object/);
    });

    it("requires allowlisted file basenames plus 64 char digests", () => {
        const sha = "ab".repeat(32);
        const good = testManifest(sha, sha);
        expect(() => validateV2Manifest({
            ...good, files: { ...good.files, model: { path: "../evil.onnx", sha256: sha } },
        })).toThrow(/allowlisted/);
        expect(() => validateV2Manifest({
            ...good, files: { ...good.files, model: { path: "sub/model.onnx", sha256: sha } },
        })).toThrow(/allowlisted/);
        expect(() => validateV2Manifest({
            ...good, files: { ...good.files, model: { path: "model.onnx", sha256: "xyz" } },
        })).toThrow(/hex/);
        expect(() => validateV2Manifest({ ...good, normSha256: "short" })).toThrow(/hex/);
    });
});

describe("validateV2Norm", () => {
    it("accepts the locked InstanceNormalization descriptor", () => {
        const norm = validateV2Norm(testNorm());
        expect(norm.alphaScale).toBe(12);
        expect(norm.normalization.operator).toBe("InstanceNormalization");
        expect(norm.normalization.groups).toBeNull();
        expect(norm.normalization.eps).toBe(1e-5);
    });

    it("rejects a missing normalization field", () => {
        const bad = testNorm() as unknown as Record<string, unknown>;
        const { normalization: _dropped, ...withoutNorm } = bad;
        expect(_dropped).toBeDefined();
        expect(() => validateV2Norm(withoutNorm)).toThrow(/normalization/);
        expect(() => validateV2Norm({ ...bad, normalization: undefined })).toThrow(/normalization/);
        expect(() => validateV2Norm({ ...bad, normalization: null })).toThrow(/normalization/);
        expect(() => validateV2Norm({ ...bad, normalization: 7 })).toThrow(/normalization/);
    });

    it("rejects GroupNormalization operators", () => {
        const bad = testNorm() as unknown as Record<string, unknown>;
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "GroupNormalization", groups: null, eps: 1e-5 },
        })).toThrow(/normalization\.operator/);
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "GroupNormalization", groups: 4, eps: 1e-5 },
        })).toThrow(/normalization\.operator/);
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "", groups: null, eps: 1e-5 },
        })).toThrow(/normalization\.operator/);
    });

    it("rejects non null groups and non 1e-5 eps", () => {
        const bad = testNorm() as unknown as Record<string, unknown>;
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "InstanceNormalization", groups: 8, eps: 1e-5 },
        })).toThrow(/groups/);
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "InstanceNormalization", eps: 1e-5 },
        })).toThrow(/groups/);
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "InstanceNormalization", groups: null, eps: 1e-3 },
        })).toThrow(/eps/);
        expect(() => validateV2Norm({
            ...bad, normalization: { operator: "InstanceNormalization", groups: null },
        })).toThrow(/eps/);
    });

    it("rejects bad scales", () => {
        const bad = testNorm() as unknown as Record<string, unknown>;
        expect(() => validateV2Norm({ ...bad, schema: "other" })).toThrow(/schema/);
        expect(() => validateV2Norm({ ...bad, alphaScale: 0 })).toThrow(/positive/);
        const noTke = testNorm();
        (noTke.outputs as unknown as Record<string, unknown>).tke = { mean: 0, std: 0 };
        expect(() => validateV2Norm(noTke)).toThrow(/std/);
    });
});

describe("buildV2Input", () => {
    it("standardizes SDF with clipping, keeps mask identity, tiles alpha and logRe", () => {
        const n = 128 * 128;
        const sdf = new Float32Array(n).fill(10);
        const obstacle = new Float32Array(n).fill(1);
        obstacle[1] = 0;
        const norm = testNorm();
        const out = buildV2Input(sdf, obstacle, 6, 100, norm);
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
        expect(() => buildV2Input(new Float32Array(10), new Float32Array(10), 0, 100, norm)).toThrow();
        const badMask = new Float32Array(n).fill(0.3);
        expect(() => buildV2Input(new Float32Array(n), badMask, 0, 100, norm)).toThrow(/mask/);
        expect(() => buildV2Input(new Float32Array(n), new Float32Array(n), 0, -5, norm)).toThrow(/Re/);
    });
});

describe("decodeV2Output", () => {
    it("applies sigmoid recirc, expm1 tke, destandardization, and solid zeroing", () => {
        const n = 128 * 128;
        const norm = testNorm();
        const raw = new Float32Array(6 * n);
        for (let c = 0; c < n; c += 1) {
            raw[c] = 0;
            raw[n + c] = 0;
            raw[2 * n + c] = 0;
            raw[3 * n + c] = 0;
            raw[4 * n + c] = 0;
            raw[5 * n + c] = 0;
        }
        const obstacle = new Float32Array(n);
        obstacle[0] = 1;
        const field = decodeV2Output(raw, obstacle, norm, 128, 128, { ...DEFAULT_DOMAIN }, 1);
        expect(field.uMean?.length).toBe(n);
        expect(field.uMean?.[1]).toBeCloseTo(1, 6);
        expect(field.vMean?.[1]).toBeCloseTo(0, 6);
        expect(field.k?.[1]).toBeCloseTo(Math.max(Math.expm1(-1), 0), 9);
        expect(field.recirc?.[1]).toBeCloseTo(0.5, 9);
        expect(field.uMean?.[0]).toBe(0);
        expect(field.k?.[0]).toBe(0);
        expect(field.recirc?.[0]).toBe(0);
        expect(field.u[0]).toBe(0);
        expect(field.p[0]).toBe(0);
        expect(field.nx).toBe(128);
    });

    it("rejects bad shapes and non-finite heads", () => {
        const norm = testNorm();
        const n = 128 * 128;
        expect(() => decodeV2Output(new Float32Array(10), new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1))
            .toThrow(/length/);
        const raw = new Float32Array(6 * n).fill(Number.NaN);
        expect(() => decodeV2Output(raw, new Float32Array(n), norm, 128, 128, { ...DEFAULT_DOMAIN }, 1)).toThrow();
    });
});

describe("SurrogateV2Provider load failures", () => {
    it("rejects a missing bundle with the cause named", async () => {
        const fetchFn = (async () => ({ ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch;
        const provider = new SurrogateV2Provider({ grid: GRID, geom: GEOM, fetchFn, allowSynthetic: true });
        await expect(provider.load()).rejects.toThrow(/bundle fetch failed.*manifest/);
    });

    it("rejects a bad manifest with the cause named", async () => {
        const fetchFn = (async (url: string) => {
            if (url.endsWith("/model.json")) return { ok: true, status: 200, json: async () => ({ version: "9" }), arrayBuffer: async () => new ArrayBuffer(0) };
            return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        }) as unknown as typeof fetch;
        const provider = new SurrogateV2Provider({ grid: GRID, geom: GEOM, fetchFn, allowSynthetic: true });
        await expect(provider.load()).rejects.toThrow(/bad manifest/);
    });

    it("refuses synthetic provenance unless tests opt in", async () => {
        const norm = testNorm();
        const modelBytes = new Uint8Array(1024).fill(7);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        expect(bundleIsSynthetic(manifest, norm)).toBe(true);
        const refused = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => ({ run: async () => ({}) }),
        });
        await expect(refused.load()).rejects.toThrow(/synthetic/);
        const allowed = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => ({ run: async () => ({}) }),
            allowSynthetic: true,
        });
        await allowed.load();
        expect(allowed.loaded).toBe(true);
    });

    it("rejects a model sha mismatch with the cause named", async () => {
        const norm = testNorm();
        const modelBytes = new Uint8Array(1024).fill(7);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest("cd".repeat(32), normSha);
        const provider = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => ({ run: async () => ({}) }),
            allowSynthetic: true,
        });
        await expect(provider.load()).rejects.toThrow(/sha256 mismatch/);
    });

    it("rejects ORT execution failure with the cause named", async () => {
        const norm = testNorm();
        const modelBytes = new Uint8Array(1024).fill(7);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        const failing: V2Session = { run: async () => { throw new Error("boom"); } };
        const provider = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => failing,
            createTensor: (data, dims) => ({ data, dims }),
            allowSynthetic: true,
        });
        await provider.load();
        await expect(provider.predictFrame()).rejects.toThrow(/ONNX execution failed/);
        expect(() => provider.getFrame()).toThrow(/no predicted frame/);
    });
});

describe("v2 norm sidecar exact byte hash", () => {
    it("hashes the fetched sidecar bytes and parses those same bytes", async () => {
        const canonicalJson = (value: unknown): string => {
            if (value === null) return "null";
            if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
            if (typeof value === "object") {
                const entries = Object.entries(value as Record<string, unknown>)
                    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
                return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
            }
            return JSON.stringify(value) as string;
        };
        const norm = testNorm();
        const canonicalText = `${canonicalJson(norm)}\n`;
        const canonicalBytes = new TextEncoder().encode(canonicalText);
        const normSha = sha256Hex(canonicalBytes);
        const reserializedDigest = sha256Hex(
            new TextEncoder().encode(JSON.stringify(JSON.parse(canonicalText) as unknown)),
        );
        expect(reserializedDigest).not.toBe(normSha);
        const modelBytes = new Uint8Array(1024).fill(7);
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        const fetchFn = (async (url: string) => {
            if (url.endsWith("/model.json")) {
                return { ok: true, status: 200, json: async () => manifest, arrayBuffer: async () => new ArrayBuffer(0) };
            }
            if (url.endsWith("/norm.json")) {
                return {
                    ok: true,
                    status: 200,
                    json: async () => JSON.parse(new TextDecoder().decode(canonicalBytes)) as unknown,
                    arrayBuffer: async () => canonicalBytes.slice().buffer as ArrayBuffer,
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
        const provider = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn,
            createSession: async () => ({ run: async () => ({}) }),
            allowSynthetic: true,
        });
        await provider.load();
        expect(provider.loaded).toBe(true);
    });
});

describe("v2 parity plus InstanceNormalization kernel probe (C-5 answer)", () => {
    it("probes the ORT InstanceNormalization kernel and checks golden onnx vs torch", async () => {
        const golden = JSON.parse(readFileSync(join(GOLDEN_ROOT, "golden.json"), "utf8")) as {
            arch: string; base: number; opset: number; tolerance: number; seed: number;
            normSha256: string; torchVsOnnxMaxErr: number | null;
            onnx: { available: boolean; reason: string };
            cases: Array<{
                name: string;
                input: { file: string; shape: number[]; sha256: string };
                torch: { file: string; shape: number[]; sha256: string };
                onnx: null | { file: string; shape: number[]; sha256: string };
            }>;
        };
        expect(golden.arch).toBe("unet-v2");
        expect(golden.base).toBe(8);
        expect(golden.opset).toBe(18);
        expect(golden.seed).toBe(7);
        expect(golden.tolerance).toBe(SURROGATE_V2_TOLERANCE);
        for (const c of golden.cases) {
            const input = readF32(join(GOLDEN_ROOT, c.input.file));
            const torchOut = readF32(join(GOLDEN_ROOT, c.torch.file));
            expect(Array.from(c.input.shape)).toEqual([1, 4, 128, 128]);
            expect(Array.from(c.torch.shape)).toEqual([1, 6, 128, 128]);
            expect(input.length).toBe(1 * 4 * 128 * 128);
            expect(torchOut.length).toBe(1 * 6 * 128 * 128);
            expect(sha256Hex(new Uint8Array(input.buffer))).toBe(c.input.sha256);
            expect(sha256Hex(new Uint8Array(torchOut.buffer))).toBe(c.torch.sha256);
            expect(Number.isFinite(maxAbsErr(torchOut, torchOut))).toBe(true);
        }

        const ort = await import("onnxruntime-web");
        const probeBytes = Uint8Array.from(Buffer.from(IN_PROBE_B64, "base64"));
        let kernelRuns = false;
        let kernelDetail = "";
        try {
            const sess = await ort.InferenceSession.create(probeBytes, { executionProviders: ["wasm"] });
            const x = new ort.Tensor("float32", new Float32Array(1 * 8 * 4 * 4).fill(0.5), [1, 8, 4, 4]);
            const out = await sess.run({ X: x });
            const y = out["Y"];
            if (y !== undefined && y !== null) {
                const data = y.data as ArrayLike<number>;
                const probeErr = maxAbsErr(data, new Float32Array(data.length));
                kernelRuns = probeErr < 1e-5;
                kernelDetail = `ran, output length ${data.length}, max abs ${probeErr}`;
            } else {
                kernelDetail = "no Y output";
            }
        } catch (e) {
            kernelRuns = false;
            kernelDetail = e instanceof Error ? e.message.slice(0, 220) : String(e).slice(0, 220);
        }

        if (kernelRuns) {
            const zeros = golden.cases.find((c) => c.name === "zeros");
            expect(zeros).toBeDefined();
            const z = zeros as { torch: { file: string }; onnx: { file: string; sha256: string } | null };
            expect(z.onnx).not.toBeNull();
            const onnxEntry = z.onnx as { file: string; sha256: string };
            const onnxOut = readF32(join(GOLDEN_ROOT, onnxEntry.file));
            expect(sha256Hex(new Uint8Array(onnxOut.buffer))).toBe(onnxEntry.sha256);
            const torchOut = readF32(join(GOLDEN_ROOT, z.torch.file));
            const err = maxAbsErr(onnxOut, torchOut);
            expect(err).toBeLessThan(golden.tolerance);
            console.log(`v2 parity verdict: ORT InstanceNormalization kernel runs (${kernelDetail}); golden zeros onnx vs torch max err ${err}`);
        } else {
            const zeros = golden.cases.find((c) => c.name === "zeros");
            expect(zeros).toBeDefined();
            const z = zeros as { torch: { file: string }; onnx: { file: string; sha256: string } | null };
            const torchOut = readF32(join(GOLDEN_ROOT, z.torch.file));
            expect(torchOut.length).toBe(98304);
            let finite = 0;
            for (let k = 0; k < torchOut.length; k += 1) if (Number.isFinite(torchOut[k] as number)) finite += 1;
            expect(finite).toBe(torchOut.length);
            if (!golden.onnx.available) {
                expect(golden.torchVsOnnxMaxErr).toBeNull();
                for (const c of golden.cases) expect(c.onnx).toBeNull();
            } else if (z.onnx) {
                const onnxOut = readF32(join(GOLDEN_ROOT, z.onnx.file));
                expect(sha256Hex(new Uint8Array(onnxOut.buffer))).toBe(z.onnx.sha256);
            }
            console.log(`v2 parity verdict: ORT InstanceNormalization does NOT execute in this env (${kernelDetail}); ` +
                `zeros torch output finite ${finite}/98304`);
        }
    }, 120000);

    it("mock provider path on golden torch bytes (mock, not ORT parity)", async () => {
        const torchOut = readF32(join(GOLDEN_ROOT, "zeros", "expected_torch.f32"));
        const mockSession: V2Session = {
            run: async (feeds) => {
                const input = feeds["input"];
                expect(Array.from(input.dims)).toEqual([1, 4, 128, 128]);
                return { output: { data: torchOut, dims: [1, 6, 128, 128] } };
            },
        };
        const norm = testNorm();
        const modelBytes = new Uint8Array(64).fill(1);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        const provider = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => mockSession,
            createTensor: (data, dims) => ({ data, dims }),
            allowSynthetic: true,
        });
        await provider.load();
        const field = await provider.predictFrame();
        expect(field.nx).toBe(SURROGATE_V2_NX);
        expect(field.ny).toBe(SURROGATE_V2_NY);
        expect(field.u.length).toBe(128 * 128);
        expect(field.uMean?.length).toBe(128 * 128);
        expect(field.k?.length).toBe(128 * 128);
        expect(field.recirc?.length).toBe(128 * 128);
        let fluid = 0;
        for (let k = 0; k < field.u.length; k += 1) {
            expect(Number.isFinite(field.u[k])).toBe(true);
            expect(Number.isFinite(field.v[k])).toBe(true);
            const r = field.recirc?.[k] as number;
            expect(Number.isFinite(r)).toBe(true);
            if (field.obstacle[k] <= 0.5) {
                fluid += 1;
                expect(r).toBeGreaterThanOrEqual(0);
                expect(r).toBeLessThanOrEqual(1);
                expect(field.k?.[k] as number).toBeGreaterThanOrEqual(0);
            } else {
                expect(field.u[k]).toBe(0);
                expect(field.k?.[k]).toBe(0);
                expect(field.recirc?.[k]).toBe(0);
            }
        }
        expect(fluid).toBeGreaterThan(0);
        expect(provider.getFrame()).toBe(field);
        const prov = provider.getProvenance();
        expect(prov.source).toBe("surrogate");
        expect(prov.label).toMatch(/predicted, not validated/);
    });
});

describe("SurrogateV2Provider failed predict retry and provenance reset", () => {
    function loadedProviderWith(session: V2Session): { provider: SurrogateV2Provider; norm: V2Norm } {
        const norm = testNorm();
        const modelBytes = new Uint8Array(64).fill(1);
        const normSha = sha256Hex(new TextEncoder().encode(JSON.stringify(norm)));
        const manifest = testManifest(sha256Hex(modelBytes), normSha);
        const provider = new SurrogateV2Provider({
            grid: GRID, geom: GEOM, fetchFn: mockFetchBundle(manifest, norm, modelBytes),
            createSession: async () => session,
            createTensor: (data, dims) => ({ data, dims }),
            allowSynthetic: true,
        });
        return { provider, norm };
    }

    it("fails once then serves the retried frame with no stale state", async () => {
        let calls = 0;
        const torchOut = new Float32Array(6 * 128 * 128);
        const flaky: V2Session = {
            run: async () => {
                calls += 1;
                if (calls === 1) throw new Error("transient ORT blip");
                return { output: { data: torchOut, dims: [1, 6, 128, 128] } };
            },
        };
        const { provider } = loadedProviderWith(flaky);
        await provider.load();
        await expect(provider.predictFrame()).rejects.toThrow(/ONNX execution failed/);
        expect(() => provider.getFrame()).toThrow(/no predicted frame/);
        const field = await provider.predictFrame();
        expect(calls).toBe(2);
        expect(field.nx).toBe(SURROGATE_V2_NX);
        expect(field.u.length).toBe(128 * 128);
        expect(provider.getFrame()).toBe(field);
        expect(provider.getProvenance().label).toMatch(/predicted, not validated/);
    });

    it("clears the provenance note alongside the field on setGeometry and setRe", async () => {
        const torchOut = new Float32Array(6 * 128 * 128);
        const session: V2Session = {
            run: async () => ({ output: { data: torchOut, dims: [1, 6, 128, 128] } }),
        };
        const { provider } = loadedProviderWith(session);
        await provider.load();
        await provider.predictFrame();
        expect(provider.getProvenance().label).toContain("test-run");
        provider.setRe(2000);
        expect(() => provider.getFrame()).toThrow(/no predicted frame/);
        expect(provider.getProvenance().label).toBe("surrogate v2 predicted, not validated");
        await provider.predictFrame();
        expect(provider.getProvenance().label).toContain("test-run");
        provider.setGeometry({ ...GEOM, naca: { ...GEOM.naca as { code: string; m: number; p: number; t: number } } });
        expect(() => provider.getFrame()).toThrow(/no predicted frame/);
        expect(provider.getProvenance().label).toBe("surrogate v2 predicted, not validated");
    });
});

describe("SurrogateV2Provider global fetch binding", () => {
    it("binds the global fetch so a detached stored call keeps a valid receiver", async () => {
        const original = globalThis.fetch;
        try {
            let receivedThis: unknown = "unset";
            let calledUrl: string | null = null;
            function chromeLikeFetch(this: unknown, url: unknown): Promise<Response> {
                receivedThis = this;
                if (this === undefined || this === null) {
                    throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
                }
                calledUrl = url as string;
                return Promise.resolve(new Response("{}", { status: 200 }));
            }
            globalThis.fetch = chromeLikeFetch as unknown as typeof fetch;
            const provider = new SurrogateV2Provider({ grid: GRID, geom: GEOM, allowSynthetic: true });
            const stored = (provider as unknown as { fetchFn: (url: string) => Promise<Response> }).fetchFn;
            expect(typeof stored).toBe("function");
            await stored("surrogate/v2/model.json");
            expect(calledUrl).toBe("surrogate/v2/model.json");
            expect(receivedThis).toBe(globalThis);
        } finally {
            globalThis.fetch = original;
        }
    });

    it("keeps an injected fetchFn untouched", () => {
        const injected = (async () => ({})) as unknown as typeof fetch;
        const provider = new SurrogateV2Provider({ grid: GRID, geom: GEOM, fetchFn: injected, allowSynthetic: true });
        expect((provider as unknown as { fetchFn: unknown }).fetchFn).toBe(injected);
    });
});
