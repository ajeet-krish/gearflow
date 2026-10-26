// Signed distance grids over polygon bodies. Union of bodies is the pointwise
// minimum. Cylinders can pass exact circle definitions so the mask does not
// inherit polygon faceting. Pure math, no rendering or framework imports.

import type { GridSpec } from "@/contracts/types";
import { pointInPolygon } from "@/geometry/parametric";
import type { Point } from "@/geometry/parametric";
import { validateGridSpec } from "@/contracts/schema";

export interface CircleDef {
    x: number;
    y: number;
    r: number;
}

export interface SdfGrid {
    nx: number;
    ny: number;
    sdf: Float32Array;
    obstacle: Float32Array;
}

/** Allocation and work caps: bound nx*ny*points before any typed array is built. */
export const MAX_SDF_BODIES = 8;
export const MAX_SDF_TOTAL_POINTS = 2048;

/** Exact signed distance to a circle: negative inside, zero on the surface. */
export function circleSdf(px: number, py: number, cx: number, cy: number, r: number): number {
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
        throw new Error(`circleSdf: point must be finite, got (${String(px)}, ${String(py)})`);
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        throw new Error(`circleSdf: center must be finite, got (${String(cx)}, ${String(cy)})`);
    }
    if (!Number.isFinite(r) || r <= 0) {
        throw new Error(`circleSdf: r must be a positive finite number, got ${String(r)}`);
    }
    return Math.hypot(px - cx, py - cy) - r;
}

/** Signed distance to a polygon: edge distance, negative inside. */
export function polygonSdf(px: number, py: number, poly: Point[]): number {
    if (!Array.isArray(poly) || poly.length < 3) {
        throw new Error("polygonSdf: polygon must have at least 3 points");
    }
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
        throw new Error(`polygonSdf: query point (${String(px)}, ${String(py)}) must be finite`);
    }
    for (let i = 0; i < poly.length; i++) {
        const pt = poly[i];
        if (typeof pt !== "object" || pt === null || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
            throw new Error(`polygonSdf: polygon[${i}] must have finite x and y, got (${String((pt as Point)?.x)}, ${String((pt as Point)?.y)})`);
        }
    }
    let minD2 = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1e-12;
        const s = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        const ex = a.x + s * dx - px;
        const ey = a.y + s * dy - py;
        const d2 = ex * ex + ey * ey;
        if (d2 < minD2) minD2 = d2;
    }
    const dist = Math.sqrt(minD2);
    return pointInPolygon(px, py, poly) ? -dist : dist;
}

/**
 * Unchecked inner kernel: no per-cell validation. Callers must validate all
 * polygons and circles once up front (buildSdfGrid does). Keeps the
 * nx*ny*nPoints hot loop free of repeated type checks.
 */
function polygonSdfUnsafe(px: number, py: number, poly: Point[]): number {
    let minD2 = Infinity;
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len2 = dx * dx + dy * dy || 1e-12;
        const s = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
        const ex = a.x + s * dx - px;
        const ey = a.y + s * dy - py;
        const d2 = ex * ex + ey * ey;
        if (d2 < minD2) minD2 = d2;
    }
    const dist = Math.sqrt(minD2);
    return pointInPolygon(px, py, poly) ? -dist : dist;
}

/**
 * Build sdf and obstacle masks over a grid. Distance is the union minimum
 * across polygons and exact circles. Obstacle is 1 where sdf <= 0.
 */
export function buildSdfGrid(polygons: Point[][], grid: GridSpec, circles: CircleDef[] = []): SdfGrid {
    if (!Array.isArray(polygons) || polygons.length === 0) {
        throw new Error("buildSdfGrid: polygons must be a non-empty array");
    }
    for (let i = 0; i < polygons.length; i++) {
        if (!Array.isArray(polygons[i]) || polygons[i].length < 3) {
            throw new Error(`buildSdfGrid: polygons[${i}] must have at least 3 points`);
        }
        for (let j = 0; j < polygons[i].length; j++) {
            const pt = polygons[i][j];
            if (typeof pt !== "object" || pt === null || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
                throw new Error(`buildSdfGrid: polygons[${i}][${j}] must have finite x and y, got (${String((pt as Point)?.x)}, ${String((pt as Point)?.y)})`);
            }
        }
    }
    if (!Array.isArray(circles)) {
        throw new Error("buildSdfGrid: circles must be an array");
    }
    for (let i = 0; i < circles.length; i++) {
        const c = circles[i];
        if (typeof c !== "object" || c === null || !Number.isFinite(c.x) || !Number.isFinite(c.y)) {
            throw new Error(`buildSdfGrid: circles[${i}] must have finite x and y`);
        }
        if (!Number.isFinite(c.r) || c.r <= 0) {
            throw new Error(`buildSdfGrid: circles[${i}].r must be a positive finite number`);
        }
    }
    validateGridSpec(grid);
    if (polygons.length > MAX_SDF_BODIES) {
        throw new Error(`buildSdfGrid: ${polygons.length} bodies exceed cap ${MAX_SDF_BODIES}`);
    }
    let totalPoints = 0;
    for (const poly of polygons) totalPoints += poly.length;
    if (totalPoints > MAX_SDF_TOTAL_POINTS) {
        throw new Error(`buildSdfGrid: ${totalPoints} total points exceed cap ${MAX_SDF_TOTAL_POINTS}`);
    }
    const { nx, ny, domain } = grid;
    const sdf = new Float32Array(nx * ny);
    const obstacle = new Float32Array(nx * ny);
    for (let j = 0; j < ny; j++) {
        const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (ny - 1);
        for (let i = 0; i < nx; i++) {
            const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (nx - 1);
            let d = Infinity;
            for (const poly of polygons) {
                const pd = polygonSdfUnsafe(x, y, poly);
                if (pd < d) d = pd;
            }
            for (const c of circles) {
                const cd = Math.hypot(x - c.x, y - c.y) - c.r;
                if (cd < d) d = cd;
            }
            const k = j * nx + i;
            sdf[k] = d;
            obstacle[k] = d <= 0 ? 1 : 0;
        }
    }
    return { nx, ny, sdf, obstacle };
}
