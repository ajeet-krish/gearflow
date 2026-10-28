// v3 surrogate ONNX provider (unet-v3, 4 input channels, 10 spatial heads plus 3 aux scalars).
// Async only. Loads model.onnx plus norm.json plus model.json from a base
// URL, validates the manifest, verifies sha256 digests, builds the model
// input on the canonical 128 grid exactly like v2 (sdf, mask, alpha, logRe),
// runs the injected ORT session, then applies the training sidecar
// normalization: inputs standardized per sidecar, mean heads destandardized,
// recirc through sigmoid, tke through expm1, harmonic heads destandardized
// with mean forced to 0 so a zero prediction decodes to exact zero, solids
// zeroed on every head. Aux heads decode to a Strouhal scalar, an explained
// variance scalar, and a validity probability. Four gates can mark the frame
// harmonic invalid (probability, explained, Strouhal range, RMS floor); a
// failed gate degrades to a steady render, it never throws. A per cell
// energy cap keeps harmonic energy within 1.2 times tke plus a small floor.
// Marker flagged synthetic provenance bundles are refused unless the caller
// passes allowSynthetic (tests only). No network at import: fetch, tensor,
// and session factories are injectable. No UI wiring here.

import type { Domain, FlowField, GeometrySpec, GridSpec, Provenance } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { cloneGeometry, type FrameSource } from "./frameSource";
import { resolveBody } from "./analyticFlow";
import { buildSdfGrid } from "./sdf";

export const SURROGATE_V3_NX = 128;
export const SURROGATE_V3_NY = 128;
export const SURROGATE_V3_IN_CH = 4;
export const SURROGATE_V3_OUT_CH = 10;
export const SURROGATE_V3_AUX_CH = 3;
export const SURROGATE_V3_BASE = 8;
export const SURROGATE_V3_ARCH = "unet-v3";
export const SURROGATE_V3_OPSET = 18;
export const SURROGATE_V3_VERSION = "3";
export const SURROGATE_V3_TOLERANCE = 1e-4;
export const SURROGATE_V3_SDF_CLIP = 3;
export const SURROGATE_V3_NORM_SCHEMA = "gearflow-surrogate-norm/v3";
export const SURROGATE_V3_DEFAULT_BASE_URL = "surrogate/v3";
/** Byte cap checked before any model buffer is handed to the session. */
export const SURROGATE_V3_MAX_MODEL_BYTES = 64 * 1024 * 1024;
/** Canonical v3 domain: x in [-0.5, 2.0], y in [-1.0, 1.0]. */
export const SURROGATE_V3_DOMAIN: Domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };

/** Spatial head order in the ONNX (batch, 10, 128, 128) tensor. */
export const SURROGATE_V3_OUT_HEADS = [
    "meanU",
    "meanV",
    "cp",
    "vorticity",
    "tke",
    "recirc",
    "uCos",
    "uSin",
    "vCos",
    "vSin",
] as const;

/** Aux scalar order in the ONNX (batch, 3) tensor. */
export const SURROGATE_V3_AUX_HEADS = ["strouhalNorm", "explainedLogit", "harmonicValidLogit"] as const;

/** Strouhal validity range for the harmonic gates. */
export const SURROGATE_V3_ST_MIN = 0.03;
export const SURROGATE_V3_ST_MAX = 0.5;
/** Explained variance floor for the harmonic gates. */
export const SURROGATE_V3_EXPLAINED_MIN = 0.35;
/** Validity probability floor for the harmonic gates. */
export const SURROGATE_V3_VALID_PROB_MIN = 0.5;
/** RMS harmonic amplitude floor over fluid cells for the harmonic gates. */
export const SURROGATE_V3_RMS_MIN = 0.002;
/** Energy cap ratio: harmonic energy per cell stays within this factor of tke. */
export const SURROGATE_V3_ENERGY_RATIO = 1.2;
/** Energy cap floor added to the allowed harmonic energy per cell. */
export const SURROGATE_V3_ENERGY_FLOOR = 1e-4;

const FILE_RE = /^[A-Za-z0-9._-]+\.(onnx|json)$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

export interface V3Stat {
    mean: number;
    std: number;
}

/** v3 normalization descriptor, locked to InstanceNormalization (mirrors training/dataset_v3.py). */
export interface V3Normalization {
    operator: "InstanceNormalization";
    groups: null;
    eps: number;
}

export interface V3Norm {
    schema: string;
    alphaScale: number;
    /** v3 normalization descriptor, required (GroupNorm sidecars are rejected). */
    normalization: V3Normalization;
    inputs: {
        sdf: V3Stat;
        logRe: V3Stat;
    };
    outputs: {
        meanU: V3Stat;
        meanV: V3Stat;
        cp: V3Stat;
        vorticity: V3Stat;
        tke: V3Stat;
        uCos: V3Stat;
        uSin: V3Stat;
        vCos: V3Stat;
        vSin: V3Stat;
    };
    aux: {
        strouhal: V3Stat;
    };
    fittedOn?: string;
}

export interface V3ManifestFile {
    path: string;
    sha256: string;
}

export interface V3Manifest {
    version: string;
    arch: string;
    base: number;
    inCh: number;
    outCh: number;
    auxCh: number;
    nx: number;
    ny: number;
    opset: number;
    files: {
        model: V3ManifestFile;
        norm: V3ManifestFile;
    };
    normSha256: string;
    runId?: string;
    provenance?: unknown;
}

/** Minimal tensor view shared by the real ORT session and test doubles. */
export interface V3TensorLike {
    readonly data: ArrayLike<number>;
    readonly dims: readonly number[];
}

export interface V3Session {
    run(feeds: Record<string, V3TensorLike>): Promise<Record<string, V3TensorLike>>;
}

export type V3SessionFactory = (modelBytes: ArrayBuffer) => Promise<V3Session>;
export type V3TensorFactory = (data: Float32Array, dims: readonly number[]) => Promise<V3TensorLike> | V3TensorLike;

export interface SurrogateV3Options {
    grid: GridSpec;
    geom: GeometrySpec;
    U?: number;
    Re?: number;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    createSession?: V3SessionFactory;
    createTensor?: V3TensorFactory;
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
    throw new Error(`surrogate-v3: ${cause}`);
}

function requireFinite(value: number, context: string): void {
    if (!Number.isFinite(value)) fail(`${context} must be finite, got ${String(value)}`);
}

function requireStat(raw: unknown, context: string, minStd: number): V3Stat {
    if (typeof raw !== "object" || raw === null) fail(`${context} must be an object`);
    const rec = raw as Record<string, unknown>;
    requireFinite(rec.mean as number, `${context}.mean`);
    requireFinite(rec.std as number, `${context}.std`);
    const std = rec.std as number;
    if (!(std >= minStd)) fail(`${context}.std must be at least ${minStd}, got ${String(std)}`);
    return { mean: rec.mean as number, std };
}

function requireFile(raw: unknown, context: string): V3ManifestFile {
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

/** Validate a fetched v3 browser manifest against the locked contract. */
export function validateV3Manifest(raw: unknown): V3Manifest {
    if (typeof raw !== "object" || raw === null) fail("manifest must be an object");
    const m = raw as Record<string, unknown>;
    if (m.version !== SURROGATE_V3_VERSION) fail(`manifest.version must be ${JSON.stringify(SURROGATE_V3_VERSION)}, got ${JSON.stringify(m.version)}`);
    if (m.arch !== SURROGATE_V3_ARCH) fail(`manifest.arch must be ${JSON.stringify(SURROGATE_V3_ARCH)}, got ${JSON.stringify(m.arch)}`);
    if (m.base !== SURROGATE_V3_BASE) fail(`manifest.base is locked to ${SURROGATE_V3_BASE}, got ${JSON.stringify(m.base)}`);
    if (m.inCh !== SURROGATE_V3_IN_CH || m.outCh !== SURROGATE_V3_OUT_CH) {
        fail(`manifest spatial channels ${String(m.inCh)} to ${String(m.outCh)} do not match ${SURROGATE_V3_IN_CH} to ${SURROGATE_V3_OUT_CH}`);
    }
    if (m.auxCh !== SURROGATE_V3_AUX_CH) {
        fail(`manifest.auxCh must be ${SURROGATE_V3_AUX_CH}, got ${JSON.stringify(m.auxCh)}`);
    }
    if (m.nx !== SURROGATE_V3_NX || m.ny !== SURROGATE_V3_NY) {
        fail(`manifest grid ${String(m.nx)}x${String(m.ny)} must be ${SURROGATE_V3_NX}x${SURROGATE_V3_NY}`);
    }
    if (m.opset !== SURROGATE_V3_OPSET) fail(`manifest.opset must be ${SURROGATE_V3_OPSET}, got ${JSON.stringify(m.opset)}`);
    if (typeof m.files !== "object" || m.files === null) fail("manifest.files must be an object");
    const files = m.files as Record<string, unknown>;
    const model = requireFile(files.model, "manifest.files.model");
    const norm = requireFile(files.norm, "manifest.files.norm");
    if (typeof m.normSha256 !== "string" || !SHA256_RE.test(m.normSha256)) {
        fail("manifest.normSha256 must be a 64 char hex digest");
    }
    if (m.runId !== undefined && typeof m.runId !== "string") fail("manifest.runId must be a string when present");
    return {
        version: "3",
        arch: SURROGATE_V3_ARCH,
        base: SURROGATE_V3_BASE,
        inCh: SURROGATE_V3_IN_CH,
        outCh: SURROGATE_V3_OUT_CH,
        auxCh: SURROGATE_V3_AUX_CH,
        nx: SURROGATE_V3_NX,
        ny: SURROGATE_V3_NY,
        opset: SURROGATE_V3_OPSET,
        files: { model, norm },
        normSha256: (m.normSha256 as string).toLowerCase(),
        runId: m.runId as string | undefined,
        provenance: m.provenance,
    };
}

/** Validate the required norm.normalization descriptor (locked contract, mirrors training/dataset_v3.py). */
function validateV3Normalization(raw: unknown): V3Normalization {
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

/** Validate the norm.json sidecar shape (mirrors training/dataset_v3.py). */
export function validateV3Norm(raw: unknown): V3Norm {
    if (typeof raw !== "object" || raw === null) fail("norm sidecar must be an object");
    const n = raw as Record<string, unknown>;
    if (n.schema !== SURROGATE_V3_NORM_SCHEMA) {
        fail(`norm schema must be ${JSON.stringify(SURROGATE_V3_NORM_SCHEMA)}, got ${JSON.stringify(n.schema)}`);
    }
    requireFinite(n.alphaScale as number, "norm.alphaScale");
    if (!((n.alphaScale as number) > 0)) fail(`norm.alphaScale must be positive, got ${String(n.alphaScale)}`);
    const normalization = validateV3Normalization(n.normalization);
    if (typeof n.inputs !== "object" || n.inputs === null) fail("norm.inputs must be an object");
    if (typeof n.outputs !== "object" || n.outputs === null) fail("norm.outputs must be an object");
    if (typeof n.aux !== "object" || n.aux === null) fail("norm.aux must be an object");
    const inputs = n.inputs as Record<string, unknown>;
    const outputs = n.outputs as Record<string, unknown>;
    const aux = n.aux as Record<string, unknown>;
    const sdf = requireStat(inputs.sdf, "norm.inputs.sdf", 1e-6);
    const logRe = requireStat(inputs.logRe, "norm.inputs.logRe", 1e-6);
    const meanU = requireStat(outputs.meanU, "norm.outputs.meanU", 1e-6);
    const meanV = requireStat(outputs.meanV, "norm.outputs.meanV", 1e-6);
    const cp = requireStat(outputs.cp, "norm.outputs.cp", 1e-6);
    const vorticity = requireStat(outputs.vorticity, "norm.outputs.vorticity", 1e-6);
    const tke = requireStat(outputs.tke, "norm.outputs.tke", 1e-6);
    const uCos = requireStat(outputs.uCos, "norm.outputs.uCos", 1e-6);
    const uSin = requireStat(outputs.uSin, "norm.outputs.uSin", 1e-6);
    const vCos = requireStat(outputs.vCos, "norm.outputs.vCos", 1e-6);
    const vSin = requireStat(outputs.vSin, "norm.outputs.vSin", 1e-6);
    const strouhal = requireStat(aux.strouhal, "norm.aux.strouhal", 1e-6);
    const fittedOn = n.fittedOn;
    if (fittedOn !== undefined && typeof fittedOn !== "string") fail("norm.fittedOn must be a string when present");
    return {
        schema: SURROGATE_V3_NORM_SCHEMA,
        alphaScale: n.alphaScale as number,
        normalization,
        inputs: { sdf, logRe },
        outputs: { meanU, meanV, cp, vorticity, tke, uCos, uSin, vCos, vSin },
        aux: { strouhal },
        fittedOn: fittedOn as string | undefined,
    };
}

/** True when the bundle carries a synthetic marker (string match only, until App wiring adds an explicit provenance contract). */
export function bundleIsSyntheticV3(manifest: V3Manifest, norm: V3Norm): boolean {
    const hay = JSON.stringify(manifest.provenance ?? {}).toLowerCase();
    if (hay.includes("synthetic")) return true;
    if (typeof norm.fittedOn === "string" && norm.fittedOn.toLowerCase().includes("synthetic")) return true;
    return false;
}

/** SHA-256 hex of a fetched buffer, via WebCrypto. */
export async function sha256HexV3(buf: ArrayBuffer): Promise<string> {
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
 * Identical to v2, mirrors training/dataset_v3.py normalize_sample_v3 inputs:
 * SDF clipped to (-3, 3) then standardized, mask identity 0/1, alpha degrees
 * tiled over alphaScale, log10(Re) standardized. At the canonical 128 grid no
 * resampling is needed, so the freestream fill for outside domain cells is
 * not applicable here.
 */
export function buildV3Input(
    sdf: Float32Array,
    obstacle: Float32Array,
    alphaDeg: number,
    Re: number,
    norm: V3Norm,
    nx: number = SURROGATE_V3_NX,
    ny: number = SURROGATE_V3_NY,
): Float32Array {
    if (nx !== SURROGATE_V3_NX || ny !== SURROGATE_V3_NY) {
        fail(`canonical v3 grid is ${SURROGATE_V3_NX}x${SURROGATE_V3_NY}, got ${nx}x${ny}`);
    }
    if (sdf.length !== nx * ny || obstacle.length !== nx * ny) {
        fail("buildV3Input: channel length does not match nx * ny");
    }
    requireFinite(alphaDeg, "alphaDeg");
    if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(Re)}`);
    const logRe = Math.log10(Re);
    const logReN = (logRe - norm.inputs.logRe.mean) / norm.inputs.logRe.std;
    const alphaN = alphaDeg / norm.alphaScale;
    if (!Number.isFinite(logReN) || !Number.isFinite(alphaN)) fail("buildV3Input: normalized alpha or logRe is not finite");
    const out = new Float32Array(SURROGATE_V3_IN_CH * ny * nx);
    const plane = ny * nx;
    for (let k = 0; k < nx * ny; k += 1) {
        const s = sdf[k];
        const m = obstacle[k];
        if (!Number.isFinite(s)) fail(`buildV3Input: non-finite sdf at index ${k}`);
        if (!(m === 0 || m === 1)) fail(`buildV3Input: mask must be 0 or 1, got ${String(m)} at index ${k}`);
        const clipped = Math.max(-SURROGATE_V3_SDF_CLIP, Math.min(SURROGATE_V3_SDF_CLIP, s));
        out[k] = (clipped - norm.inputs.sdf.mean) / norm.inputs.sdf.std;
        out[plane + k] = m;
        out[2 * plane + k] = alphaN;
        out[3 * plane + k] = logReN;
    }
    for (let k = 0; k < out.length; k += 1) {
        if (!Number.isFinite(out[k])) fail(`buildV3Input: non-finite normalized input at index ${k}`);
    }
    return out;
}

/**
 * Decode a raw ONNX spatial (1, 10, 128, 128) output plus the aux (3,)
 * scalars into a FlowField. Mirrors the training contract: destandardize
 * the five regression heads, sigmoid the recirc logit, expm1 the tke log
 * head clipped at zero, destandardize the four harmonic heads with mean
 * forced to 0 (a zero prediction decodes to exact zero) using the paired
 * sidecar std values, zero every head on solid cells. Aux scalars decode to
 * a Strouhal prediction, an explained variance prediction, and a validity
 * probability. The four harmonic gates mark harmonicValid false with the
 * first failing reason; a failed gate degrades to a steady render and never
 * throws. The energy safety cap rescales harmonic amplitudes per fluid cell
 * so (uCos^2 + uSin^2 + vCos^2 + vSin^2) / 4 stays within 1.2 times tke plus
 * a small floor, using one common factor per cell, and records the rescaled
 * cell count on the returned field.
 */
export function decodeV3Output(
    rawSpatial: ArrayLike<number>,
    rawAux: ArrayLike<number>,
    obstacle: Float32Array,
    norm: V3Norm,
    nx: number,
    ny: number,
    domain: Domain,
    U: number,
): FlowField {
    if (nx !== SURROGATE_V3_NX || ny !== SURROGATE_V3_NY) {
        fail(`canonical v3 grid is ${SURROGATE_V3_NX}x${SURROGATE_V3_NY}, got ${nx}x${ny}`);
    }
    if (rawSpatial.length !== SURROGATE_V3_OUT_CH * ny * nx) {
        fail(`decodeV3Output: spatial length ${rawSpatial.length} does not match 1x${SURROGATE_V3_OUT_CH}x${ny}x${nx}`);
    }
    if (rawAux.length !== SURROGATE_V3_AUX_CH) {
        fail(`decodeV3Output: aux length ${rawAux.length} does not match ${SURROGATE_V3_AUX_CH}`);
    }
    if (obstacle.length !== nx * ny) fail("decodeV3Output: obstacle length does not match nx * ny");
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
    const uCos = new Float32Array(n);
    const uSin = new Float32Array(n);
    const vCos = new Float32Array(n);
    const vSin = new Float32Array(n);
    const mask = new Float32Array(n);
    const q = 0.5 * U * U;
    let cappedCells = 0;
    let fluidCount = 0;
    let sumSq = 0;
    for (let j = 0; j < ny; j += 1) {
        for (let i = 0; i < nx; i += 1) {
            const c = j * nx + i;
            const solid = obstacle[c] > 0.5;
            mask[c] = obstacle[c];
            if (solid) continue;
            fluidCount += 1;
            const at = (h: number): number => rawSpatial[h * n + c] as number;
            const vals = [at(0), at(1), at(2), at(3), at(4)];
            for (let h = 0; h < vals.length; h += 1) {
                if (!Number.isFinite(vals[h])) fail(`decodeV3Output: non-finite head ${h} at cell ${c}`);
            }
            const harm = [at(6), at(7), at(8), at(9)];
            for (let h = 0; h < harm.length; h += 1) {
                if (!Number.isFinite(harm[h])) fail(`decodeV3Output: non-finite harmonic head ${h} at cell ${c}`);
            }
            const logit = at(5);
            if (!Number.isFinite(logit)) fail(`decodeV3Output: non-finite recirc logit at cell ${c}`);
            const tkeLog = vals[4] * stats[4].std + stats[4].mean;
            const tkePhys = Math.max(Math.expm1(tkeLog), 0);
            const uc = (harm[0] as number) * norm.outputs.uCos.std;
            const us = (harm[1] as number) * norm.outputs.uSin.std;
            const vc = (harm[2] as number) * norm.outputs.vCos.std;
            const vs = (harm[3] as number) * norm.outputs.vSin.std;
            const energy = (uc * uc + us * us + vc * vc + vs * vs) / 4;
            const allowed = SURROGATE_V3_ENERGY_RATIO * tkePhys + SURROGATE_V3_ENERGY_FLOOR;
            let scale = 1;
            if (energy > allowed) scale = Math.sqrt(allowed / energy);
            uMean[c] = vals[0] * stats[0].std + stats[0].mean;
            vMean[c] = vals[1] * stats[1].std + stats[1].mean;
            const cpPhys = vals[2] * stats[2].std + stats[2].mean;
            omega[c] = vals[3] * stats[3].std + stats[3].mean;
            k[c] = tkePhys;
            recirc[c] = sigmoid(logit);
            p[c] = cpPhys * q;
            uCos[c] = uc * scale;
            uSin[c] = us * scale;
            vCos[c] = vc * scale;
            vSin[c] = vs * scale;
            if (scale < 1) cappedCells += 1;
            sumSq += (uCos[c] * uCos[c] + uSin[c] * uSin[c] + vCos[c] * vCos[c] + vSin[c] * vSin[c]) / 4;
            if (!Number.isFinite(uMean[c]) || !Number.isFinite(vMean[c]) || !Number.isFinite(p[c]) ||
                !Number.isFinite(omega[c]) || !Number.isFinite(k[c]) || !Number.isFinite(recirc[c]) ||
                !Number.isFinite(uCos[c]) || !Number.isFinite(uSin[c]) ||
                !Number.isFinite(vCos[c]) || !Number.isFinite(vSin[c])) {
                fail(`decodeV3Output: non-finite decoded value at cell ${c}`);
            }
        }
    }
    const auxVals = [rawAux[0] as number, rawAux[1] as number, rawAux[2] as number];
    for (let h = 0; h < auxVals.length; h += 1) {
        if (!Number.isFinite(auxVals[h])) fail(`decodeV3Output: non-finite aux head ${h}`);
    }
    const strouhalPredicted = (auxVals[0] as number) * norm.aux.strouhal.std + norm.aux.strouhal.mean;
    const explainedPredicted = sigmoid(auxVals[1] as number);
    const validityProbability = sigmoid(auxVals[2] as number);
    const rms = fluidCount > 0 ? Math.sqrt(sumSq / fluidCount) : 0;
    let harmonicInvalidReason: string | null = null;
    if (!(validityProbability >= SURROGATE_V3_VALID_PROB_MIN)) {
        harmonicInvalidReason =
            `validity probability ${validityProbability.toFixed(4)} below ${SURROGATE_V3_VALID_PROB_MIN}`;
    } else if (!(explainedPredicted >= SURROGATE_V3_EXPLAINED_MIN)) {
        harmonicInvalidReason =
            `explained ${explainedPredicted.toFixed(4)} below ${SURROGATE_V3_EXPLAINED_MIN}`;
    } else if (!Number.isFinite(strouhalPredicted) ||
        strouhalPredicted < SURROGATE_V3_ST_MIN || strouhalPredicted > SURROGATE_V3_ST_MAX) {
        harmonicInvalidReason =
            `strouhal ${String(strouhalPredicted)} outside [${SURROGATE_V3_ST_MIN}, ${SURROGATE_V3_ST_MAX}]`;
    } else if (!(rms >= SURROGATE_V3_RMS_MIN)) {
        harmonicInvalidReason = `harmonic RMS ${rms.toExponential(3)} below ${SURROGATE_V3_RMS_MIN}`;
    }
    const harmonicValid = harmonicInvalidReason === null;
    return {
        nx, ny, domain: { ...domain },
        u: uMean.slice(), v: vMean.slice(), p, omega, obstacle: mask,
        uMean, vMean, k, recirc,
        uCos, uSin, vCos, vSin,
        strouhalPredicted, explainedPredicted, harmonicValid, harmonicInvalidReason,
        validityProbability, cappedCells,
    };
}

/** Pick one tensor from session outputs by preferred names, else by exact data length. */
function takeOutput(
    outputs: Record<string, V3TensorLike>,
    names: ReadonlyArray<string>,
    need: number,
    what: string,
): V3TensorLike {
    for (const name of names) {
        const t = outputs[name];
        if (t !== undefined && t !== null) {
            const data = (t as V3TensorLike).data as ArrayLike<number>;
            if (data !== undefined && data !== null && data.length === need) return t;
        }
    }
    for (const t of Object.values(outputs)) {
        const data = (t as V3TensorLike).data as ArrayLike<number>;
        if (data !== undefined && data !== null && data.length === need) return t as V3TensorLike;
    }
    fail(`ONNX execution failed (session returned no ${what} tensor of length ${need})`);
}

/** Default ORT session factory: dynamic import keeps the wasm backend out of the sync path. */
async function defaultCreateSession(modelBytes: ArrayBuffer): Promise<V3Session> {
    let ort: typeof import("onnxruntime-web");
    try {
        ort = await import("onnxruntime-web");
    } catch (e) {
        fail(`onnxruntime-web import failed (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
        const sess = await ort.InferenceSession.create(modelBytes, { executionProviders: ["wasm"] });
        return {
            run: (feeds) => sess.run(feeds as Record<string, import("onnxruntime-web").Tensor>) as Promise<Record<string, V3TensorLike>>,
        };
    } catch (e) {
        fail(`ONNX session creation failed (${e instanceof Error ? e.message : String(e)})`);
    }
}

async function defaultCreateTensor(data: Float32Array, dims: readonly number[]): Promise<V3TensorLike> {
    const ort = await import("onnxruntime-web");
    return new ort.Tensor("float32", data, [...dims]);
}

/**
 * Async v3 surrogate provider. Implements FrameSource for interface
 * compatibility: call load() once, then predictFrame() per frame; getFrame
 * serves the last predicted frame and throws before the first prediction
 * (there is no sync ONNX inference). All load and inference failures reject
 * with a cause naming error so the caller can keep the analytic frame.
 */
export class SurrogateV3Provider implements FrameSource {
    readonly label = "surrogate-v3";
    private grid: GridSpec;
    private geom: GeometrySpec;
    private U: number;
    private Re: number;
    private baseUrl: string;
    private fetchFn: FetchLike | null;
    private createSession: V3SessionFactory;
    private createTensor: V3TensorFactory;
    private allowSynthetic: boolean;
    private manifest: V3Manifest | null = null;
    private norm: V3Norm | null = null;
    private session: V3Session | null = null;
    private field: FlowField | null = null;
    private provenanceNote: string | null = null;

    constructor(opts: SurrogateV3Options) {
        if (!opts || typeof opts !== "object") fail("options are required");
        validateGridSpec(opts.grid);
        validateGeometrySpec(opts.geom);
        if (opts.grid.nx !== SURROGATE_V3_NX || opts.grid.ny !== SURROGATE_V3_NY) {
            fail(`canonical v3 grid is ${SURROGATE_V3_NX}x${SURROGATE_V3_NY}, got ${opts.grid.nx}x${opts.grid.ny}`);
        }
        const d = opts.grid.domain;
        const c = SURROGATE_V3_DOMAIN;
        if (d.xMin !== c.xMin || d.xMax !== c.xMax || d.yMin !== c.yMin || d.yMax !== c.yMax) {
            fail(`v3 domain must be x [${c.xMin}, ${c.xMax}] y [${c.yMin}, ${c.yMax}], got x [${d.xMin}, ${d.xMax}] y [${d.yMin}, ${d.yMax}]`);
        }
        const U = opts.U ?? 1;
        const Re = opts.Re ?? 1000;
        if (!Number.isFinite(U) || U <= 0) fail(`U must be a positive finite number, got ${String(opts.U)}`);
        if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(opts.Re)}`);
        this.grid = { nx: opts.grid.nx, ny: opts.grid.ny, domain: { ...opts.grid.domain } };
        this.geom = cloneGeometry(opts.geom);
        this.U = U;
        this.Re = Re;
        this.baseUrl = (opts.baseUrl ?? SURROGATE_V3_DEFAULT_BASE_URL).replace(/\/$/, "");
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
        this.provenanceNote = null;
    }

    setRe(Re: number): void {
        if (!Number.isFinite(Re) || Re <= 0) fail(`Re must be a positive finite number, got ${String(Re)}`);
        this.Re = Re;
        this.field = null;
        this.provenanceNote = null;
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
        let manifest: V3Manifest;
        try {
            manifest = validateV3Manifest(manifestRaw);
        } catch (e) {
            fail(`bad manifest (${e instanceof Error ? e.message : String(e)})`);
        }
        const normBuf = await fetchBytes(`${this.baseUrl}/${manifest.files.norm.path}`, "norm sidecar");
        const normDigest = await sha256HexV3(normBuf.slice(0));
        let normRaw: unknown;
        try {
            normRaw = JSON.parse(new TextDecoder().decode(new Uint8Array(normBuf)));
        } catch (e) {
            fail(`bad norm sidecar JSON (${e instanceof Error ? e.message : String(e)})`);
        }
        let norm: V3Norm;
        try {
            norm = validateV3Norm(normRaw);
        } catch (e) {
            fail(`bad norm sidecar (${e instanceof Error ? e.message : String(e)})`);
        }
        if (!this.allowSynthetic && bundleIsSyntheticV3(manifest, norm)) {
            fail("refusing marker-flagged synthetic provenance bundle (string marker only until App wiring adds an explicit provenance contract)");
        }
        if (normDigest.toLowerCase() !== manifest.normSha256.toLowerCase() ||
            normDigest.toLowerCase() !== manifest.files.norm.sha256.toLowerCase()) {
            fail("norm sidecar sha256 mismatch (sidecar is authoritative)");
        }
        const modelBytes = await fetchBytes(`${this.baseUrl}/${manifest.files.model.path}`, "model");
        if (modelBytes.byteLength > SURROGATE_V3_MAX_MODEL_BYTES) {
            fail(`model bytes ${modelBytes.byteLength} exceed cap ${SURROGATE_V3_MAX_MODEL_BYTES}`);
        }
        if (modelBytes.byteLength === 0) fail("model bytes are empty");
        const modelDigest = await sha256HexV3(modelBytes.slice(0));
        if (modelDigest.toLowerCase() !== manifest.files.model.sha256.toLowerCase()) {
            fail("model bytes sha256 mismatch");
        }
        try {
            this.session = await this.createSession(modelBytes.slice(0));
        } catch (e) {
            this.session = null;
            if (e instanceof Error && e.message.startsWith("surrogate-v3: ")) throw e;
            fail(`ONNX session creation failed (${e instanceof Error ? e.message : String(e)})`);
        }
        this.manifest = manifest;
        this.norm = norm;
    }

    /** Run one async inference and cache the frame. Requires load() first. */
    async predictFrame(): Promise<FlowField> {
        if (this.session === null || this.norm === null) fail("bundle not loaded, call load() first");
        const norm = this.norm as V3Norm;
        const { nx, ny, domain } = this.grid;
        const { body } = resolveBody(this.geom, this.U);
        const sdfGrid = buildSdfGrid(body.polygons, this.grid, body.circles);
        const input = buildV3Input(sdfGrid.sdf, sdfGrid.obstacle, this.geom.alphaDeg, this.Re, norm, nx, ny);
        let inputTensor: V3TensorLike;
        try {
            inputTensor = await this.createTensor(input, [1, SURROGATE_V3_IN_CH, ny, nx]);
        } catch (e) {
            fail(`input tensor creation failed (${e instanceof Error ? e.message : String(e)})`);
        }
        let outputs: Record<string, V3TensorLike>;
        try {
            outputs = await (this.session as V3Session).run({ input: inputTensor });
        } catch (e) {
            fail(`ONNX execution failed (${e instanceof Error ? e.message : String(e)})`);
        }
        const n = nx * ny;
        const spatial = takeOutput(outputs, ["output", "spatial"], SURROGATE_V3_OUT_CH * n, "spatial");
        const auxOut = takeOutput(outputs, ["aux", "auxOutput", "scalars"], SURROGATE_V3_AUX_CH, "aux");
        const rawSpatial = spatial.data as ArrayLike<number>;
        const rawAux = auxOut.data as ArrayLike<number>;
        if (!rawSpatial || rawSpatial.length !== SURROGATE_V3_OUT_CH * n) {
            fail(`ONNX output shape mismatch (need 1x${SURROGATE_V3_OUT_CH}x${ny}x${nx})`);
        }
        if (!rawAux || rawAux.length !== SURROGATE_V3_AUX_CH) {
            fail(`ONNX aux shape mismatch (need ${SURROGATE_V3_AUX_CH} scalars)`);
        }
        const field = decodeV3Output(rawSpatial, rawAux, sdfGrid.obstacle, norm, nx, ny, domain, this.U);
        this.field = field;
        this.provenanceNote =
            `surrogate v3 predicted, not validated (unet-v3 base 8, run ${this.manifest?.runId ?? "unknown"})`;
        return field;
    }

    getFrame(): FlowField {
        if (this.field === null) fail("no predicted frame yet, call predictFrame() after load() (async ONNX path has no sync inference)");
        return this.field;
    }

    getProvenance(): Provenance {
        return {
            source: "surrogate",
            label: this.provenanceNote ?? "surrogate v3 predicted, not validated",
            generatedAt: new Date().toISOString(),
            gridLabel: `${this.grid.nx}x${this.grid.ny}`,
            geometryLabel: `${this.geom.kind} at ${this.geom.alphaDeg} deg`,
            note: "v3 surrogate prediction, not validated physics",
        };
    }
}
