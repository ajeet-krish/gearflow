// Provisional neural surrogate domain. Pure and testable, no network
// access. The envelope below is provisional: no weights have landed, so
// every verdict carries provisional true and callers must label neural
// output as predicted, not validated physics.

import type { BodyToken } from "@/contracts/types";

/** Body kinds the provisional envelope can list. Custom shapes are excludable via customAllowed. */
export type NeuralKind = BodyToken | "custom";

/** Provisional domain the neural surrogate is intended to cover. */
export interface NeuralEnvelope {
    kinds: ReadonlyArray<NeuralKind>;
    alphaMin: number;
    alphaMax: number;
    reMin: number;
    reMax: number;
    customAllowed: boolean;
    runId: string | null;
    /** Always true until a training run lands and the envelope is confirmed. */
    provisional: true;
    /** Human readable honesty note for panels and provenance. */
    note: string;
}

/**
 * Provisional neural envelope. NACA 0012, 2412, and 4412 plus cylinder,
 * block, and orifice; alpha in [-4, 12] deg; Re in [1000, 200000]. Custom
 * shapes are not covered and runId is null until weights land. Provisional:
 * treat any neural prediction inside this envelope as unvalidated.
 */
export const PROVISIONAL_NEURAL_ENVELOPE: NeuralEnvelope = {
    kinds: ["naca0012", "naca2412", "naca4412", "cylinder", "block", "orifice"],
    alphaMin: -4,
    alphaMax: 12,
    reMin: 1000,
    reMax: 200000,
    customAllowed: false,
    runId: null,
    provisional: true,
    note: "Provisional envelope, no weights landed yet. Predictions inside it are still unvalidated.",
};

/** Domain verdict for one case against the envelope. */
export interface DomainVerdict {
    inDomain: boolean;
    /** Null inside the envelope, otherwise the honest reason or reasons. */
    reason: string | null;
    /** Mirrors the envelope: always true while provisional. */
    provisional: boolean;
}

/**
 * Classify one case against the envelope. Pure: every failure is collected
 * into the reason string so panels can quote it verbatim. Unknown kinds are
 * out of domain via the kinds allowlist. Custom is rejected in two ways:
 * when it is absent from kinds, and (enforced) when kinds lists it while
 * customAllowed is false, so kinds alone is never the sole authority for
 * custom shapes.
 */
export function classifyNeuralDomain(
    kind: string,
    alphaDeg: number,
    reynolds: number,
    envelope: NeuralEnvelope = PROVISIONAL_NEURAL_ENVELOPE,
): DomainVerdict {
    const problems: string[] = [];
    if (!envelope.kinds.includes(kind as NeuralKind)) {
        problems.push(`body ${kind} is outside the provisional neural envelope [${envelope.kinds.join(", ")}]`);
    } else if (kind === "custom" && !envelope.customAllowed) {
        problems.push("custom body is listed in kinds but customAllowed is false, so it stays out of domain");
    }
    if (typeof alphaDeg !== "number" || !Number.isFinite(alphaDeg)) {
        problems.push("alpha is not finite, no domain claim is possible");
    } else if (alphaDeg < envelope.alphaMin || alphaDeg > envelope.alphaMax) {
        problems.push(`alpha ${alphaDeg} deg is outside the provisional envelope [${envelope.alphaMin}, ${envelope.alphaMax}] deg`);
    }
    if (typeof reynolds !== "number" || !Number.isFinite(reynolds)) {
        problems.push("reynolds is not finite, no domain claim is possible");
    } else if (reynolds < envelope.reMin || reynolds > envelope.reMax) {
        problems.push(`Re ${reynolds} is outside the provisional envelope [${envelope.reMin}, ${envelope.reMax}]`);
    }
    if (problems.length === 0) {
        return { inDomain: true, reason: null, provisional: envelope.provisional };
    }
    return { inDomain: false, reason: problems.join("; "), provisional: envelope.provisional };
}
