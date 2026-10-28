// Fast path solver router. Pure and testable, no network or DOM access.
// Decides between the neural-v2 surrogate and the analytic potential
// fallback, and builds the honest provenance labels for each path. Neural
// output is always labeled predicted, not validated, even inside the
// provisional envelope.

import { classifyNeuralDomain, PROVISIONAL_NEURAL_ENVELOPE, type NeuralEnvelope } from "@/flow/neuralDomain";

/** Where the next frame comes from. */
export type SolverPath = "neural-v2" | "analytic";

/** Neural weights readiness from the App wiring. */
export type NeuralStatus = "ready" | "loading" | "failed" | "unavailable";

/** Router input: one case plus the neural weights status. */
export interface FastPathInput {
    body: string;
    alphaDeg: number;
    reynolds: number;
    neuralStatus: NeuralStatus;
    envelope?: NeuralEnvelope;
}

/** Router outcome: the path plus the human readable reason. */
export interface SolveDecision {
    path: SolverPath;
    reason: string;
    inDomain: boolean;
}

/**
 * Pick the fast path for one case. Neural-v2 wins only when the weights
 * are ready and the case classifies inside the provisional envelope;
 * every other status or an out of domain case falls back to analytic with
 * the reason naming the cause.
 */
export function decideFastPath(input: FastPathInput): SolveDecision {
    const envelope = input.envelope ?? PROVISIONAL_NEURAL_ENVELOPE;
    const verdict = classifyNeuralDomain(input.body, input.alphaDeg, input.reynolds, envelope);
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
