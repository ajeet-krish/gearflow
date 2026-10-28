// v2 surrogate ONNX provider (unet-v2, 4 input channels, 6 output heads).
// Async only. Loads model.onnx plus norm.json plus model.json from a base
// URL, validates the manifest, verifies sha256 digests, builds the model
// input on the canonical 128 grid, runs the injected ORT session, then
// applies the training sidecar normalization exactly: inputs standardized
// per sidecar, outputs destandardized, recirc through sigmoid, tke through
// expm1, solids zeroed. Marker flagged synthetic provenance bundles are
// refused unless the caller passes allowSynthetic (tests only). The flag is
// a string marker only until App wiring adds an explicit provenance
// contract. Every failure rejects with an error naming the cause; the
// caller keeps the analytic frame. No network at test time: fetch, tensor,
// and session factories are injectable. No UI wiring here.

import type { Domain, FlowField, GeometrySpec, GridSpec, Provenance } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { cloneGeometry, type FrameSource } from "./frameSource";
import { resolveBody } from "./analyticFlow";
import { buildSdfGrid } from "./sdf";

export const SURROGATE_V2_NX = 128;
export const SURROGATE_V2_NY = 128;
export const SURROGATE_V2_IN_CH = 4;
export const SURROGATE_V2_OUT_CH = 6;
export const SURROGATE_V2_BASE = 8;
export const SURROGATE_V2_ARCH = "unet-v2";
export const SURROGATE_V2_OPSET = 18;
export const SURROGATE_V2_VERSION = "2";
export const SURROGATE_V2_TOLERANCE = 1e-4;
export const SURROGATE_V2_SDF_CLIP = 3;
export const SURROGATE_V2_NORM_SCHEMA = "gearflow-surrogate-norm/v2";
export const SURROGATE_V2_DEFAULT_BASE_URL = "surrogate/v2";
/** Byte cap checked before any model buffer is handed to the session. */
export const SURROGATE_V2_MAX_MODEL_BYTES = 64 * 1024 * 1024;
/** Canonical v2 domain: x in [-0.5, 2.0], y in [-1.0, 1.0]. */
export const SURROGATE_V2_DOMAIN: Domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };

/** Output head order in the ONNX (batch, 6, 128, 128) tensor. */
export const SURROGATE_V2_OUT_HEADS = ["meanU", "meanV", "cp", "vorticity", "tke", "recirc"] as const;

const FILE_RE = /^[A-Za-z0-9._-]+\.(onnx|json)$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

export interface V2Stat {
    mean: number;
    std: number;
}

/** v2 normalization descriptor, locked to InstanceNormalization (mirrors training/dataset_v2.py). */
export interface V2Normalization {
    operator: "InstanceNormalization";
    groups: null;
    eps: number;
}

export interface V2Norm {
    schema: string;
    alphaScale: number;
    /** v2 normalization operator descriptor, required (mirrors training/dataset_v2.py). */
    normalization: V2Normalization;
    inputs: {
        sdf: V2Stat;
        logRe: V2Stat;
    };
    outputs: {
        meanU: V2Stat;
        meanV: V2Stat;
        cp: V2Stat;
        vorticity: V2Stat;
        tke: V2Stat;
    };
    fittedOn?: string;
}

export interface V2ManifestFile {
    path: string;
    sha256: string;
}

export interface V2Manifest {
    version: string;
    arch: string;
    base: number;
    inCh: number;
    outCh: number;
    nx: number;
    ny: number;
    opset: number;
    files: {
        model: V2ManifestFile;
        norm: V2ManifestFile;
    };
    normSha256: string;
    runId?: string;
    provenance?: unknown;
}

/** Minimal tensor view shared by the real ORT session and test doubles. */
export interface V2TensorLike {
    readonly data: ArrayLike<number>;
    readonly dims: readonly number[];
}

export interface V2Session {
    run(feeds: Record<string, V2TensorLike>): Promise<Record<string, V2TensorLike>>;
}

export type V2SessionFactory = (modelBytes: ArrayBuffer) => Promise<V2Session>;
export type V2TensorFactory = (data: Float32Array, dims: readonly number[]) => Promise<V2TensorLike> | V2TensorLike;

export interface SurrogateV2Options {
    grid: GridSpec;
    geom: GeometrySpec;
    U?: number;
    Re?: number;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    createSession?: V2SessionFactory;
    createTensor?: V2TensorFactory;
    /** Tests only: permit synthetic provenance bundles. Demo never sets this. */
    allowSynthetic?: boolean;
}

type FetchLike = (url: string) => Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

function fail(cause: string): never {
    throw new Error(`surrogate-v2: ${cause}`);
}

function requireFinite(value: number, context: string): void {
    if (!Number.isFinite(value)) fail(`${context} must be finite, got ${String(value)}`);
}

function requireStat(raw: unknown, context: string, minStd: number): V2Stat {
    if (typeof raw !== "object" || raw === null) fail(`${context} must be an object`);
    const rec = raw as Record<string, unknown>;
    requireFinite(rec.mean as number, `${context}.mean`);
    requireFinite(rec.std as number, `${context}.std`);
    const std = rec.std as number;
    if (!(std >= minStd)) fail(`${context}.std must be at least ${minStd}, got ${String(std)}`);
    return { mean: rec.mean as number, std };
}

function requireFile(raw: unknown, context: string): V2ManifestFile {
    if (typeof raw !== "object" || raw === null) fail(`${context} must be an object`);
    const rec = raw as Record<string, unknown>;
    if (typeof rec.path !== "string" || rec.path === "") fail(`${context}.path must be a non-empty string`);
    const path = rec.path as string;
    if (path.includes("/") || path.includes("\\") || path.includes("..") || !FILE_RE.test(path)) {
        fail(`${context}.path ${JSON.stringify(path)} is not an allowlisted bundle basename`);
    }
    if (typeof rec.sha256 !== "string" || !SHA256_RE.test(rec.sha256)) {
        fail(`${context}.sha256 must be a 64 char hex digest`);
    }
    return { path, sha256: rec.sha256 as string };
}

/** Validate a fetched v2 browser manifest against the locked contract. */
export function validateV2Manifest(raw: unknown): V2Manifest {
    if (typeof raw !== "object" || raw === null) fail("manifest must be an object");
    const m = raw as Record<string, unknown>;
    if (m.version !== SURROGATE_V2_VERSION) fail(`manifest.version must be ${JSON.stringify(SURROGATE_V2_VERSION)}, got ${JSON.stringify(m.version)}`);
    if (m.arch !== SURROGATE_V2_ARCH) fail(`manifest.arch must be ${JSON.stringify(SURROGATE_V2_ARCH)}, got ${JSON.stringify(m.arch)}`);
    if (m.base !== SURROGATE_V2_BASE) fail(`manifest.base is locked to ${SURROGATE_V2_BASE}, got ${JSON.stringify(m.base)}`);
    if (m.inCh !== SURROGATE_V2_IN_CH || m.outCh !== SURROGATE_V2_OUT_CH) {
        fail(`manifest channels ${String(m.inCh)}->${String(m.outCh)} do not match ${SURROGATE_V2_IN_CH}->${SURROGATE_V2_OUT_CH}`);
    }
    if (m.nx !== SURROGATE_V2_NX || m.ny !== SURROGATE_V2_NY) {
        fail(`manifest grid ${String(m.nx)}x${String(m.ny)} must be ${SURROGATE_V2_NX}x${SURROGATE_V2_NY}`);
    }
    if (m.opset !== SURROGATE_V2_OPSET) fail(`manifest.opset must be ${SURROGATE_V2_OPSET}, got ${JSON.stringify(m.opset)}`);
    if (typeof m.files !== "object" || m.files === null) fail("manifest.files must be an object");
    const files = m.files as Record<string, unknown>;
    const model = requireFile(files.model, "manifest.files.model");
    const norm = requireFile(files.norm, "manifest.files.norm");
    if (typeof m.normSha256 !== "string" || !SHA256_RE.test(m.normSha256)) {
        fail("manifest.normSha256 must be a 64 char hex digest");
    }
    if (m.runId !== undefined && typeof m.runId !== "string") fail("manifest.runId must be a string when present");
    return {
        version: "2",
        arch: SURROGATE_V2_ARCH,
        base: SURROGATE_V2_BASE,
        inCh: SURROGATE_V2_IN_CH,
        outCh: SURROGATE_V2_OUT_CH,
        nx: SURROGATE_V2_NX,
        ny: SURROGATE_V2_NY,
        opset: SURROGATE_V2_OPSET,
        files: { model, norm },
        normSha256: (m.normSha256 as string).toLowerCase(),
        runId: m.runId as string | undefined,
        provenance: m.provenance,
    };
}

/** Validate the required norm.normalization descriptor (locked contract, mirrors training/dataset_v2.py). */
function validateV2Normalization(raw: unknown): V2Normalization {
    if (typeof raw !== "object" || raw === null) fail("norm.normalization must be an object (required, GroupNorm sidecars are rejected)");
    const d = raw as Record<string, unknown>;
    if (d.operator !== "InstanceNormalization") {
        fail(`norm.normalization.operator must be "InstanceNormalization", got ${JSON.stringify(d.operator)} (GroupNorm sidecars are rejected: onnxruntime-web cannot run GroupNormalization-18)`);
    }
    if (d.groups !== null) {
        fail(`norm.normalization.groups must be null, got ${JSON.stringify(d.groups)}`);
    }
    if (d.eps !== 1e-5) {
        fail(`norm.normalization.eps must be 1e-5, got ${JSON.stringify(d.eps)}`);
    }
    return { operator: "InstanceNormalization", groups: null, eps: 1e-5 };
}

/** Validate the norm.json sidecar shape (mirrors training/dataset_v2.py). */
export function validateV2Norm(raw: unknown): V2Norm {
    if (typeof raw !== "object" || raw === null) fail("norm sidecar must be an object");
    const n = raw as Record<string, unknown>;
    if (n.schema !== SURROGATE_V2_NORM_SCHEMA) {
        fail(`norm schema must be ${JSON.stringify(SURROGATE_V2_NORM_SCHEMA)}, got ${JSON.stringify(n.schema)}`);
    }
    requireFinite(n.alphaScale as number, "norm.alphaScale");
    if (!((n.alphaScale as number) > 0)) fail(`norm.alphaScale must be positive, got ${String(n.alphaScale)}`);
    const normalization = validateV2Normalization(n.normalization);
    if (typeof n.inputs !== "object" || n.inputs === null) fail("norm.inputs must be an object");
    if (typeof n.inputs !== "object" || n.inputs === null) fail("norm.inputs must be an object");
    if (typeof n.outputs !== "object" || n.outputs === null) fail("norm.outputs must be an object");
    const inputs = n.inputs as Record<string, unknown>;
    const outputs = n.outputs as Record<string, unknown>;
    const sdf = requireStat(inputs.sdf, "norm.inputs.sdf", 1e-6);
    const logRe = requireStat(inputs.logRe, "norm.inputs.logRe", 1e-6);
    const meanU = requireStat(outputs.meanU, "norm.outputs.meanU", 1e-6);
    const meanV = requireStat(outputs.meanV, "norm.outputs.meanV", 1e-6);
    const cp = requireStat(outputs.cp, "norm.outputs.cp", 1e-6);
    const vorticity = requireStat(outputs.vorticity, "norm.outputs.vorticity", 1e-6);
    const tke = requireStat(outputs.tke, "norm.outputs.tke", 1e-6);
    const fittedOn = n.fittedOn;
    if (fittedOn !== undefined && typeof fittedOn !== "string") fail("norm.fittedOn must be a string when present");
    return {
        schema: SURROGATE_V2_NORM_SCHEMA,
        alphaScale: n.alphaScale as number,
        normalization,
        inputs: { sdf, logRe },
        outputs: { meanU, meanV, cp, vorticity, tke },
        fittedOn: fittedOn as string | undefined,
    };
}

/** True when the bundle carries a synthetic marker (string match only, until App wiring adds an explicit provenance contract). */
export function bundleIsSynthetic(manifest: V2Manifest, norm: V2Norm): boolean {
    const hay = JSON.stringify(manifest.provenance ?? {}).toLowerCase();
    if (hay.includes("synthetic")) return true;
    if (typeof norm.fittedOn === "string" && norm.fittedOn.toLowerCase().includes("synthetic")) return true;
    return false;
}

/** SHA-256 hex of a fetched buffer, via WebCrypto. */
export async function sha256HexV2(buf: ArrayBuffer): Promise<string> {
    const cryptoObj = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
    if (!cryptoObj?.subtle) fail("WebCrypto subtle is unavailable for hash verification");
    const digest = await (cryptoObj as { subtle: SubtleCrypto }).subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sigmoid(x: number): number {
    if (x >= 0) return 1 / (1 + Math.exp(-x));
    const e = Math.exp(x);
    return e / (1 + e);
}

/**
 * Build the model input in NCHW order (batch 1, 4 channels, 128, 128).
 * Mirrors training/dataset_v2.py normalize_sample exactly: SDF clipped to
 * (-3, 3) then standardized, mask identity 0/1, alpha degrees tiled over
 * alphaScale, log10(Re) standardized. At the canonical 128 grid no
 * resampling is needed, so the freestream fill for outside domain cells is
 * not applicable here.
 */
export function buildV2Input(
    sdf: Float32Array,
    obstacle: Float32Array,
    alphaDeg: number,
    Re: number,
    norm: V2Norm,
    nx: number = SURROGATE_V2_NX,
    ny: number = SURROGATE_V2_NY,
): Float32Array {
    if (nx !== SURROGATE_V2_NX || ny !== SURROGATE_V2_NY) {
        fail(`canonical v2 grid is ${SURROGATE_V2_NX}x${SURROGATE_V2_NY}, got ${nx}x${ny}`);
    }
    if (sdf.length !== nx * ny || obstacle.length !== nx * ny) {
        fail("buildV2Input: channel length does not match nx * ny");
    }
    requireFinite(alphaDeg, "alphaDeg");
    if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(Re)}`);
    const logRe = Math.log10(Re);
    const logReN = (logRe - norm.inputs.logRe.mean) / norm.inputs.logRe.std;
    const alphaN = alphaDeg / norm.alphaScale;
    if (!Number.isFinite(logReN) || !Number.isFinite(alphaN)) fail("buildV2Input: normalized alpha or logRe is not finite");
    const out = new Float32Array(SURROGATE_V2_IN_CH * ny * nx);
    const plane = ny * nx;
    for (let k = 0; k < nx * ny; k += 1) {
        const s = sdf[k];
        const m = obstacle[k];
        if (!Number.isFinite(s)) fail(`buildV2Input: non-finite sdf at index ${k}`);
        if (!(m === 0 || m === 1)) fail(`buildV2Input: mask must be 0 or 1, got ${String(m)} at index ${k}`);
        const clipped = Math.max(-SURROGATE_V2_SDF_CLIP, Math.min(SURROGATE_V2_SDF_CLIP, s));
        out[k] = (clipped - norm.inputs.sdf.mean) / norm.inputs.sdf.std;
        out[plane + k] = m;
        out[2 * plane + k] = alphaN;
        out[3 * plane + k] = logReN;
    }
    for (let k = 0; k < out.length; k += 1) {
        if (!Number.isFinite(out[k])) fail(`buildV2Input: non-finite normalized input at index ${k}`);
    }
    return out;
}

/**
 * Decode a raw ONNX (1, 6, 128, 128) output into a FlowField. Mirrors the
 * training contract: destandardize the five regression heads, sigmoid the
 * recirc logit, expm1 the tke log head clipped at zero, zero every head on
 * solid cells. Base channels carry meanU, meanV, cp, vorticity; the optional
 * uMean, vMean, k, recirc channels carry the same predicted values for the
 * turbulence statistics UI. Predicted values only, never validated physics.
 */
export function decodeV2Output(
    raw: ArrayLike<number>,
    obstacle: Float32Array,
    norm: V2Norm,
    nx: number,
    ny: number,
    domain: Domain,
    U: number,
): FlowField {
    if (nx !== SURROGATE_V2_NX || ny !== SURROGATE_V2_NY) {
        fail(`canonical v2 grid is ${SURROGATE_V2_NX}x${SURROGATE_V2_NY}, got ${nx}x${ny}`);
    }
    if (raw.length !== SURROGATE_V2_OUT_CH * ny * nx) {
        fail(`decodeV2Output: output length ${raw.length} does not match 1x${SURROGATE_V2_OUT_CH}x${ny}x${nx}`);
    }
    if (obstacle.length !== nx * ny) fail("decodeV2Output: obstacle length does not match nx * ny");
    requireFinite(U, "U");
    if (!(U > 0)) fail(`U must be positive, got ${String(U)}`);
    const stats = [norm.outputs.meanU, norm.outputs.meanV, norm.outputs.cp, norm.outputs.vorticity, norm.outputs.tke];
    const n = nx * ny;
    const uMean = new Float32Array(n);
    const vMean = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const k = new Float32Array(n);
    const recirc = new Float32Array(n);
    const mask = new Float32Array(n);
    const q = 0.5 * U * U;
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const c = j * nx + i;
            const solid = obstacle[c] > 0.5;
            mask[c] = obstacle[c];
            if (solid) continue;
            const at = (h: number): number => raw[h * n + c] as number;
            const vals = [at(0), at(1), at(2), at(3), at(4)];
            for (let h = 0; h < vals.length; h += 1) {
                if (!Number.isFinite(vals[h])) fail(`decodeV2Output: non-finite head ${h} at cell ${c}`);
            }
            const logit = at(5);
            if (!Number.isFinite(logit)) fail(`decodeV2Output: non-finite recirc logit at cell ${c}`);
            const tkeLog = vals[4] * stats[4].std + stats[4].mean;
            const tkePhys = Math.max(Math.expm1(tkeLog), 0);
            uMean[c] = vals[0] * stats[0].std + stats[0].mean;
            vMean[c] = vals[1] * stats[1].std + stats[1].mean;
            const cpPhys = vals[2] * stats[2].std + stats[2].mean;
            omega[c] = vals[3] * stats[3].std + stats[3].mean;
            k[c] = tkePhys;
            recirc[c] = sigmoid(logit);
            p[c] = cpPhys * q;
            if (!Number.isFinite(uMean[c]) || !Number.isFinite(vMean[c]) || !Number.isFinite(p[c]) ||
                !Number.isFinite(omega[c]) || !Number.isFinite(k[c]) || !Number.isFinite(recirc[c])) {
                fail(`decodeV2Output: non-finite decoded value at cell ${c}`);
            }
        }
    }
    return {
        nx, ny, domain: { ...domain },
        u: uMean.slice(), v: vMean.slice(), p, omega, obstacle: mask,
        uMean, vMean, k, recirc,
    };
}

/** Default ORT session factory: dynamic import keeps the wasm backend out of the sync path. */
async function defaultCreateSession(modelBytes: ArrayBuffer): Promise<V2Session> {
    let ort: typeof import("onnxruntime-web");
    try {
        ort = await import("onnxruntime-web");
    } catch (e) {
        fail(`onnxruntime-web import failed (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
        const sess = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
        return {
            run: (feeds) => sess.run(feeds as Record<string, import("onnxruntime-web").Tensor>) as Promise<Record<string, V2TensorLike>>,
        };
    } catch (e) {
        fail(`ONNX session creation failed (${e instanceof Error ? e.message : String(e)})`);
    }
}

async function defaultCreateTensor(data: Float32Array, dims: readonly number[]): Promise<V2TensorLike> {
    const ort = await import("onnxruntime-web");
    return new ort.Tensor("float32", data, [...dims]);
}

/**
 * Async v2 surrogate provider. Implements FrameSource for interface
 * compatibility: call load() once, then predictFrame() per frame; getFrame
 * serves the last predicted frame and throws before the first prediction
 * (there is no sync ONNX inference). All load and inference failures reject
 * with a cause naming error so the caller can keep the analytic frame.
 */
export class SurrogateV2Provider implements FrameSource {
    readonly label = "surrogate-v2";
    private grid: GridSpec;
    private geom: GeometrySpec;
    private U: number;
    private Re: number;
    private baseUrl: string;
    private fetchFn: FetchLike | null;
    private createSession: V2SessionFactory;
    private createTensor: V2TensorFactory;
    private allowSynthetic: boolean;
    private manifest: V2Manifest | null = null;
    private norm: V2Norm | null = null;
    private session: V2Session | null = null;
    private field: FlowField | null = null;
    private provenanceNote: string | null = null;

    constructor(opts: SurrogateV2Options) {
        if (!opts || typeof opts !== "object") fail("options are required");
        validateGridSpec(opts.grid);
        validateGeometrySpec(opts.geom);
        if (opts.grid.nx !== SURROGATE_V2_NX || opts.grid.ny !== SURROGATE_V2_NY) {
            fail(`canonical v2 grid is ${SURROGATE_V2_NX}x${SURROGATE_V2_NY}, got ${opts.grid.nx}x${opts.grid.ny}`);
        }
        const d = opts.grid.domain;
        const c = SURROGATE_V2_DOMAIN;
        if (d.xMin !== c.xMin || d.xMax !== c.xMax || d.yMin !== c.yMin || d.yMax !== c.yMax) {
            fail(`v2 domain must be x [${c.xMin}, ${c.xMax}] y [${c.yMin}, ${c.yMax}], got x [${d.xMin}, ${d.xMax}] y [${d.yMin}, ${d.yMax}]`);
        }
        const U = opts.U ?? 1;
        const Re = opts.Re ?? 1000;
        if (!Number.isFinite(U) || U <= 0) fail(`U must be a positive finite number, got ${String(opts.U)}`);
        if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(opts.Re)}`);
        this.grid = { nx: opts.grid.nx, ny: opts.grid.ny, domain: { ...opts.grid.domain } };
        this.geom = cloneGeometry(opts.geom);
        this.U = U;
        this.Re = Re;
        this.baseUrl = (opts.baseUrl ?? SURROGATE_V2_DEFAULT_BASE_URL).replace(/\/$/, "");
        const globalFetch = typeof fetch !== "undefined" ? (fetch as unknown as FetchLike) : null;
        this.fetchFn = (opts.fetchFn as FetchLike | undefined) ?? globalFetch;
        this.createSession = opts.createSession ?? defaultCreateSession;
        this.createTensor = opts.createTensor ?? defaultCreateTensor;
        this.allowSynthetic = opts.allowSynthetic ?? false;
    }

    get loaded(): boolean {
        return this.session !== null;
    }

    setGeometry(geom: GeometrySpec): void {
        validateGeometrySpec(geom);
        this.geom = cloneGeometry(geom);
        this.field = null;
    }

    setRe(Re: number): void {
        if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(Re)}`);
        this.Re = Re;
        this.field = null;
    }

    /** Fetch and validate the bundle, then create the ORT session. Rejects with the cause named. */
    async load(): Promise<void> {
        if (this.session !== null) return;
        if (this.fetchFn === null) fail("no fetch implementation available for bundle load");
        const fetchJson = async (url: string, what: string): Promise<unknown> => {
            let res: Awaited<ReturnType<FetchLike>>;
            try {
                res = await (this.fetchFn as FetchLike)(url);
            } catch (e) {
                fail(`bundle fetch failed for ${what} at ${url} (${e instanceof Error ? e.message : String(e)})`);
            }
            if (!res.ok) fail(`bundle fetch failed for ${what} at ${url} (status ${res.status})`);
            try {
                return await res.json();
            } catch (e) {
                fail(`bundle JSON parse failed for ${what} at ${url} (${e instanceof Error ? e.message : String(e)})`);
            }
        };
        const fetchBytes = async (url: string, what: string): Promise<ArrayBuffer> => {
            let res: Awaited<ReturnType<FetchLike>>;
            try {
                res = await (this.fetchFn as FetchLike)(url);
            } catch (e) {
                fail(`bundle fetch failed for ${what} at ${url} (${e instanceof Error ? e.message : String(e)})`);
            }
            if (!res.ok) fail(`bundle fetch failed for ${what} at ${url} (status ${res.status})`);
            try {
                return await res.arrayBuffer();
            } catch (e) {
                fail(`bundle body read failed for ${what} at ${url} (${e instanceof Error ? e.message : String(e)})`);
            }
        };
        const manifestRaw = await fetchJson(`${this.baseUrl}/model.json`, "manifest");
        let manifest: V2Manifest;
        try {
            manifest = validateV2Manifest(manifestRaw);
        } catch (e) {
            fail(`bad manifest (${e instanceof Error ? e.message : String(e)})`);
        }
        const normBuf = await fetchBytes(`${this.baseUrl}/${manifest.files.norm.path}`, "norm sidecar");
        const normDigest = await sha256HexV2(normBuf.slice(0));
        let normRaw: unknown;
        try {
            normRaw = JSON.parse(new TextDecoder().decode(new Uint8Array(normBuf)));
        } catch (e) {
            fail(`bad norm sidecar JSON (${e instanceof Error ? e.message : String(e)})`);
        }
        let norm: V2Norm;
        try {
            norm = validateV2Norm(normRaw);
        } catch (e) {
            fail(`bad norm sidecar (${e instanceof Error ? e.message : String(e)})`);
        }
        if (!this.allowSynthetic && bundleIsSynthetic(manifest, norm)) {
            fail("refusing marker-flagged synthetic provenance bundle (string marker only until App wiring adds an explicit provenance contract)");
        }
        if (normDigest.toLowerCase() !== manifest.normSha256.toLowerCase() ||
            normDigest.toLowerCase() !== manifest.files.norm.sha256.toLowerCase()) {
            fail("norm sidecar sha256 mismatch (sidecar is authoritative)");
        }
        const modelBytes = await fetchBytes(`${this.baseUrl}/${manifest.files.model.path}`, "model");
        if (modelBytes.byteLength > SURROGATE_V2_MAX_MODEL_BYTES) {
            fail(`model bytes ${modelBytes.byteLength} exceed cap ${SURROGATE_V2_MAX_MODEL_BYTES}`);
        }
        if (modelBytes.byteLength === 0) fail("model bytes are empty");
        const modelDigest = await sha256HexV2(modelBytes.slice(0));
        if (modelDigest.toLowerCase() !== manifest.files.model.sha256.toLowerCase()) {
            fail("model bytes sha256 mismatch");
        }
        try {
            this.session = await this.createSession(modelBytes.slice(0));
        } catch (e) {
            this.session = null;
            if (e instanceof Error && e.message.startsWith("surrogate-v2: ")) throw e;
            fail(`ONNX session creation failed (${e instanceof Error ? e.message : String(e)})`);
        }
        this.manifest = manifest;
        this.norm = norm;
    }

    /** Run one async inference and cache the frame. Requires load() first. */
    async predictFrame(): Promise<FlowField> {
        if (this.session === null || this.norm === null) fail("bundle not loaded, call load() first");
        const norm = this.norm as V2Norm;
        const { nx, ny, domain } = this.grid;
        const { body } = resolveBody(this.geom, this.U);
        const sdfGrid = buildSdfGrid(body.polygons, this.grid, body.circles);
        const input = buildV2Input(sdfGrid.sdf, sdfGrid.obstacle, this.geom.alphaDeg, this.Re, norm, nx, ny);
        let inputTensor: V2TensorLike;
        try {
            inputTensor = await this.createTensor(input, [1, SURROGATE_V2_IN_CH, ny, nx]);
        } catch (e) {
            fail(`input tensor creation failed (${e instanceof Error ? e.message : String(e)})`);
        }
        let outputs: Record<string, V2TensorLike>;
        try {
            outputs = await (this.session as V2Session).run({ input: inputTensor });
        } catch (e) {
            fail(`ONNX execution failed (${e instanceof Error ? e.message : String(e)})`);
        }
        const found = outputs["output"] ?? Object.values(outputs)[0];
        if (!found) fail("ONNX execution failed (session returned no outputs)");
        const raw = found.data as ArrayLike<number>;
        if (!raw || raw.length !== SURROGATE_V2_OUT_CH * ny * nx) {
            fail(`ONNX output shape mismatch (need 1x${SURROGATE_V2_OUT_CH}x${ny}x${nx})`);
        }
        const field = decodeV2Output(raw, sdfGrid.obstacle, norm, nx, ny, domain, this.U);
        this.field = field;
        this.provenanceNote =
            `surrogate v2 predicted, not validated (unet-v2 base 8, run ${this.manifest?.runId ?? "unknown"})`;
        return field;
    }

    getFrame(): FlowField {
        if (this.field === null) fail("no predicted frame yet, call predictFrame() after load() (async ONNX path has no sync inference)");
        return this.field;
    }

    getProvenance(): Provenance {
        return {
            source: "surrogate",
            label: this.provenanceNote ?? "surrogate v2 predicted, not validated",
            generatedAt: new Date().toISOString(),
            gridLabel: `${this.grid.nx}x${this.grid.ny}`,
            geometryLabel: `${this.geom.kind} at ${this.geom.alphaDeg} deg`,
            note: "v2 surrogate prediction, not validated physics",
        };
    }
}
