// Neural v2 adapter. Wraps SurrogateV2Provider load plus predict with a
// last frame cache keyed by the case request key. Pure result math lives
// here so App stays wiring only: Cl via circulation over the mean velocity
// channels (v1 pattern), CpMin over fluid cells, solveMs from inference
// latency. No network at test time: the provider is injected, tests pass a
// mock predictor. No worker threads.

import type { FlowField, GeometrySpec } from "@/contracts/types";
import { circulationCl } from "@/validation/metrics";
import type { NeuralStatus } from "./solverRouter";

export const NEURAL_V2_ADAPTER_U = 1;
export const NEURAL_V2_ADAPTER_VERSION = "v2";

export interface NeuralV2PredictorLike {
    readonly loaded: boolean;
    load(): Promise<void>;
    predictFrame(): Promise<FlowField>;
    setGeometry?: (geom: GeometrySpec) => void;
    setRe?: (re: number) => void;
}

export interface NeuralV2Result {
    key: string;
    flow: FlowField;
    cl: number;
    cpMin: number;
    solveMs: number;
    latencyMs: number;
    cached: boolean;
}

/**
 * Stable request key for one case. Every GeometrySpec field that changes
 * the SDF input is included, grid is fixed at the canonical 128 so it is
 * omitted on purpose.
 */
export function neuralRequestKey(spec: GeometrySpec, reynolds: number): string {
    const naca = spec.naca;
    const center = spec.center !== undefined
        ? `${Number(spec.center.x)},${Number(spec.center.y)}`
        : "no-center";
    const polygon = spec.polygon !== undefined
        ? `len${spec.polygon.length}:${spec.polygon.map((p) => `${Number(p.x)},${Number(p.y)}`).join(";")}`
        : "no-poly";
    const parts = [
        spec.kind,
        naca ? `${naca.code}|${naca.m}|${naca.p}|${naca.t}` : "no-naca",
        `a${Number(spec.alphaDeg)}`,
        `re${Number(reynolds)}`,
        `c${Number(spec.chord)}`,
        `r${Number(spec.radius ?? 0)}`,
        `w${Number(spec.width ?? 0)}`,
        `h${Number(spec.height ?? 0)}`,
        `n${Number(spec.nPoints)}`,
        `ctr${center}`,
        `poly${polygon}`,
    ];
    return parts.join("|");
}

/**
 * Result math for a predicted frame. Cl integrates circulation over the
 * mean velocity channels (uMean and vMean when present, else u and v),
 * reusing the v1 circulation pattern. CpMin scans fluid cells only.
 * Throws when no fluid cell exists or values are not finite.
 */
export function neuralResultFor(
    flow: FlowField,
    chord: number,
    latencyMs: number,
    U: number = NEURAL_V2_ADAPTER_U,
): { cl: number; cpMin: number; solveMs: number } {
    if (!Number.isFinite(chord) || chord <= 0) {
        throw new Error(`neuralV2Adapter: chord must be positive finite, got ${String(chord)}`);
    }
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
        throw new Error(`neuralV2Adapter: latencyMs must be finite non negative, got ${String(latencyMs)}`);
    }
    const meanFlow: FlowField = {
        ...flow,
        u: flow.uMean ?? flow.u,
        v: flow.vMean ?? flow.v,
    };
    const cl = circulationCl(meanFlow, U, chord);
    const q = 0.5 * U * U;
    let cpMin = Infinity;
    let fluid = 0;
    for (let k = 0; k < flow.p.length; k += 1) {
        if (flow.obstacle[k] > 0.5) continue;
        const cp = flow.p[k] / q;
        if (!Number.isFinite(cp)) {
            throw new Error(`neuralV2Adapter: non-finite cp at cell ${k}`);
        }
        if (cp < cpMin) cpMin = cp;
        fluid += 1;
    }
    if (fluid === 0 || !Number.isFinite(cpMin)) {
        throw new Error("neuralV2Adapter: cpMin has no fluid cells (all-obstacle frame)");
    }
    return { cl, cpMin, solveMs: latencyMs };
}

/** Poisoned field gate for neural frames. Mirrors the App usable check. */
export function isUsableNeuralField(flow: FlowField, cl: number, cpMin: number): boolean {
    if (!Number.isFinite(cl) || !Number.isFinite(cpMin)) return false;
    if (!Number.isFinite(flow.nx) || !Number.isFinite(flow.ny)) return false;
    const n = flow.nx * flow.ny;
    if (flow.u.length !== n || flow.v.length !== n || flow.p.length !== n || flow.omega.length !== n) return false;
    for (let k = 0; k < n; k += 1) {
        if (!Number.isFinite(flow.u[k]) || !Number.isFinite(flow.v[k]) ||
            !Number.isFinite(flow.p[k]) || !Number.isFinite(flow.omega[k])) {
            return false;
        }
    }
    return true;
}

/** Monotonic request tracker for the App neural effect. Latest only commits. */
export function createNeuralRequestTracker(): {
    next: () => number;
    latest: () => number;
    isLatest: (id: number) => boolean;
} {
    let current = 0;
    return {
        next: () => {
            current += 1;
            return current;
        },
        latest: () => current,
        isLatest: (id: number) => id === current,
    };
}

/**
 * Adapter owning one predictor plus the last frame cache. ensureLoaded maps
 * the provider outcome to router availability. predictFor caches by request
 * key, failed predicts never poison the cache so the next key retries
 * cleanly. Stale callers check the tracker before committing.
 */
export class NeuralV2Adapter {
    private predictor: NeuralV2PredictorLike;
    private U: number;
    private weightsVersion: string;
    private status: NeuralStatus = "unavailable";
    private lastKey: string | null = null;
    private lastFlow: FlowField | null = null;
    private lastResult: { cl: number; cpMin: number; solveMs: number } | null = null;
    private lastLatencyMs = 0;

    constructor(predictor: NeuralV2PredictorLike, opts?: { U?: number; weightsVersion?: string }) {
        if (predictor === null || predictor === undefined) {
            throw new Error("neuralV2Adapter: predictor is required");
        }
        const U = opts?.U ?? NEURAL_V2_ADAPTER_U;
        if (!Number.isFinite(U) || U <= 0) {
            throw new Error(`neuralV2Adapter: U must be positive finite, got ${String(U)}`);
        }
        this.predictor = predictor;
        this.U = U;
        const version = opts?.weightsVersion;
        this.weightsVersion = typeof version === "string" && version.length > 0 ? version : NEURAL_V2_ADAPTER_VERSION;
    }

    get availability(): NeuralStatus {
        return this.status;
    }

    get version(): string {
        return this.weightsVersion;
    }

    setAvailability(next: NeuralStatus): void {
        this.status = next;
    }

    /** Load weights once, mapping the outcome to router availability. */
    async ensureLoaded(): Promise<NeuralStatus> {
        if (this.predictor.loaded) {
            this.status = "ready";
            return this.status;
        }
        this.status = "loading";
        try {
            await this.predictor.load();
            this.status = this.predictor.loaded ? "ready" : "failed";
        } catch {
            this.status = "failed";
        }
        return this.status;
    }

    /** Predict one case, caching the last frame by request key. */
    async predictFor(spec: GeometrySpec, reynolds: number): Promise<NeuralV2Result> {
        const key = neuralRequestKey(spec, reynolds);
        if (this.lastKey === key && this.lastFlow !== null && this.lastResult !== null) {
            return {
                key,
                flow: this.lastFlow,
                cl: this.lastResult.cl,
                cpMin: this.lastResult.cpMin,
                solveMs: this.lastResult.solveMs,
                latencyMs: this.lastLatencyMs,
                cached: true,
            };
        }
        try {
            this.predictor.setGeometry?.(spec);
        } catch {
            // Geometry staging faults surface as predict failures below.
        }
        try {
            this.predictor.setRe?.(reynolds);
        } catch {
            // Re staging faults surface as predict failures below.
        }
        const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
        const flow = await this.predictor.predictFrame();
        const t1 = typeof performance !== "undefined" ? performance.now() : Date.now();
        const latencyMs = Math.max(0, t1 - t0);
        const chord = Number.isFinite(spec.chord) && spec.chord > 0 ? spec.chord : 1;
        const result = neuralResultFor(flow, chord, latencyMs, this.U);
        if (!isUsableNeuralField(flow, result.cl, result.cpMin)) {
            throw new Error("neuralV2Adapter: predicted frame failed the usable field gate");
        }
        this.lastKey = key;
        this.lastFlow = flow;
        this.lastResult = result;
        this.lastLatencyMs = latencyMs;
        return { key, flow, cl: result.cl, cpMin: result.cpMin, solveMs: result.solveMs, latencyMs, cached: false };
    }

    clear(): void {
        this.lastKey = null;
        this.lastFlow = null;
        this.lastResult = null;
        this.lastLatencyMs = 0;
    }
}
