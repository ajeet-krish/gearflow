// Viscous wake overlay for the analytic flow model. This is the only place
// where Reynolds number enters: potential panels are inviscid, and the wake
// adds a downstream velocity deficit plus downwash. Mutates u and v in place.
// The Phase 1 fakeFlow module keeps its own copy of this concept; that file
// is untouched.

import type { Domain } from "@/contracts/types";

export interface WakeParams {
    U: number;
    Re: number;
    /** Cross-stream position of the wake centreline at the body. */
    baseY: number;
    /** Downstream slope of the wake centreline (dy/dx). */
    slope: number;
    /** Wake starts downstream of this x. Defaults to 0.8. */
    xWake?: number;
}

/**
 * Apply the wake deficit downstream of xWake. Cells upstream of xWake and
 * obstacle cells are never touched, so Re changes are wake only.
 */
export function applyWake(
    u: Float32Array,
    v: Float32Array,
    nx: number,
    ny: number,
    domain: Domain,
    obstacle: Float32Array,
    params: WakeParams
): void {
    if (!(u instanceof Float32Array) || !(v instanceof Float32Array) || !(obstacle instanceof Float32Array)) {
        throw new Error("applyWake: u, v, and obstacle must be Float32Array");
    }
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 4 || ny < 4) {
        throw new Error(`applyWake: nx and ny must be integers >= 4, got ${String(nx)}x${String(ny)}`);
    }
    if (u.length !== nx * ny || v.length !== nx * ny || obstacle.length !== nx * ny) {
        throw new Error("applyWake: channel length does not match nx * ny");
    }
    if (!domain || !Number.isFinite(domain.xMin) || !Number.isFinite(domain.xMax) || !Number.isFinite(domain.yMin) || !Number.isFinite(domain.yMax)) {
        throw new Error("applyWake: domain must have finite bounds");
    }
    const { U, Re, baseY, slope } = params;
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`applyWake: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(Re) || Re <= 0) {
        throw new Error(`applyWake: Re must be a positive finite number, got ${String(Re)}`);
    }
    if (!Number.isFinite(baseY) || !Number.isFinite(slope)) {
        throw new Error(`applyWake: baseY and slope must be finite, got (${String(baseY)}, ${String(slope)})`);
    }
    const xWake = params.xWake ?? 0.8;
    if (!Number.isFinite(xWake)) {
        throw new Error(`applyWake: xWake must be finite, got ${String(xWake)}`);
    }
    const amp = Math.min(0.6, 8 / Math.sqrt(Re));
    const widthScale = 1 + 60 / Re;
    for (let j = 0; j < ny; j++) {
        const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (ny - 1);
        for (let i = 0; i < nx; i++) {
            const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (nx - 1);
            if (x <= xWake) continue;
            const k = j * nx + i;
            if (obstacle[k] > 0.5) continue;
            const behind = x - xWake;
            const center = baseY + slope * behind;
            const yw = y - center;
            const w = (0.12 + behind * 0.18) * widthScale;
            const ramp = Math.min(1, behind * 1.4);
            const g = Math.exp(-(yw * yw) / (w * w)) * ramp;
            u[k] = Math.max(0.05 * U, u[k] - U * amp * g);
            v[k] = v[k] + U * slope * g * 0.5;
        }
    }
}
