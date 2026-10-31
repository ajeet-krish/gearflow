// Visual advection scaling for the particle layer. The analytic core stays
// inviscid; Reynolds number only shades the wake deficit, so this scale is
// display coupling only and never feeds forces or provenance. Pure math,
// never throws, so the RAF loop can call it without guards.

export const ADVECTION_SCALE_MIN = 0.6;
export const ADVECTION_SCALE_MAX = 2.4;
export const VELOCITY_MULT_MIN = 0.5;
export const VELOCITY_MULT_MAX = 2.0;
export const VELOCITY_MULT_DEFAULT = 1.0;

const RE_LOG_MIN = 2;
const RE_LOG_MAX = 6;

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, n));
}

/**
 * Log-interpolated advection scale for a Reynolds number. Monotonic in Re,
 * clamped to [0.6, 2.4]. Non-finite or non-positive input reads as 1.0
 * (neutral). Never throws.
 */
export function advectionScaleForRe(re: unknown): number {
    try {
        if (typeof re !== "number" || !Number.isFinite(re) || re <= 0) return 1.0;
        const t = (Math.log10(re) - RE_LOG_MIN) / (RE_LOG_MAX - RE_LOG_MIN);
        const clamped = clamp(t, 0, 1);
        return ADVECTION_SCALE_MIN + clamped * (ADVECTION_SCALE_MAX - ADVECTION_SCALE_MIN);
    } catch {
        return 1.0;
    }
}

/** Clamp a velocity multiplier into [0.5, 2.0]. Non-finite reads as 1.0. Never throws. */
export function clampVelocityMult(mult: unknown): number {
    try {
        if (typeof mult !== "number" || !Number.isFinite(mult)) return VELOCITY_MULT_DEFAULT;
        return clamp(mult, VELOCITY_MULT_MIN, VELOCITY_MULT_MAX);
    } catch {
        return VELOCITY_MULT_DEFAULT;
    }
}

/**
 * Combine the Re scale with the explicit velocity multiplier. Both inputs
 * are clamped to their bands first, then multiplied. Never throws.
 */
export function combineVelocity(scale: unknown, velocityMult: unknown): number {
    try {
        const s = typeof scale === "number" && Number.isFinite(scale)
            ? clamp(scale, ADVECTION_SCALE_MIN, ADVECTION_SCALE_MAX)
            : 1.0;
        const m = clampVelocityMult(velocityMult);
        const out = s * m;
        return Number.isFinite(out) ? out : 1.0;
    } catch {
        return 1.0;
    }
}
