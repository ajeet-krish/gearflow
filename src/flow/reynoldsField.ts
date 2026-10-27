// Non-blocking Reynolds number field parser. The canvas never writes a
// half-typed value into the solve: the field commits through
// commitReynoldsValue, which funnels every keystroke state into one clamped
// number plus an honest note. Pure, no DOM, testable outside React.

import { LBM_MAX_RE } from "./lbmRunConfig";

/** Field floor and ceiling. The Spark spec envelope starts at 1000, the canvas field accepts 100. */
export const RE_FIELD_MIN = 100;
export const RE_FIELD_MAX = 1000000;

/** LES auto engages above this Re while LBM is active, surfaced as a band warning. */
export const RE_LBM_BAND_WARN_ABOVE = 500;

export type ReynoldsParseKind = "empty" | "non-numeric" | "below-min" | "above-max" | "lbm-cap" | "ok";

export interface ReynoldsParse {
    kind: ReynoldsParseKind;
    /** Rounded committed value, null when nothing can commit (empty, non-numeric). */
    value: number | null;
    /** Human readable note, null when the value commits cleanly. */
    message: string | null;
    /** LBM band warning, null when LBM is inactive or Re stays at or below 500. */
    lbmBandWarning: string | null;
}

function lbmBandWarningFor(value: number | null, lbmActive: boolean): string | null {
    if (!lbmActive || value === null) return null;
    if (value > RE_LBM_BAND_WARN_ABOVE) {
        return `Re ${value.toLocaleString("en-US")} is above ${RE_LBM_BAND_WARN_ABOVE} while LBM is active, LES auto engages.`;
    }
    return null;
}

/**
 * Parse a Reynolds field value without writing to the canvas. Strings are
 * trimmed, numbers round to integers. Empty and non-numeric inputs commit
 * nothing (value null); below-min clamps to 100, above-max clamps to
 * 1000000, and LBM active caps at 2000. Never throws.
 */
export function parseReynoldsField(raw: unknown, lbmActive: boolean): ReynoldsParse {
    if (typeof raw === "string" && raw.trim().length === 0) {
        return { kind: "empty", value: null, message: "Enter a Reynolds number.", lbmBandWarning: null };
    }
    const n = typeof raw === "string" ? Number(raw.trim()) : typeof raw === "number" ? raw : Number.NaN;
    if (typeof n !== "number" || !Number.isFinite(n)) {
        return { kind: "non-numeric", value: null, message: "Reynolds number must be numeric.", lbmBandWarning: null };
    }
    const rounded = Math.round(n);
    if (rounded < RE_FIELD_MIN) {
        return {
            kind: "below-min",
            value: RE_FIELD_MIN,
            message: `Re ${rounded.toLocaleString("en-US")} is below the ${RE_FIELD_MIN} floor, clamped to ${RE_FIELD_MIN}.`,
            lbmBandWarning: lbmBandWarningFor(RE_FIELD_MIN, lbmActive),
        };
    }
    if (rounded > RE_FIELD_MAX) {
        return {
            kind: "above-max",
            value: RE_FIELD_MAX,
            message: `Re ${rounded.toLocaleString("en-US")} is above the ${RE_FIELD_MAX.toLocaleString("en-US")} ceiling, clamped to ${RE_FIELD_MAX.toLocaleString("en-US")}.`,
            lbmBandWarning: lbmBandWarningFor(RE_FIELD_MAX, lbmActive),
        };
    }
    if (lbmActive && rounded > LBM_MAX_RE) {
        return {
            kind: "lbm-cap",
            value: LBM_MAX_RE,
            message: `Parametric Re capped at ${LBM_MAX_RE} while LBM is active.`,
            lbmBandWarning: lbmBandWarningFor(LBM_MAX_RE, lbmActive),
        };
    }
    return { kind: "ok", value: rounded, message: null, lbmBandWarning: lbmBandWarningFor(rounded, lbmActive) };
}

export interface ReynoldsCommit {
    /** Committed Reynolds number: parsed value, clamp, or the untouched fallback. */
    reynolds: number;
    /** True when the value hit the LBM ceiling. */
    capped: boolean;
    /** Note to surface in the notice stack, null when the commit is clean. */
    notice: string | null;
}

/**
 * Commit funnel for the canvas. Empty and non-numeric input keeps the
 * current Re untouched; every other kind commits its clamped value. The
 * LBM band warning rides along in the notice when present.
 */
export function commitReynoldsValue(raw: unknown, lbmActive: boolean, fallback: number): ReynoldsCommit {
    const parsed = parseReynoldsField(raw, lbmActive);
    if (parsed.value === null) {
        return { reynolds: fallback, capped: false, notice: parsed.message };
    }
    const notice = parsed.lbmBandWarning !== null && parsed.message !== null
        ? `${parsed.message} ${parsed.lbmBandWarning}`
        : parsed.message ?? parsed.lbmBandWarning;
    return { reynolds: parsed.value, capped: parsed.kind === "lbm-cap", notice };
}
