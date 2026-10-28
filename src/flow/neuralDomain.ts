// Provisional neural surrogate domain. Pure and testable, no network
// access. The envelope below is provisional: no weights have landed, so
// every verdict carries provisional true and callers must label neural
// output as predicted, not validated physics.

import type { BodyToken } from "@/contracts/types";

/** Body kinds the provisional envelope can list. Custom shapes are excludable via customAllowed. */
export type NeuralKind = BodyToken | "custom";

/** Per body Reynolds range from measured LBM probe runs. */
export interface NeuralReRange {
    min: number;
    max: number;
}

/** Provisional domain the neural surrogate is intended to cover. */
export interface NeuralEnvelope {
    kinds: ReadonlyArray<NeuralKind>;
    alphaMin: number;
    alphaMax: number;
    reMin: number;
    reMax: number;
    /** Per body Reynolds limits from measured solver reality. The flat reMin and reMax above stay as the union for backward compatibility. */
    reByKind: Partial<Record<NeuralKind, NeuralReRange>>;
    customAllowed: boolean;
    runId: string | null;
    /** Always true until a training run lands and the envelope is confirmed. */
    provisional: true;
    /** Human readable honesty note for panels and provenance. */
    note: string;
}

/**
 * Provisional neural envelope. NACA 0012, 2412, and 4412 plus cylinder and
 * block; alpha in [-4, 8] deg. Per body Re from measured probe runs:
 * cylinder 20 to 700 (BGK below 200, LES at 200 and above), block 20 to
 * 400, airfoils 100 to 1200 at alpha -4, 0, 4, 8. Orifice has no LBM path
 * and stays out, custom shapes are not covered, duct is retired, and runId
 * is null until weights land. Provisional planned coverage: above Re 500
 * output is modeled coarse LES, not solved. Treat any neural prediction
 * inside this envelope as unvalidated, not validated physics.
 */
export const PROVISIONAL_NEURAL_ENVELOPE: NeuralEnvelope = {
    kinds: ["naca0012", "naca2412", "naca4412", "cylinder", "block"],
    alphaMin: -4,
    alphaMax: 8,
    reMin: 20,
    reMax: 1200,
    reByKind: {
        cylinder: { min: 20, max: 700 },
        block: { min: 20, max: 400 },
        naca0012: { min: 100, max: 1200 },
        naca2412: { min: 100, max: 1200 },
        naca4412: { min: 100, max: 1200 },
    },
    customAllowed: false,
    runId: null,
    provisional: true,
    note: "Provisional planned coverage, no weights landed yet. Above Re 500 output is modeled coarse LES, not solved. Predictions inside are unvalidated, not validated physics.",
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
 * custom shapes. Reynolds uses the per body range when the kind lists one,
 * otherwise the flat union, and the Re reason names the violated bound plus
 * the nearest valid Re for that kind.
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
    const range = (envelope.reByKind as Record<string, NeuralReRange | undefined>)[kind] ?? {
        min: envelope.reMin,
        max: envelope.reMax,
    };
    if (typeof reynolds !== "number" || !Number.isFinite(reynolds)) {
        problems.push("reynolds is not finite, no domain claim is possible");
    } else if (reynolds < range.min || reynolds > range.max) {
        const nearest = Math.round(Math.min(Math.max(reynolds, range.min), range.max));
        problems.push(
            `Re ${reynolds} is outside the provisional envelope [${range.min}, ${range.max}] for ${kind}, nearest ${kind} Re ${nearest}`,
        );
    }
    if (problems.length === 0) {
        return { inDomain: true, reason: null, provisional: envelope.provisional };
    }
    return { inDomain: false, reason: problems.join("; "), provisional: envelope.provisional };
}
