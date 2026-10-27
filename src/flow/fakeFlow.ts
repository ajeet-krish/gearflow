// Deterministic fake flow generator for Phase 1 fixtures. Not physics, only plausible shapes.
// Freestream along +x with a wake deficit, upwash/downwash near body, pressure dip, signed vorticity.
//
// Canonical implementation: scripts/generate-fixtures.mjs mirrors this file
// and src/geometry/parametric.ts line for line (same hash, same masks, same
// wake model). Parity is guarded by src/flow/fixtures.parity.test.ts, which
// regenerates each committed fixture in-process and compares channels.

import type { FlowField, GeometrySpec, GridSpec } from "@/contracts/types";
import { pointInPolygon, naca4Airfoil, transformPoints } from "@/geometry/parametric";
import type { Point } from "@/geometry/parametric";
import { wakeSlopeForAlpha } from "./wake";
import { ORIFICE_GAP_DEFAULT, ORIFICE_THICKNESS_DEFAULT } from "@/contracts/types";

function hashSeed(str: string): number {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function obstaclePolygon(geom: GeometrySpec): Point[] | null {
    if (geom.kind === "naca4" && geom.naca) {
        const raw = naca4Airfoil(geom.naca.m, geom.naca.p, geom.naca.t, geom.nPoints);
        return transformPoints(raw, 0, 0, geom.chord, geom.alphaDeg);
    }
    return null;
}

function obstacleMask(px: number, py: number, geom: GeometrySpec, poly: Point[] | null): boolean {
    if (geom.kind === "naca4") {
        if (!poly) return false;
        return pointInPolygon(px, py, poly);
    }
    if (geom.kind === "cylinder") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        const r = geom.radius ?? 0.25;
        const dx = px - c.x;
        const dy = py - c.y;
        return dx * dx + dy * dy <= r * r;
    }
    if (geom.kind === "block") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        const w = (geom.width ?? 0.5) / 2;
        const h = (geom.height ?? 0.5) / 2;
        return Math.abs(px - c.x) <= w && Math.abs(py - c.y) <= h;
    }
    if (geom.kind === "orifice") {
        // Orifice plate: solid segments above and below a central gap of
        // full height `height` (the gap opening), plate thickness `width`
        // in x centred at c.x. The plate runs past the domain edge in y,
        // so any cell within the thickness band and outside the gap is solid.
        const c = geom.center ?? { x: 0.5, y: 0 };
        const t = (geom.width ?? ORIFICE_THICKNESS_DEFAULT) / 2;
        const g = (geom.height ?? ORIFICE_GAP_DEFAULT) / 2;
        if (Math.abs(px - c.x) > t) return false;
        return Math.abs(py - c.y) >= g;
    }
    return false;
}

export interface WakeProfile {
    /** Cross-stream position of the wake centreline at the body. */
    baseY: number;
    /** Downstream slope of the wake centreline (dy/dx). */
    slope: number;
}

/**
 * Wake centreline for the fake flow model. Centred on the body (polygon
 * centroid for airfoils, centre.y otherwise) with a downwash slope from
 * angle of attack: positive alpha (nose up) pushes the wake downward, so the
 * slope is negative in y-up coords. The slope is clamped to the
 * characterized band via wakeSlopeForAlpha so full rotation cannot blow up
 * the tan term. Phase 1 placeholder until Phase 2 replaces this module with
 * surrogate or LBM fields.
 */
export function wakeProfile(geom: GeometrySpec, poly: Point[] | null): WakeProfile {
    let baseY = geom.center?.y ?? 0;
    if (geom.kind === "naca4" && poly && poly.length > 0) {
        let sum = 0;
        for (const pt of poly) sum += pt.y;
        baseY = sum / poly.length;
    }
    const slope = wakeSlopeForAlpha(geom.alphaDeg);
    return { baseY, slope };
}

/** Deterministic fixture flow. Same inputs always give same outputs. */
export function generateFakeFlow(grid: GridSpec, geom: GeometrySpec, seedKey: string): FlowField {
    const { nx, ny, domain } = grid;
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 4 || ny < 4 || nx > 512 || ny > 512 || nx * ny > 262144) {
        throw new Error(`Grid must satisfy 4 <= nx,ny <= 512 and nx*ny <= 262144, got ${nx}x${ny}`);
    }
    const n = nx * ny;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const obstacle = new Float32Array(n);
    const seed = hashSeed(`${seedKey}|${nx}x${ny}|${geom.kind}|${geom.alphaDeg}`);
    const rand = mulberry32(seed);
    const jitter = new Float32Array(n);
    for (let k = 0; k < n; k++) jitter[k] = (rand() - 0.5) * 0.02;

    // Hoisted: one polygon build per field, not one per grid cell.
    const poly = obstaclePolygon(geom);
    const { baseY, slope } = wakeProfile(geom, poly);
    const phase = seed % 7;

    for (let j = 0; j < ny; j++) {
        const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (ny - 1);
        for (let i = 0; i < nx; i++) {
            const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (nx - 1);
            const k = j * nx + i;
            const inside = obstacleMask(x, y, geom, poly);
            obstacle[k] = inside ? 1 : 0;
            if (inside) {
                u[k] = 0; v[k] = 0; p[k] = 0.4; omega[k] = 0;
                continue;
            }
            // Wake behind x > 0.8, deficit centred on the body centreline and
            // deflected by alpha instead of hardcoded y = 0.
            const behind = Math.max(0, x - 0.8);
            const wakeCenter = baseY + slope * behind;
            const yw = y - wakeCenter;
            const wakeWidth = 0.12 + behind * 0.18;
            const wake = Math.exp(-(yw * yw) / (wakeWidth * wakeWidth)) * Math.min(1, behind * 1.4);
            // Mild speedup over the top, slowdown ahead of body
            const yb = y - baseY;
            const blockage = Math.exp(-((x - 0.4) * (x - 0.4) + yb * yb) * 3.0);
            const speed = 1 - 0.55 * wake - 0.25 * blockage;
            u[k] = Math.max(0.05, speed + jitter[k]);
            // Shed-like cross flow, deterministic sines
            v[k] = 0.12 * Math.sin(x * 4.2 + phase) * Math.exp(-yw * yw * 2.2) * Math.min(1, behind + 0.3) + jitter[k] * 0.4;
            // Pressure: stagnation ahead, suction above, recovery downstream
            p[k] = 0.5 * Math.exp(-((x + 0.15) * (x + 0.15) + yb * yb) * 6.0) - 0.35 * Math.exp(-((x - 0.5) * (x - 0.5) + (yb - 0.25) * (yb - 0.25)) * 5.0) - 0.2 * wake;
            // Vorticity: shear layers of opposite sign above and below wake centerline
            const shear = -yw / (wakeWidth + 1e-3);
            omega[k] = 2.2 * shear * Math.exp(-(yw * yw) / (wakeWidth * wakeWidth)) * Math.min(1, behind * 2 + 0.15);
        }
    }
    return { nx, ny, domain, u, v, p, omega, obstacle };
}
