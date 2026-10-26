// Phase 3 validation tier thresholds and evaluation. Threshold values come
// from docs/ARCHITECTURE.md (validation design, final). PASS means within
// tolerance and demo ready. WARN means outside PASS but inside the review
// band, still demoable with a note. INFO means display only, never fails.
// Only a fail status on a PASS tier row blocks the demo.

import type { ValidationStatus, ValidationTier } from "@/contracts/types";

export interface TierThreshold {
    /** Absolute error within which a PASS tier row reports pass. */
    passTol: number;
    /** Absolute error within which a row still reports warn instead of fail. */
    warnTol: number;
    unit: string;
    description: string;
}

/** Canonical threshold table, keyed by metric id used in datasets and panel. */
export const TIER_TABLE: Record<string, TierThreshold> = {
    clAbsolute: {
        passTol: 0.05,
        warnTol: 0.1,
        unit: "cl",
        description: "Absolute Cl within 0.05 vs XFOIL Re 500k at 4, 6, 8 deg (0012 and 2412)",
    },
    clSlopeRelative: {
        passTol: 0.05,
        warnTol: 0.1,
        unit: "fraction",
        description: "Cl slope within 5 percent of 2 pi (0.1097 per deg) below 8 deg, 0012 high Re bridge only",
    },
    mccroskeySlopeRelative: {
        passTol: 0.05,
        warnTol: 0.1,
        unit: "fraction",
        description: "Slope within 5 percent of McCroskey best fit 0.1075 per deg at Re 6M M 0.15",
    },
    cpStagnation: {
        passTol: 0.05,
        warnTol: 0.1,
        unit: "cp",
        description: "Cylinder stagnation Cp 1.0 within 0.05 (analytic oracle)",
    },
    cpShoulder: {
        passTol: 0.05,
        warnTol: 0.1,
        unit: "cp",
        description: "Cylinder shoulder Cp minus 3.0 within 0.05 (analytic oracle)",
    },
    alphaZero: {
        passTol: 0.25,
        warnTol: 0.5,
        unit: "deg",
        description: "Alpha0 within 0.25 deg (0012 at 0, 2412 theory at minus 2.07)",
    },
    re100kDisplay: {
        passTol: 0.05,
        warnTol: 0.2,
        unit: "cl",
        description: "Re 100k rows are WARN only (bubble kink near 1 to 2 deg), wider review band",
    },
    infoOnly: {
        passTol: Number.POSITIVE_INFINITY,
        warnTol: Number.POSITIVE_INFINITY,
        unit: "n/a",
        description: "INFO rows never fail: Cd, transition, cylinder St band, Cl amplitude, experimental alpha0",
    },
};

/**
 * Evaluate one metric error against its tier. INFO always returns info.
 * WARN tier rows never return pass: inside the review band they report warn
 * (WARN only display), outside they report fail (still non-blocking, only
 * PASS tier failures block). PASS tier rows report pass, warn, or fail.
 */
export function evaluateTier(
    tier: ValidationTier,
    absErr: number,
    passTol: number,
    warnTol?: number,
): ValidationStatus {
    if (tier !== "PASS" && tier !== "WARN" && tier !== "INFO") {
        throw new Error(`evaluateTier: tier must be PASS, WARN, or INFO, got ${String(tier)}`);
    }
    if (!Number.isFinite(absErr) || absErr < 0) {
        throw new Error(`evaluateTier: absErr must be a non-negative finite number, got ${String(absErr)}`);
    }
    if (tier === "INFO") return "info";
    if (!Number.isFinite(passTol) || passTol < 0) {
        throw new Error(`evaluateTier: passTol must be a non-negative finite number, got ${String(passTol)}`);
    }
    const warn = warnTol ?? 2 * passTol;
    if (!Number.isFinite(warn) || warn < 0) {
        throw new Error(`evaluateTier: warnTol must be a non-negative finite number, got ${String(warn)}`);
    }
    if (absErr <= passTol) return tier === "PASS" ? "pass" : "warn";
    if (absErr <= warn) return "warn";
    return "fail";
}

/** True only for failures that block the demo: fail status on a PASS tier row. */
export function isBlocking(tier: ValidationTier, status: ValidationStatus): boolean {
    return tier === "PASS" && status === "fail";
}
