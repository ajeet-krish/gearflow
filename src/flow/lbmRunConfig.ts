// Configurable LBM run state. Pure defaults, clamps, and notice wording
// so vitest covers the run rules without a Worker or a rendered App.
// App.tsx owns the React state; this module owns the shared constants.

import { MAX_TARGET_STEPS } from "./lbmProtocol";

export const LBM_DEFAULT_U_LATTICE = 0.05;
export const LBM_MIN_U_LATTICE = 0.02;
export const LBM_MAX_U_LATTICE = 0.12;

export const LBM_DEFAULT_TARGET_STEPS = 40000;
export const LBM_MIN_TARGET_STEPS = 1000;

/** Re ceiling while LBM is active. Entering LBM above this resets to LBM_ENTER_RE. */
export const LBM_MAX_RE = 2000;
/** Re used when entering LBM with a high Re, and by the tau recovery action. */
export const LBM_ENTER_RE = 200;

/** Recovery Re exposed for the failover action. Sets Reynolds to 200. */
export const lbmRecoveryRe = 200;

/** Notice surfaced in the LBM notice stack after an entry reset. */
export const LBM_ENTER_NOTICE = "LBM needs low Re, Re set to 200 for a stable solve.";

/** Notice surfaced after a parametric or agent Re is capped to the LBM ceiling. */
export const LBM_PARAM_CAP_NOTICE = "Parametric Re capped at 2000 while LBM is active.";

/** Measured stability guidance appended to tau or floor failovers. */
export const LBM_TAU_GUIDANCE =
    "stable below about Re 480 at u 0.05 on the default grid, scales with body cells";

export function clampLbmULattice(next: number): number {
    if (!Number.isFinite(next)) return LBM_DEFAULT_U_LATTICE;
    return Math.min(LBM_MAX_U_LATTICE, Math.max(LBM_MIN_U_LATTICE, next));
}

export function clampLbmTargetSteps(next: number): number {
    if (!Number.isFinite(next)) return LBM_DEFAULT_TARGET_STEPS;
    return Math.min(MAX_TARGET_STEPS, Math.max(LBM_MIN_TARGET_STEPS, Math.round(next)));
}

/** Effective LES flag. Auto derives from the debounced Re, manual applies when Auto is off. */
export function lbmLesEnabled(auto: boolean, manual: boolean, debouncedRe: number): boolean {
    return auto ? debouncedRe > 500 : manual;
}

/** True when entering LBM should reset the current Re once. Deliberate low Re survives. */
export function shouldResetReOnLbmEnter(reynolds: number): boolean {
    return reynolds > LBM_MAX_RE;
}

/** Cap an incoming Re to the LBM ceiling while LBM is active. Analytic keeps
 *  the full range untouched, and non-finite input passes through unchanged. */
export function clampReForEngine(reynolds: number, lbmActive: boolean): { reynolds: number; capped: boolean } {
    if (!Number.isFinite(reynolds)) return { reynolds, capped: false };
    if (lbmActive && reynolds > LBM_MAX_RE) return { reynolds: LBM_MAX_RE, capped: true };
    return { reynolds, capped: false };
}

/** LBM entry transition. Returns the reset Re plus notice when entering LBM
 *  with a high Re, or null when nothing changes. The caller marks entry seen
 *  so the reset fires once and a dismissed notice stays dismissed. */
export function lbmEntryTransition(
    engineMode: string,
    reynolds: number,
    seen: string | null
): { reynolds: number; notice: string } | null {
    if (engineMode !== "lbm") return null;
    if (seen === "lbm") return null;
    if (!shouldResetReOnLbmEnter(reynolds)) return null;
    return { reynolds: LBM_ENTER_RE, notice: LBM_ENTER_NOTICE };
}

/** True when a failover message is a tau or floor stability fault. */
export function isLbmTauFailover(message: string | null): boolean {
    if (message === null) return false;
    return /tau|floor/i.test(message);
}

/** Append the measured stability guidance to tau or floor failovers, once. */
export function withLbmTauGuidance(message: string): string {
    if (!isLbmTauFailover(message)) return message;
    if (message.includes(LBM_TAU_GUIDANCE)) return message;
    return `${message} (${LBM_TAU_GUIDANCE}).`;
}
