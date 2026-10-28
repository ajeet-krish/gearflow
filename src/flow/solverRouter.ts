// Fast path solver router. Pure and testable, no network or DOM access.
// Decides between the neural-v3 street, the neural-v2 surrogate, and the
// analytic potential fallback, and builds the honest provenance labels for
// each path. Neural output is always labeled predicted, not validated, even
// inside the provisional envelope.

import { classifyNeuralDomain, PROVISIONAL_NEURAL_ENVELOPE, type NeuralEnvelope } from "@/flow/neuralDomain";

/** Where the next frame comes from. */
export type SolverPath = "neural-v3" | "neural-v2" | "analytic";

/** Neural weights readiness from the App wiring. */
export type NeuralStatus = "ready" | "loading" | "failed" | "unavailable";

/** Router input: one case plus the neural weights status. */
export interface FastPathInput {
    body: string;
    alphaDeg: number;
    reynolds: number;
    /** v2 weights readiness. Legacy callers pass this alone. */
    neuralStatus: NeuralStatus;
    /** v3 weights readiness. Absent means the legacy v2 only call path. */
    neuralV3Status?: NeuralStatus;
    envelope?: NeuralEnvelope;
}

/** Router outcome: the path plus the human readable reason. */
export interface SolveDecision {
    path: SolverPath;
    reason: string;
    inDomain: boolean;
}

/**
 * Pick the fast path for one case. The v3 bundle wins when it is ready and
 * the case classifies inside the provisional envelope; v2 is the fallback
 * exactly as before, and every other status or an out of domain case falls
 * back to analytic with the reason naming the cause. Callers without a v3
 * status keep the legacy v2 only behaviour byte for byte.
 */
export function decideFastPath(input: FastPathInput): SolveDecision {
    const envelope = input.envelope ?? PROVISIONAL_NEURAL_ENVELOPE;
    const verdict = classifyNeuralDomain(input.body, input.alphaDeg, input.reynolds, envelope);
    const v3 = input.neuralV3Status;
    if (v3 !== undefined) {
        if (v3 === "ready" && verdict.inDomain) {
            return {
                path: "neural-v3",
                reason: "neural-v3 weights ready and case inside the provisional envelope",
                inDomain: true,
            };
        }
        if (v3 === "ready") {
            return {
                path: "analytic",
                reason: `case outside the provisional neural envelope (${verdict.reason ?? "unclassified"}), analytic fallback`,
                inDomain: false,
            };
        }
        // v3 not ready: fall back to v2 exactly as the legacy path.
        if (input.neuralStatus === "ready" && verdict.inDomain) {
            return {
                path: "neural-v2",
                reason: "neural-v2 weights ready and case inside the provisional envelope",
                inDomain: true,
            };
        }
        if (input.neuralStatus === "ready") {
            return {
                path: "analytic",
                reason: `case outside the provisional neural envelope (${verdict.reason ?? "unclassified"}), analytic fallback`,
                inDomain: false,
            };
        }
        if (v3 === "loading") {
            return {
                path: "analytic",
                reason: "neural-v3 weights still loading, analytic fallback",
                inDomain: verdict.inDomain,
            };
        }
        if (input.neuralStatus === "loading") {
            return {
                path: "analytic",
                reason: "neural-v2 weights still loading, analytic fallback",
                inDomain: verdict.inDomain,
            };
        }
        if (v3 === "failed") {
            return {
                path: "analytic",
                reason: "neural-v3 weights failed to load, analytic fallback",
                inDomain: verdict.inDomain,
            };
        }
        if (input.neuralStatus === "failed") {
            return {
                path: "analytic",
                reason: "neural-v2 weights failed to load, analytic fallback",
                inDomain: verdict.inDomain,
            };
        }
        return {
            path: "analytic",
            reason: "neural-v3 weights unavailable, analytic fallback",
            inDomain: verdict.inDomain,
        };
    }
    if (input.neuralStatus === "ready" && verdict.inDomain) {
        return {
            path: "neural-v2",
            reason: "neural-v2 weights ready and case inside the provisional envelope",
            inDomain: true,
        };
    }
    if (input.neuralStatus === "ready") {
        return {
            path: "analytic",
            reason: `case outside the provisional neural envelope (${verdict.reason ?? "unclassified"}), analytic fallback`,
            inDomain: false,
        };
    }
    if (input.neuralStatus === "loading") {
        return {
            path: "analytic",
            reason: "neural-v2 weights still loading, analytic fallback",
            inDomain: verdict.inDomain,
        };
    }
    if (input.neuralStatus === "failed") {
        return {
            path: "analytic",
            reason: "neural-v2 weights failed to load, analytic fallback",
            inDomain: verdict.inDomain,
        };
    }
    return {
        path: "analytic",
        reason: "neural-v2 weights unavailable, analytic fallback",
        inDomain: verdict.inDomain,
    };
}

/** Options for the neural-v2 provenance label. */
export interface NeuralLabelOptions {
    weightsVersion?: string;
    latencyMs?: number;
    cached?: boolean;
}

/**
 * Provenance label for a neural-v2 frame. Always carries the predicted,
 * not validated honesty marker.
 */
export function neuralProvenanceLabel(opts: NeuralLabelOptions = {}): string {
    const parts: string[] = ["neural-v2 predicted, not validated"];
    const version = typeof opts.weightsVersion === "string" && opts.weightsVersion.length > 0
        ? opts.weightsVersion
        : "weights pending";
    parts.push(`(${version}`);
    if (typeof opts.latencyMs === "number" && Number.isFinite(opts.latencyMs)) {
        parts.push(`${opts.latencyMs.toFixed(1)} ms`);
    }
    if (opts.cached === true) parts.push("cached");
    return `${parts.join(", ")})`;
}

/**
 * Provenance label for an analytic frame. The reason names why analytic
 * served this frame, and the label always carries the potential flow,
 * not validated honesty marker.
 */
export function analyticProvenanceLabel(reason: string): string {
    const cause = reason.trim().length > 0 ? reason.trim() : "analytic path";
    return `analytic potential flow (${cause}), not validated`;
}

/** Four mutually exclusive frame honesty states for the canvas caption. */
export type SolverHonestyState = "solved" | "phase-averaged-modeled" | "steady-predicted" | "analytic-fallback";

/**
 * LBM instantaneous label. The only state that uses the word solved, and it
 * always names the instantaneous snapshot so it cannot read as averaged.
 */
export function lbmSolvedLabel(detail?: string): string {
    const extra = typeof detail === "string" && detail.trim().length > 0 ? ` (${detail.trim()})` : "";
    return `LBM solved, instantaneous snapshot (viscous D2Q9, not time averaged)${extra}`;
}

/** Options for the phase averaged neural label. */
export interface NeuralPhaseAveragedOptions {
    strouhal?: number;
    explained?: number;
    weightsVersion?: string;
    latencyMs?: number;
}

/**
 * Neural phase averaged label. Always contains the word modeled and never
 * the word solved, so it cannot read as a viscous solve.
 */
export function neuralPhaseAveragedLabel(opts: NeuralPhaseAveragedOptions = {}): string {
    const parts: string[] = [];
    if (typeof opts.strouhal === "number" && Number.isFinite(opts.strouhal)) {
        parts.push(`St ${opts.strouhal.toFixed(2)}`);
    }
    if (typeof opts.explained === "number" && Number.isFinite(opts.explained)) {
        parts.push(`explained ${opts.explained.toFixed(2)}`);
    }
    if (typeof opts.weightsVersion === "string" && opts.weightsVersion.length > 0) {
        parts.push(opts.weightsVersion);
    }
    if (typeof opts.latencyMs === "number" && Number.isFinite(opts.latencyMs)) {
        parts.push(`${opts.latencyMs.toFixed(1)} ms`);
    }
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    return `neural-v3 phase averaged, modeled Karman street${detail}, not validated`;
}

/**
 * Neural steady label for frames without valid shedding. The reason names
 * the first failing harmonic gate and is always included.
 */
export function neuralSteadyLabel(reason: string, weightsVersion?: string): string {
    const cause = reason.trim().length > 0 ? reason.trim() : "no valid shedding";
    const version = typeof weightsVersion === "string" && weightsVersion.length > 0
        ? `, ${weightsVersion}`
        : "";
    return `neural-v3 steady predicted, no valid shedding (${cause}${version}), not validated`;
}

/**
 * Analytic fallback label. Names the potential flow preview and the reason
 * analytic served this frame.
 */
export function analyticFallbackLabel(reason: string): string {
    const cause = reason.trim().length > 0 ? reason.trim() : "analytic path";
    return `analytic fallback, potential flow preview (${cause}), not validated`;
}

/** Frame honesty label for one of the four mutually exclusive states. */
export function frameHonestyLabel(state: SolverHonestyState, reason?: string): string {
    if (state === "solved") return lbmSolvedLabel(reason);
    if (state === "phase-averaged-modeled") return neuralPhaseAveragedLabel();
    if (state === "steady-predicted") return neuralSteadyLabel(reason ?? "");
    return analyticFallbackLabel(reason ?? "");
}

/** Router input for the four state honesty decision. */
export interface HonestyStateInput {
    source: "lbm" | "neural" | "analytic";
    harmonicValid?: boolean;
}

/**
 * Pick the honesty state for one frame. LBM is solved and instantaneous;
 * neural with harmonics valid after all gates is phase averaged and modeled;
 * neural without valid shedding is steady predicted; analytic is the
 * potential preview fallback.
 */
export function honestyStateForFrame(input: HonestyStateInput): SolverHonestyState {
    if (input.source === "lbm") return "solved";
    if (input.source === "neural") {
        return input.harmonicValid === true ? "phase-averaged-modeled" : "steady-predicted";
    }
    return "analytic-fallback";
}
