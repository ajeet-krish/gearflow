// Phase 3 learned surrogate provider. A compact U-Net maps (normalized SDF,
// solid mask, tiled alpha encoding) to (u, v, Cp) on the fixed 128 by 128
// grid, behind the same FrameSource interface as the analytic path. Falls
// back to the analytic provider on any load or inference failure.
//
// Weight layout (sequential Float32, written by training/export_onnx.py):
// enc1 conv3x3(3->B), conv3x3(B->B), pool, enc2 conv3x3(B->2B),
// conv3x3(2B->2B), pool, enc3 conv3x3(2B->4B), conv3x3(4B->4B), pool,
// bottleneck conv3x3(4B->8B), conv3x3(8B->8B), up, concat, dec3
// conv3x3(12B->4B), conv3x3(4B->4B), up, concat, dec2 conv3x3(6B->2B),
// conv3x3(2B->2B), up, concat, dec1 conv3x3(3B->B), conv3x3(B->B),
// head conv1x1(B->3). Each conv stores weights then bias.
// Pure math in unetForward, IO and fallback in SurrogateFlowProvider.

import type { FlowField, GeometrySpec, GridSpec, SurrogateMeta } from "@/contracts/types";
import { AnalyticFlowProvider, cloneGeometry, type FrameSource } from "./frameSource";
import { resolveBody } from "@/flow/analyticFlow";
import { buildSdfGrid } from "./sdf";
import { circulationCl } from "@/validation/metrics";
import { alphaBand, validateGeometrySpec, validateGridSpec } from "@/contracts/schema";

export const SURROGATE_IN_CH = 3;
export const SURROGATE_OUT_CH = 3;
export const SURROGATE_LEVELS = 3;
export const SURROGATE_DEFAULT_BASE_URL = "surrogate";
export const SURROGATE_NX = 128;
export const SURROGATE_NY = 128;
export const MAX_SURROGATE_BASE = 64;
/** Byte cap checked before any Float32Array view is built over fetched bytes. */
export const MAX_WEIGHTS_BYTES = 64 * 1024 * 1024;
/**
 * Sync inference budget: the sync forward pass is O(cells times base squared),
 * so production weights (128x128, base 32) would freeze the UI thread for
 * seconds. getFrame serves the analytic fallback when nx times ny times base
 * exceeds this cap. The async ONNX path (Phase 4, onnxruntime-web) is the real
 * fix; this gate only keeps the sync demo path honest until then.
 */
export const MAX_SYNC_CELLS_TIMES_BASE = 65536;

/** True when the sync forward pass fits the UI thread budget. */
export function syncInferenceAllowed(nx: number, ny: number, base: number): boolean {
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || !Number.isInteger(base)) return false;
    if (nx <= 0 || ny <= 0 || base <= 0) return false;
    return nx * ny * base <= MAX_SYNC_CELLS_TIMES_BASE;
}
const WEIGHTS_FILE_RE = /^[A-Za-z0-9._-]+\.bin$/;
const SHA256_RE = /^[0-9a-fA-F]{64}$/;

export interface SurrogateNorm {
    sdfMean: number;
    sdfStd: number;
    alphaScale: number;
    uMean: number;
    uStd: number;
    vMean: number;
    vStd: number;
    cpMean: number;
    cpStd: number;
}

export interface SurrogateManifest {
    version: string;
    nx: number;
    ny: number;
    inCh: number;
    outCh: number;
    base: number;
    norm: SurrogateNorm;
    weightsFile: string;
    weightsSha256: string;
    paramCount: number;
}

export interface LoadedWeights {
    manifest: SurrogateManifest;
    params: Float32Array;
}

function requireFinite(value: number, context: string): void {
    if (!Number.isFinite(value)) {
        throw new Error(`surrogate: ${context} must be finite, got ${String(value)}`);
    }
}

/** Total Float32 params for the fixed 3 level U-Net at a given base width. */
export function expectedParamCount(base: number): number {
    if (!Number.isInteger(base) || base < 1 || base > MAX_SURROGATE_BASE) {
        throw new Error(`surrogate: base must be an integer in [1, ${MAX_SURROGATE_BASE}], got ${String(base)}`);
    }
    const conv = (inCh: number, outCh: number, k: number): number => outCh * inCh * k * k + outCh;
    const b = base;
    return (
        conv(3, b, 3) + conv(b, b, 3) +
        conv(b, 2 * b, 3) + conv(2 * b, 2 * b, 3) +
        conv(2 * b, 4 * b, 3) + conv(4 * b, 4 * b, 3) +
        conv(4 * b, 8 * b, 3) + conv(8 * b, 8 * b, 3) +
        conv(12 * b, 4 * b, 3) + conv(4 * b, 4 * b, 3) +
        conv(6 * b, 2 * b, 3) + conv(2 * b, 2 * b, 3) +
        conv(3 * b, b, 3) + conv(b, b, 3) +
        conv(b, 3, 1)
    );
}

/** Validate a fetched manifest against the fixed architecture contract. */
export function validateManifest(raw: unknown): SurrogateManifest {
    if (typeof raw !== "object" || raw === null) {
        throw new Error("surrogate: manifest must be an object");
    }
    const m = raw as Record<string, unknown>;
    if (typeof m.version !== "string" || m.version === "") {
        throw new Error("surrogate: manifest.version must be a non-empty string");
    }
    for (const k of ["nx", "ny", "inCh", "outCh", "base", "paramCount"] as const) {
        if (!Number.isInteger(m[k]) || (m[k] as number) <= 0) {
            throw new Error(`surrogate: manifest.${k} must be a positive integer`);
        }
    }
    const manifest = m as unknown as SurrogateManifest;
    if (manifest.base < 1 || manifest.base > MAX_SURROGATE_BASE) {
        throw new Error(`surrogate: manifest.base must be in [1, ${MAX_SURROGATE_BASE}], got ${String(manifest.base)}`);
    }
    if (manifest.nx !== SURROGATE_NX || manifest.ny !== SURROGATE_NY) {
        throw new Error(`surrogate: manifest grid ${String(manifest.nx)}x${String(manifest.ny)} must be ${SURROGATE_NX}x${SURROGATE_NY}`);
    }
    if (manifest.inCh !== SURROGATE_IN_CH || manifest.outCh !== SURROGATE_OUT_CH) {
        throw new Error(
            `surrogate: manifest channels ${manifest.inCh}->${manifest.outCh} do not match ${SURROGATE_IN_CH}->${SURROGATE_OUT_CH}`,
        );
    }
    const expected = expectedParamCount(manifest.base);
    if (manifest.paramCount !== expected) {
        throw new Error(`surrogate: manifest paramCount ${manifest.paramCount} does not match arch (expected ${expected})`);
    }
    const norm = manifest.norm as unknown;
    if (typeof norm !== "object" || norm === null) {
        throw new Error("surrogate: manifest.norm must be a non-null object");
    }
    const n = norm as Record<string, unknown>;
    for (const k of ["sdfMean", "sdfStd", "alphaScale", "uMean", "uStd", "vMean", "vStd", "cpMean", "cpStd"] as const) {
        requireFinite(n[k] as number, `norm.${k}`);
    }
    const typed = norm as SurrogateNorm;
    if (typed.sdfStd <= 0 || typed.uStd <= 0 || typed.vStd <= 0 || typed.cpStd <= 0 || typed.alphaScale <= 0) {
        throw new Error("surrogate: norm std scales must be positive");
    }
    if (typeof manifest.weightsFile !== "string" || manifest.weightsFile === "") {
        throw new Error("surrogate: manifest.weightsFile must be a non-empty string");
    }
    if (
        manifest.weightsFile.includes("/") ||
        manifest.weightsFile.includes("\\") ||
        manifest.weightsFile.includes("..") ||
        !WEIGHTS_FILE_RE.test(manifest.weightsFile)
    ) {
        throw new Error(`surrogate: manifest.weightsFile ${JSON.stringify(manifest.weightsFile)} is not an allowlisted basename`);
    }
    if (typeof manifest.weightsSha256 !== "string" || !SHA256_RE.test(manifest.weightsSha256)) {
        throw new Error("surrogate: manifest.weightsSha256 must be a 64 char lowercase hex digest");
    }
    return manifest;
}

/** SHA-256 hex of a fetched weights buffer, via WebCrypto. */
export async function sha256Hex(buf: ArrayBuffer): Promise<string> {
    const cryptoObj = (globalThis as unknown as { crypto?: { subtle?: SubtleCrypto } }).crypto;
    if (!cryptoObj?.subtle) {
        throw new Error("surrogate: WebCrypto subtle is unavailable for hash verification");
    }
    const digest = await cryptoObj.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function conv2d(
    input: Float32Array,
    nx: number,
    ny: number,
    inCh: number,
    params: Float32Array,
    off: number,
    outCh: number,
    k: number,
    relu: boolean,
): { out: Float32Array; next: number } {
    const wCount = outCh * inCh * k * k;
    if (off + wCount + outCh > params.length) {
        throw new Error(`surrogate: weights truncated at offset ${off} (need ${wCount + outCh} more)`);
    }
    const pad = Math.floor(k / 2);
    const out = new Float32Array(nx * ny * outCh);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            for (let o = 0; o < outCh; o++) {
                let acc = params[off + wCount + o];
                for (let c = 0; c < inCh; c++) {
                    const wBase = off + (o * inCh + c) * k * k;
                    for (let kj = 0; kj < k; kj++) {
                        const jj = j + kj - pad;
                        if (jj < 0 || jj >= ny) continue;
                        for (let ki = 0; ki < k; ki++) {
                            const ii = i + ki - pad;
                            if (ii < 0 || ii >= nx) continue;
                            acc += input[(jj * nx + ii) * inCh + c] * params[wBase + kj * k + ki];
                        }
                    }
                }
                if (relu && acc < 0) acc = 0;
                out[(j * nx + i) * outCh + o] = acc;
            }
        }
    }
    return { out, next: off + wCount + outCh };
}

function maxPool2(input: Float32Array, nx: number, ny: number, ch: number): { out: Float32Array; nx: number; ny: number } {
    if (nx % 2 !== 0 || ny % 2 !== 0) {
        throw new Error(`surrogate: pool needs even dims, got ${nx}x${ny}`);
    }
    const hx = nx / 2;
    const hy = ny / 2;
    const out = new Float32Array(hx * hy * ch);
    for (let j = 0; j < hy; j++) {
        for (let i = 0; i < hx; i++) {
            for (let c = 0; c < ch; c++) {
                const a = input[((2 * j) * nx + 2 * i) * ch + c];
                const b = input[((2 * j) * nx + 2 * i + 1) * ch + c];
                const d = input[((2 * j + 1) * nx + 2 * i) * ch + c];
                const e = input[((2 * j + 1) * nx + 2 * i + 1) * ch + c];
                out[(j * hx + i) * ch + c] = Math.max(a, b, d, e);
            }
        }
    }
    return { out, nx: hx, ny: hy };
}

function upsample2(input: Float32Array, nx: number, ny: number, ch: number): { out: Float32Array; nx: number; ny: number } {
    const dx = nx * 2;
    const dy = ny * 2;
    const out = new Float32Array(dx * dy * ch);
    for (let j = 0; j < dy; j++) {
        for (let i = 0; i < dx; i++) {
            const src = (Math.floor(j / 2) * nx + Math.floor(i / 2)) * ch;
            const dst = (j * dx + i) * ch;
            for (let c = 0; c < ch; c++) out[dst + c] = input[src + c];
        }
    }
    return { out, nx: dx, ny: dy };
}

/**
 * Full U-Net forward pass over the fixed 3 level architecture. Throws on
 * weight length mismatch or non-finite outputs. Deterministic.
 */
export function unetForward(input: Float32Array, weights: LoadedWeights, nx: number, ny: number): Float32Array {
    const { manifest, params } = weights;
    if (manifest.nx !== nx || manifest.ny !== ny) {
        throw new Error(`surrogate: weights target ${manifest.nx}x${manifest.ny}, got ${nx}x${ny}`);
    }
    if (input.length !== nx * ny * SURROGATE_IN_CH) {
        throw new Error(`surrogate: input length ${input.length} does not match ${nx}x${ny}x${SURROGATE_IN_CH}`);
    }
    if (params.length !== manifest.paramCount) {
        throw new Error(`surrogate: weights length ${params.length} does not match manifest ${manifest.paramCount}`);
    }
    const b = manifest.base;
    let off = 0;
    let cur = input;
    let cx = nx;
    let cy = ny;
    const skips: { data: Float32Array; nx: number; ny: number; ch: number }[] = [];
    const widths = [b, 2 * b, 4 * b];
    for (let level = 0; level < SURROGATE_LEVELS; level++) {
        const inCh = level === 0 ? SURROGATE_IN_CH : widths[level] / 2;
        const w = widths[level];
        let r = conv2d(cur, cx, cy, inCh, params, off, w, 3, true);
        off = r.next;
        r = conv2d(r.out, cx, cy, w, params, off, w, 3, true);
        off = r.next;
        skips.push({ data: r.out, nx: cx, ny: cy, ch: w });
        const p = maxPool2(r.out, cx, cy, w);
        cur = p.out;
        cx = p.nx;
        cy = p.ny;
    }
    let r = conv2d(cur, cx, cy, 4 * b, params, off, 8 * b, 3, true);
    off = r.next;
    r = conv2d(r.out, cx, cy, 8 * b, params, off, 8 * b, 3, true);
    off = r.next;
    cur = r.out;
    const decWidths = [4 * b, 2 * b, b];
    for (let level = 0; level < SURROGATE_LEVELS; level++) {
        const skip = skips[SURROGATE_LEVELS - 1 - level];
        const up = upsample2(cur, cx, cy, cur.length / (cx * cy));
        cur = up.out;
        cx = up.nx;
        cy = up.ny;
        if (cx !== skip.nx || cy !== skip.ny) {
            throw new Error(`surrogate: skip shape ${skip.nx}x${skip.ny} does not match upsampled ${cx}x${cy}`);
        }
        const skipCh = skip.data.length / (cx * cy);
        const upCh = cur.length / (cx * cy);
        const merged = new Float32Array(cx * cy * (upCh + skipCh));
        for (let k = 0; k < cx * cy; k++) {
            merged.set(cur.subarray(k * upCh, (k + 1) * upCh), k * (upCh + skipCh));
            merged.set(skip.data.subarray(k * skipCh, (k + 1) * skipCh), k * (upCh + skipCh) + upCh);
        }
        const w = decWidths[level];
        let d = conv2d(merged, cx, cy, upCh + skipCh, params, off, w, 3, true);
        off = d.next;
        d = conv2d(d.out, cx, cy, w, params, off, w, 3, true);
        off = d.next;
        cur = d.out;
    }
    const head = conv2d(cur, cx, cy, b, params, off, SURROGATE_OUT_CH, 1, false);
    off = head.next;
    if (off !== params.length) {
        throw new Error(`surrogate: ${params.length - off} trailing weights unconsumed`);
    }
    for (let k = 0; k < head.out.length; k++) {
        if (!Number.isFinite(head.out[k])) {
            throw new Error(`surrogate: non-finite network output at index ${k}`);
        }
    }
    return head.out;
}

/**
 * Future ONNX Runtime session path. The pinned onnxruntime-web dependency
 * (package.json) is reserved for an async provider that runs model.onnx
 * from public/surrogate after export. The sync FrameSource here always uses
 * the exact TS forward pass above, so offline behavior and tests never load
 * the wasm backend. On any failure the analytic fallback serves frames.
 */
/** Encode SDF, mask, and alpha into the 3 input channels. */
export function buildSurrogateInput(
    sdf: Float32Array,
    obstacle: Float32Array,
    alphaDeg: number,
    nx: number,
    ny: number,
    norm: SurrogateNorm,
): Float32Array {
    if (sdf.length !== nx * ny || obstacle.length !== nx * ny) {
        throw new Error("buildSurrogateInput: channel length does not match nx * ny");
    }
    requireFinite(alphaDeg, "alphaDeg");
    const out = new Float32Array(nx * ny * SURROGATE_IN_CH);
    const alphaEnc = alphaDeg / norm.alphaScale;
    for (let k = 0; k < nx * ny; k++) {
        const s = Math.max(-3, Math.min(3, sdf[k]));
        out[k * 3] = (s - norm.sdfMean) / norm.sdfStd;
        out[k * 3 + 1] = obstacle[k] > 0.5 ? 1 : 0;
        out[k * 3 + 2] = alphaEnc;
    }
    return out;
}

/** Decode (u, v, Cp) channels into a FlowField with obstacle zeroing. */
export function decodeSurrogateOutput(
    raw: Float32Array,
    obstacle: Float32Array,
    nx: number,
    ny: number,
    domain: { xMin: number; xMax: number; yMin: number; yMax: number },
    norm: SurrogateNorm,
    U: number,
): FlowField {
    if (raw.length !== nx * ny * SURROGATE_OUT_CH) {
        throw new Error("decodeSurrogateOutput: output length does not match nx * ny * 3");
    }
    requireFinite(U, "U");
    const n = nx * ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const mask = new Float32Array(n);
    const q = 0.5 * U * U;
    for (let k = 0; k < n; k++) {
        const uu = raw[k * 3] * norm.uStd + norm.uMean;
        const vv = raw[k * 3 + 1] * norm.vStd + norm.vMean;
        const cp = raw[k * 3 + 2] * norm.cpStd + norm.cpMean;
        if (!Number.isFinite(uu) || !Number.isFinite(vv) || !Number.isFinite(cp)) {
            throw new Error(`decodeSurrogateOutput: non-finite decoded value at index ${k}`);
        }
        mask[k] = obstacle[k];
        if (obstacle[k] > 0.5) continue;
        u[k] = uu;
        v[k] = vv;
        p[k] = cp * q;
    }
    const dx = (domain.xMax - domain.xMin) / (nx - 1);
    const dy = (domain.yMax - domain.yMin) / (ny - 1);
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (mask[k] > 0.5) continue;
            const iL = i > 0 ? i - 1 : i;
            const iR = i < nx - 1 ? i + 1 : i;
            const jB = j > 0 ? j - 1 : j;
            const jT = j < ny - 1 ? j + 1 : j;
            const dvdx = (v[j * nx + iR] - v[j * nx + iL]) / ((iR - iL) * dx || 1);
            const dudy = (u[jT * nx + i] - u[jB * nx + i]) / ((jT - jB) * dy || 1);
            omega[k] = dvdx - dudy;
        }
    }
    return { nx, ny, domain: { ...domain }, u, v, p, omega, obstacle: mask };
}

export interface SurrogateProviderOptions {
    grid: GridSpec;
    geom: GeometrySpec;
    U?: number;
    Re?: number;
    baseUrl?: string;
    fetchFn?: typeof fetch;
    weightsOverride?: LoadedWeights;
}

type FetchFn = (url: string) => Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    json(): Promise<unknown>;
    arrayBuffer(): Promise<ArrayBuffer>;
}>;

/**
 * Surrogate FrameSource with analytic fallback. Call ensureLoaded (async)
 * once; getFrame stays sync and serves the surrogate frame when weights are
 * active, the angle sits in the characterized alpha band, and the weights
 * fit the sync budget, else the analytic fallback. Production
 * weights (128x128, base 32) exceed the sync budget and fall back until the
 * async ONNX path lands in Phase 4. Any load or inference failure keeps
 * the fallback path, never throws from getFrame.
 */
export class SurrogateFlowProvider implements FrameSource {
    readonly label = "surrogate";
    meta: SurrogateMeta = { backend: "analytic-fallback", latencyMs: 0, cached: false, weightsVersion: "none" };
    private fallback: AnalyticFlowProvider;
    private grid: GridSpec;
    private geom: GeometrySpec;
    private U: number;
    private Re: number;
    private baseUrl: string;
    private fetchFn: FetchFn | null;
    private weights: LoadedWeights | null;
    private field: FlowField | null = null;
    private lastKey = "";
    private loadAttempted = false;

    constructor(opts: SurrogateProviderOptions) {
        if (!opts || typeof opts !== "object") throw new Error("SurrogateFlowProvider: options are required");
        validateGridSpec(opts.grid);
        validateGeometrySpec(opts.geom);
        if (opts.U !== undefined && (!Number.isFinite(opts.U) || opts.U <= 0)) {
            throw new Error(`SurrogateFlowProvider: U must be a positive finite number, got ${String(opts.U)}`);
        }
        if (opts.Re !== undefined && (!Number.isFinite(opts.Re) || opts.Re <= 0)) {
            throw new Error(`SurrogateFlowProvider: Re must be a positive finite number, got ${String(opts.Re)}`);
        }
        if (opts.weightsOverride !== undefined && opts.weightsOverride !== null) {
            const override = opts.weightsOverride;
            if (typeof override.manifest !== "object" || override.manifest === null) {
                throw new Error("SurrogateFlowProvider: weightsOverride.manifest must be an object");
            }
            if (!(override.params instanceof Float32Array)) {
                throw new Error("SurrogateFlowProvider: weightsOverride.params must be a Float32Array");
            }
            if (override.params.length !== override.manifest.paramCount) {
                throw new Error("SurrogateFlowProvider: weightsOverride length does not match manifest paramCount");
            }
            const base = override.manifest.base;
            if (!Number.isInteger(base) || base < 1 || base > MAX_SURROGATE_BASE) {
                throw new Error(`SurrogateFlowProvider: weightsOverride base must be in [1, ${MAX_SURROGATE_BASE}]`);
            }
            const norm = override.manifest.norm as unknown as Record<string, unknown>;
            if (typeof norm !== "object" || norm === null) {
                throw new Error("SurrogateFlowProvider: weightsOverride norm must be a non-null object");
            }
            for (const k of ["sdfMean", "sdfStd", "alphaScale", "uMean", "uStd", "vMean", "vStd", "cpMean", "cpStd"] as const) {
                requireFinite(norm[k] as number, `override norm.${k}`);
            }
            const typedNorm = norm as unknown as SurrogateNorm;
            if (
                typedNorm.sdfStd <= 0 || typedNorm.uStd <= 0 || typedNorm.vStd <= 0 ||
                typedNorm.cpStd <= 0 || typedNorm.alphaScale <= 0
            ) {
                throw new Error("SurrogateFlowProvider: weightsOverride norm std scales must be positive");
            }
        }
        this.grid = { nx: opts.grid.nx, ny: opts.grid.ny, domain: { ...opts.grid.domain } };
        this.geom = cloneGeometry(opts.geom);
        this.U = opts.U ?? 1;
        this.Re = opts.Re ?? 1000;
        this.baseUrl = (opts.baseUrl ?? SURROGATE_DEFAULT_BASE_URL).replace(/\/$/, "");
        this.fetchFn = (opts.fetchFn as FetchFn | undefined) ?? (typeof fetch !== "undefined" ? (fetch as unknown as FetchFn) : null);
        this.weights = opts.weightsOverride ?? null;
        this.fallback = new AnalyticFlowProvider(this.grid, this.geom, { U: this.U, Re: opts.Re ?? 1000 });
        if (this.weights !== null) {
            this.meta = { backend: "surrogate", latencyMs: 0, cached: false, weightsVersion: this.weights.manifest.version };
        }
    }

    get loaded(): boolean {
        return this.weights !== null;
    }

    setGeometry(geom: GeometrySpec): void {
        validateGeometrySpec(geom);
        this.geom = cloneGeometry(geom);
        this.fallback.setGeometry(geom);
        this.field = null;
        this.lastKey = "";
    }

    setRe(Re: number): void {
        if (!Number.isFinite(Re) || Re <= 0) {
            throw new Error(`SurrogateFlowProvider: Re must be a positive finite number, got ${String(Re)}`);
        }
        this.Re = Re;
        this.fallback.setRe(Re);
        this.field = null;
        this.lastKey = "";
    }

    /** Fetch manifest plus weights once. Returns true when surrogate is active. */
    async ensureLoaded(): Promise<boolean> {
        if (this.weights !== null) return true;
        if (this.loadAttempted || this.fetchFn === null) return false;
        this.loadAttempted = true;
        try {
            const manifestRes = await this.fetchFn(`${this.baseUrl}/model.json`);
            if (!manifestRes.ok) return false;
            const manifest = validateManifest(await manifestRes.json());
            if (manifest.nx !== this.grid.nx || manifest.ny !== this.grid.ny) return false;
            const weightsRes = await this.fetchFn(`${this.baseUrl}/${manifest.weightsFile}`);
            if (!weightsRes.ok) return false;
            // Pre-check the declared length before materialising the body, so
            // an oversize payload is rejected without a full download buffer.
            // Responses without a headers accessor (unit test mocks) skip this
            // and rely on the post-download byte checks below.
            const declaredHeaders = weightsRes.headers;
            if (declaredHeaders !== undefined && declaredHeaders !== null && typeof declaredHeaders.get === "function") {
                const rawLength = declaredHeaders.get("content-length");
                if (rawLength === null) return false;
                const declared = Number(rawLength);
                if (!Number.isFinite(declared) || declared < 0 || declared > MAX_WEIGHTS_BYTES) return false;
            }
            const buf = await weightsRes.arrayBuffer();
            if (buf.byteLength > MAX_WEIGHTS_BYTES) return false;
            if (buf.byteLength % 4 !== 0) return false;
            if (buf.byteLength !== manifest.paramCount * 4) return false;
            const digest = await sha256Hex(buf.slice(0));
            if (digest.toLowerCase() !== manifest.weightsSha256.toLowerCase()) return false;
            const params = new Float32Array(buf);
            if (params.length !== manifest.paramCount) return false;
            this.weights = { manifest, params };
            this.meta = { backend: "surrogate", latencyMs: 0, cached: false, weightsVersion: manifest.version };
            return true;
        } catch {
            return false;
        }
    }

    getFrame(): FlowField {
        const key = JSON.stringify({ geom: this.geom, grid: this.grid, Re: this.Re, U: this.U });
        if (this.field !== null && key === this.lastKey) {
            this.meta = { ...this.meta, cached: true };
            return this.field;
        }
        // Surrogate training only covers the characterized alpha band, so
        // out of band angles serve the analytic fallback with an honest
        // backend label even when sync inference would fit the budget.
        // Production base 32 weights stay sync gated below as before.
        const inBand = alphaBand(this.geom.alphaDeg) === "characterized";
        if (inBand && this.weights !== null && syncInferenceAllowed(this.grid.nx, this.grid.ny, this.weights.manifest.base)) {
            try {
                const t0 = Date.now();
                const frame = this.runInference();
                this.meta = { backend: "surrogate", latencyMs: Date.now() - t0, cached: false, weightsVersion: this.weights.manifest.version };
                this.field = frame;
                this.lastKey = key;
                return frame;
            } catch (e) {
                console.error("Surrogate inference failure, using analytic fallback:", e instanceof Error ? e.message : String(e));
            }
        }
        const frame = this.fallback.getFrame();
        this.meta = { ...this.meta, backend: "analytic-fallback", cached: false };
        this.field = frame;
        this.lastKey = key;
        return frame;
    }

    getResult(): { cl: number; cpMin: number; solveMs: number; panelCount: number } {
        const frame = this.getFrame();
        const cl = circulationCl(frame, this.U, this.geom.chord);
        let cpMin = Infinity;
        const q = 0.5 * this.U * this.U;
        for (let k = 0; k < frame.p.length; k++) {
            if (frame.obstacle[k] > 0.5) continue;
            const cp = frame.p[k] / q;
            if (cp < cpMin) cpMin = cp;
        }
        if (!Number.isFinite(cpMin)) {
            throw new Error("surrogate: cpMin has no fluid cells (all-obstacle frame)");
        }
        return { cl, cpMin, solveMs: this.meta.latencyMs, panelCount: 0 };
    }

    private runInference(): FlowField {
        const weights = this.weights;
        if (weights === null) throw new Error("surrogate: weights not loaded");
        const { nx, ny, domain } = this.grid;
        const { body } = resolveBody(this.geom, this.U);
        const sdfGrid = buildSdfGrid(body.polygons, this.grid, body.circles);
        const input = buildSurrogateInput(sdfGrid.sdf, sdfGrid.obstacle, this.geom.alphaDeg, nx, ny, weights.manifest.norm);
        const raw = unetForward(input, weights, nx, ny);
        return decodeSurrogateOutput(raw, sdfGrid.obstacle, nx, ny, domain, weights.manifest.norm, this.U);
    }
}
