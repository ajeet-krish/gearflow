// Neural v3 adapter. Mirrors NeuralV2Adapter exactly: same four channel
// input construction (the predictor stages the same geometry plus Re before
// one inference per case key, so the input path is identical by
// construction), same request key, same Cl and CpMin result math, same last
// frame cache. The decoded v3 field additionally carries the harmonic
// validity plus the first failing gate reason, so the caller can animate a
// phase averaged street when valid and render the steady mean otherwise.
// No network at import: the predictor is injected, tests pass a mock
// predictor. No network at test time, no worker threads.

import type { FlowField, GeometrySpec } from "@/contracts/types";
import {
    isUsableNeuralField,
    neuralRequestKey,
    neuralResultFor,
} from "./neuralV2Adapter";
import type { NeuralStatus } from "./solverRouter";

export const NEURAL_V3_ADAPTER_U = 1;
export const NEURAL_V3_ADAPTER_VERSION = "v3";

export interface NeuralV3PredictorLike {
    readonly loaded: boolean;
    load(): Promise<void>;
    predictFrame(): Promise<FlowField>;
    setGeometry?: (geom: GeometrySpec) => void;
    setRe?: (re: number) => void;
    /** Manifest harmonic capability when the predictor is a SurrogateV3Provider. Absent means unknown (treated as not capable). */
    harmonicCapable?: boolean;
}

export interface NeuralV3Result {
    key: string;
    flow: FlowField;
    cl: number;
    cpMin: number;
    solveMs: number;
    latencyMs: number;
    cached: boolean;
    /** True only when every harmonic gate passed and the street can animate. */
    harmonicValid: boolean;
    /** First failing harmonic gate, null when harmonicValid is true. */
    harmonicInvalidReason: string | null;
    /** Case scalar Strouhal from the v3 aux head, null when not finite. */
    strouhal: number | null;
    /** Case scalar explained variance from the v3 aux head, null when not finite. */
    explained: number | null;
}

/**
 * Stable request key for one case. Identical to the v2 key on purpose: the
 * v3 input is built from the same geometry adapter as v2 (sdf, mask,
 * alpha, logRe on the canonical 128 grid), so one case maps to one key on
 * both paths.
 */
export function neuralV3RequestKey(spec: GeometrySpec, reynolds: number): string {
    return neuralRequestKey(spec, reynolds);
}

/** Harmonic validity plus the reason, read from one decoded v3 field. */
export function harmonicStateForV3Field(flow: FlowField): {
    valid: boolean;
    reason: string | null;
} {
    if (flow.harmonicValid === true) return { valid: true, reason: null };
    const raw = flow.harmonicInvalidReason;
    const reason = typeof raw === "string" && raw.trim().length > 0
        ? raw
        : "no valid shedding";
    return { valid: false, reason };
}

function finiteOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Adapter owning one predictor plus the last frame cache. ensureLoaded maps
 * the provider outcome to router availability. predictFor caches by request
 * key, failed predicts never poison the cache so the next key retries
 * cleanly. Stale callers check the tracker before committing.
 */
export class NeuralV3Adapter {
    private predictor: NeuralV3PredictorLike;
    private U: number;
    private weightsVersion: string;
    private status: NeuralStatus = "unavailable";
    private lastKey: string | null = null;
    private lastFlow: FlowField | null = null;
    private lastResult: { cl: number; cpMin: number; solveMs: number } | null = null;
    private lastHarmonic: { valid: boolean; reason: string | null } | null = null;
    private lastScalars: { strouhal: number | null; explained: number | null } | null = null;
    private lastLatencyMs = 0;
    private harmonicCapableOverride: boolean | null;

    constructor(predictor: NeuralV3PredictorLike, opts?: { U?: number; weightsVersion?: string; harmonicCapable?: boolean }) {
        if (predictor === null || predictor === undefined) {
            throw new Error("neuralV3Adapter: predictor is required");
        }
        const U = opts?.U ?? NEURAL_V3_ADAPTER_U;
        if (!Number.isFinite(U) || U <= 0) {
            throw new Error(`neuralV3Adapter: U must be positive finite, got ${String(U)}`);
        }
        this.predictor = predictor;
        this.U = U;
        const version = opts?.weightsVersion;
        this.weightsVersion = typeof version === "string" && version.length > 0 ? version : NEURAL_V3_ADAPTER_VERSION;
        this.harmonicCapableOverride = typeof opts?.harmonicCapable === "boolean" ? opts.harmonicCapable : null;
    }

    get availability(): NeuralStatus {
        return this.status;
    }

    get version(): string {
        return this.weightsVersion;
    }

    /** Steady-only gate: explicit override wins, else the predictor manifest flag; absent means capable (legacy default). */
    get harmonicCapable(): boolean {
        if (this.harmonicCapableOverride !== null) return this.harmonicCapableOverride;
        const fromPredictor = (this.predictor as NeuralV3PredictorLike).harmonicCapable;
        if (fromPredictor === false) return false;
        return true;
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
        } catch (e) {
            try {
                console.error("[neural-v3] availability load failed:", e instanceof Error ? e.message : String(e));
            } catch { /* never throws */ }
            this.status = "failed";
        }
        return this.status;
    }

    /** Harmonic validity of the last cached frame, null before the first prediction. */
    lastHarmonicState(): { valid: boolean; reason: string | null } | null {
        return this.lastHarmonic;
    }

    /** Predict one case, caching the last frame by request key. */
    async predictFor(spec: GeometrySpec, reynolds: number): Promise<NeuralV3Result> {
        const key = neuralV3RequestKey(spec, reynolds);
        if (this.lastKey === key && this.lastFlow !== null && this.lastResult !== null &&
            this.lastHarmonic !== null && this.lastScalars !== null) {
            return {
                key,
                flow: this.lastFlow,
                cl: this.lastResult.cl,
                cpMin: this.lastResult.cpMin,
                solveMs: this.lastResult.solveMs,
                latencyMs: this.lastLatencyMs,
                cached: true,
                harmonicValid: this.lastHarmonic.valid,
                harmonicInvalidReason: this.lastHarmonic.reason,
                strouhal: this.lastScalars.strouhal,
                explained: this.lastScalars.explained,
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
            throw new Error("neuralV3Adapter: predicted frame failed the usable field gate");
        }
        const harmonic = harmonicStateForV3Field(flow);
        const gatedHarmonic = this.harmonicCapable
            ? harmonic
            : { valid: false as boolean, reason: "harmonic heads disabled (steady-only bundle)" as string | null };
        const scalars = {
            strouhal: finiteOrNull(flow.strouhalPredicted),
            explained: finiteOrNull(flow.explainedPredicted),
        };
        this.lastKey = key;
        this.lastFlow = flow;
        this.lastResult = result;
        this.lastHarmonic = gatedHarmonic;
        this.lastScalars = scalars;
        this.lastLatencyMs = latencyMs;
        return {
            key,
            flow,
            cl: result.cl,
            cpMin: result.cpMin,
            solveMs: result.solveMs,
            latencyMs,
            cached: false,
            harmonicValid: gatedHarmonic.valid,
            harmonicInvalidReason: gatedHarmonic.reason,
            strouhal: scalars.strouhal,
            explained: scalars.explained,
        };
    }

    clear(): void {
        this.lastKey = null;
        this.lastFlow = null;
        this.lastResult = null;
        this.lastHarmonic = null;
        this.lastScalars = null;
        this.lastLatencyMs = 0;
    }
}
