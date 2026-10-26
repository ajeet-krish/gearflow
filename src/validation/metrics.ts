// Pure validation metrics for Phase 3. No fs, no fetch, no solver imports.
// All functions are deterministic and throw on empty or non-finite input.

import type { FlowField } from "@/contracts/types";
import type { PolarRecord } from "@/contracts/types";

export interface LinearFit {
    /** dCl/dAlpha in per degree units. */
    slope: number;
    /** Cl at alpha 0 from the least squares line. */
    intercept: number;
    /** Number of polar points used in the fit. */
    n: number;
}

function requireFinite(value: number, context: string): void {
    if (!Number.isFinite(value)) {
        throw new Error(`metrics: ${context} must be finite, got ${String(value)}`);
    }
}

/**
 * Least squares fit of Cl vs alpha over the closed interval [lo, hi]
 * degrees. Used for lift slope and alpha0 intercept checks.
 */
export function fitSlope(records: PolarRecord[], lo: number, hi: number): LinearFit {
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error("fitSlope: records must be a non-empty array");
    }
    requireFinite(lo, "lo");
    requireFinite(hi, "hi");
    if (hi <= lo) throw new Error(`fitSlope: hi must exceed lo, got [${lo}, ${hi}]`);
    const pts = records.filter((r) => r.alpha >= lo && r.alpha <= hi);
    if (pts.length < 2) {
        throw new Error(`fitSlope: fewer than 2 points in [${lo}, ${hi}], got ${pts.length}`);
    }
    let sumX = 0;
    let sumY = 0;
    for (const p of pts) {
        requireFinite(p.alpha, "alpha");
        requireFinite(p.cl, "cl");
        sumX += p.alpha;
        sumY += p.cl;
    }
    const meanX = sumX / pts.length;
    const meanY = sumY / pts.length;
    let num = 0;
    let den = 0;
    for (const p of pts) {
        num += (p.alpha - meanX) * (p.cl - meanY);
        den += (p.alpha - meanX) * (p.alpha - meanX);
    }
    if (den === 0) throw new Error("fitSlope: degenerate alpha range (zero variance)");
    const slope = num / den;
    const intercept = meanY - slope * meanX;
    requireFinite(slope, "slope");
    requireFinite(intercept, "intercept");
    return { slope, intercept, n: pts.length };
}

/** Zero lift angle in degrees from a linear fit: alpha0 = -intercept/slope. */
export function alphaZero(fit: LinearFit): number {
    requireFinite(fit.slope, "fit.slope");
    requireFinite(fit.intercept, "fit.intercept");
    if (Math.abs(fit.slope) < 1e-12) {
        throw new Error("alphaZero: slope is too close to zero for an intercept");
    }
    return -fit.intercept / fit.slope;
}

/** Stagnation Cp: maximum panel Cp, expected 1.0 for the analytic oracle. */
export function cpStagnation(panelCp: ArrayLike<number>): number {
    if (panelCp.length === 0) throw new Error("cpStagnation: empty cp array");
    let max = -Infinity;
    for (let k = 0; k < panelCp.length; k++) {
        requireFinite(panelCp[k], `cp[${k}]`);
        if (panelCp[k] > max) max = panelCp[k];
    }
    return max;
}

/** Shoulder suction peak: minimum panel Cp, expected -3.0 for a cylinder. */
export function cpShoulder(panelCp: ArrayLike<number>): number {
    if (panelCp.length === 0) throw new Error("cpShoulder: empty cp array");
    let min = Infinity;
    for (let k = 0; k < panelCp.length; k++) {
        requireFinite(panelCp[k], `cp[${k}]`);
        if (panelCp[k] < min) min = panelCp[k];
    }
    return min;
}

/**
 * Lift coefficient from a contour integral of velocity around the outer grid
 * boundary (counterclockwise, midpoint rule). Gamma is positive CCW, and
 * Kutta-Joukowski gives Cl = -2 Gamma / (U chord) for freestream along +x.
 * Uniform flow integrates to zero. Obstacle cells on the boundary are
 * skipped (the body must sit inside the domain).
 */
export function circulationCl(field: FlowField, U: number, chord: number): number {
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`circulationCl: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(chord) || chord <= 0) {
        throw new Error(`circulationCl: chord must be a positive finite number, got ${String(chord)}`);
    }
    const { nx, ny, domain, u, v, obstacle } = field;
    if (!Number.isInteger(nx) || nx < 2 || !Number.isInteger(ny) || ny < 2) {
        throw new Error(`circulationCl: nx and ny must be integers >= 2, got ${String(nx)}x${String(ny)}`);
    }
    for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) {
        if (!Number.isFinite(domain[k])) {
            throw new Error(`circulationCl: domain.${k} must be finite`);
        }
    }
    if (domain.xMax <= domain.xMin || domain.yMax <= domain.yMin) {
        throw new Error("circulationCl: domain must have xMax > xMin and yMax > yMin");
    }
    const n = nx * ny;
    if (u.length !== n || v.length !== n || obstacle.length !== n) {
        throw new Error("circulationCl: channel length does not match nx * ny");
    }
    const dx = (domain.xMax - domain.xMin) / (nx - 1);
    const dy = (domain.yMax - domain.yMin) / (ny - 1);
    let gamma = 0;
    const bottom = 0;
    const top = ny - 1;
    for (let i = 0; i < nx - 1; i++) {
        const kb = bottom * nx + i;
        const kt = top * nx + i;
        if (obstacle[kb] <= 0.5) gamma += 0.5 * (u[kb] + u[kb + 1]) * dx;
        if (obstacle[kt] <= 0.5) gamma -= 0.5 * (u[kt] + u[kt + 1]) * dx;
    }
    for (let j = 0; j < ny - 1; j++) {
        const kr = j * nx + (nx - 1);
        const kl = j * nx;
        if (obstacle[kr] <= 0.5) gamma += 0.5 * (v[kr] + v[kr + nx]) * dy;
        if (obstacle[kl] <= 0.5) gamma -= 0.5 * (v[kl] + v[kl + nx]) * dy;
    }
    requireFinite(gamma, "gamma");
    return (-2 * gamma) / (U * chord);
}

/**
 * Minimum pressure coefficient over near-wall fluid cells, where
 * 0 < sdf <= band. Compares against viscous suction peaks (Gregory) as a
 * lower bound check: the inviscid model overshoots, so only the floor
 * matters. Cp is recovered as p / (0.5 U^2).
 */
export function bandCpMin(field: FlowField, sdf: Float32Array, U: number, band: number): number {
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`bandCpMin: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(band) || band <= 0) {
        throw new Error(`bandCpMin: band must be a positive finite number, got ${String(band)}`);
    }
    const n = field.nx * field.ny;
    if (sdf.length !== n || field.p.length !== n || field.obstacle.length !== n) {
        throw new Error("bandCpMin: channel length does not match nx * ny");
    }
    const q = 0.5 * U * U;
    let min = Infinity;
    let count = 0;
    for (let k = 0; k < n; k++) {
        if (field.obstacle[k] > 0.5) continue;
        const d = sdf[k];
        if (!Number.isFinite(d)) {
            throw new Error(`bandCpMin: sdf[${k}] must be finite`);
        }
        if (!(d > 0 && d <= band)) continue;
        requireFinite(field.p[k], `p[${k}]`);
        const cp = field.p[k] / q;
        if (cp < min) min = cp;
        count++;
    }
    if (count === 0) {
        throw new Error(`bandCpMin: no fluid cells found in (0, ${band}]`);
    }
    return min;
}
