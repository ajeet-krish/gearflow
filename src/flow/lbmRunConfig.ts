// Configurable LBM run state. Pure defaults, clamps, and notice wording
// so vitest covers the run rules without a Worker or a rendered App.
// App.tsx owns the React state; this module owns the shared constants.

import { MAX_TARGET_STEPS } from "./lbmProtocol";
import type { Domain, GeometrySpec } from "@/contracts/types";
import { buildPolygons } from "@/geometry/parametric";

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
export const LBM_ENTER_NOTICE = "LBM needs low Re, Re set to 200 for the run default.";

/** Notice surfaced after a parametric or agent Re is capped to the LBM ceiling. */
export const LBM_PARAM_CAP_NOTICE = "Parametric Re capped at 2000 while LBM is active.";

/** Measured stability guidance appended to tau or floor failovers. */
export const LBM_TAU_GUIDANCE =
    "stable below about Re 480 at u 0.05 on the default grid, scales with body cells";

/** Hard tau floor for the Run pre-flight. Mirrors TAU_FLOOR in rust/gearflow-wasm/src/lattice.rs:14. */
export const LBM_TAU_FLOOR = 0.505;

/** Pre-flight tau warn band. Tighter than the Rust TAU_WARN watch band in rust/gearflow-wasm/src/lattice.rs:16. */
export const LBM_PREFLIGHT_TAU_WARN = 0.53;

/** Pre-flight blockage warn ratio, 13 percent of tunnel height. */
export const LBM_PREFLIGHT_BLOCKAGE_WARN = 0.13;

/**
 * Phase A native verification verdict (release, 40000 steps, 320x256 grid
 * over the default domain, cylinder radius 0.15, u 0.05, statsStart 8000):
 * Re 200 diverges at step 576, Re 100 diverges at step 10304. Neither
 * completes, so the LBM entry default keeps the Re reset only
 * (LBM_ENTER_RE) and offers no body suggestion. Null means no suggestion.
 */
export const LBM_ENTER_BODY_RADIUS: number | null = null;

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

/** Projected body height normal to the freestream. Mirrors body_height_phys in rust/gearflow-wasm/src/lbm.rs:775. */
export function preflightBodyHeight(geom: GeometrySpec): number {
    if (geom.kind === "cylinder") {
        const r = geom.radius ?? 0.25;
        return 2 * r;
    }
    if (geom.kind === "block") {
        const w = geom.width ?? 0.5;
        const h = geom.height ?? 0.5;
        const a = ((geom.alphaDeg ?? 0) * Math.PI) / 180;
        return h * Math.abs(Math.cos(a)) + w * Math.abs(Math.sin(a));
    }
    if (geom.kind === "duct") {
        return geom.height ?? 0.4;
    }
    const polys = buildPolygons(geom);
    let lo = Infinity;
    let hi = -Infinity;
    for (const poly of polys) {
        for (const p of poly) {
            if (Number.isFinite(p.y)) {
                if (p.y < lo) lo = p.y;
                if (p.y > hi) hi = p.y;
            }
        }
    }
    return hi - lo;
}

export interface LbmPreflight {
    ok: boolean;
    tau: number;
    dLat: number;
    blockage: number;
    warnings: string[];
    blockReasons: string[];
}

/**
 * Run pre-flight honesty gate. Predicts tau exactly the way the Rust core
 * does (D_lat from projected body height over dx, nu_lat, tau, per
 * lattice_params in rust/gearflow-wasm/src/lattice.rs:146 and the tau
 * floor in check_tau at lattice.rs:196). Hard blocks Run when predicted
 * tau is at or below the floor. Warns on high blockage, low tau, and
 * duct bodies. Pure, no Worker needed.
 */
export function preflightLbm(
    geom: GeometrySpec,
    grid: { nx: number; ny: number; domain: Domain },
    uLattice: number,
    re: number
): LbmPreflight {
    const warnings: string[] = [];
    const blockReasons: string[] = [];
    const finish = (ok: boolean, tau: number, dLat: number, blockage: number): LbmPreflight =>
        ({ ok, tau, dLat, blockage, warnings, blockReasons });
    const w = grid.domain.xMax - grid.domain.xMin;
    const dx = grid.nx > 1 ? w / (grid.nx - 1) : NaN;
    let bodyHeight = NaN;
    try {
        bodyHeight = preflightBodyHeight(geom);
    } catch {
        bodyHeight = NaN;
    }
    const dLat = bodyHeight / dx;
    const nuLat = (uLattice * dLat) / re;
    const tau = 3 * nuLat + 0.5;
    const hLat = grid.ny - 1;
    const blockage = hLat > 0 ? dLat / hLat : NaN;
    if (!Number.isFinite(tau) || !Number.isFinite(dLat) || !Number.isFinite(blockage)) {
        blockReasons.push("LBM pre-flight cannot predict tau for this grid and body, Run blocked.");
        return finish(false, tau, dLat, blockage);
    }
    if (tau <= LBM_TAU_FLOOR) {
        blockReasons.push(
            `LBM pre-flight blocks Run: predicted tau ${tau.toFixed(3)} at or below the ${LBM_TAU_FLOOR} floor, lower Re or refine the grid.`
        );
    }
    if (blockage > LBM_PREFLIGHT_BLOCKAGE_WARN) {
        warnings.push(
            `LBM pre-flight: blockage ${(blockage * 100).toFixed(1)} percent above ${(LBM_PREFLIGHT_BLOCKAGE_WARN * 100).toFixed(0)} percent, Cd will read high.`
        );
    }
    if (tau < LBM_PREFLIGHT_TAU_WARN) {
        warnings.push(
            `LBM pre-flight: predicted tau ${tau.toFixed(3)} below ${LBM_PREFLIGHT_TAU_WARN.toFixed(2)}, low viscosity run, watch for instability.`
        );
    }
    if (geom.kind === "duct") {
        warnings.push("LBM pre-flight: duct body uses a zero gradient outlet, mass drift risk, watch density.");
    }
    return finish(blockReasons.length === 0, tau, dLat, blockage);
}
