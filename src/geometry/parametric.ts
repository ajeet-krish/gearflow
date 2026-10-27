// Parametric geometry for GearFlow. Y-up world. DO NOT negate y.
// Adapted from AK-Vortex naca.ts (cf-desktop/src/utils/naca.ts): keeps cosine
// spacing and a closed trailing edge (coeff -0.1036). Two deliberate
// differences from that reference:
// 1. AK-Vortex negates y because browser canvas y grows downward. GearFlow
//    world coords are y-up, so camber stays positive here (no y negation).
// 2. AK-Vortex transformPoints is a pure math rotation (CCW positive).
//    GearFlow transformPoints takes an aerodynamic angle of attack:
//    positive alphaDeg means nose up (leading edge rises relative to the
//    trailing edge). In y-up math coords nose up is a clockwise rotation, so
//    the math angle is negated internally. With the LE fixed at the origin,
//    positive alpha moves the TE down (for example, (1, 0) at +6 deg goes to
//    approximately (0.9945, -0.1045)).

import type { GeometrySpec } from "@/contracts/types";
import {
    ORIFICE_GAP_DEFAULT,
    ORIFICE_GAP_MAX,
    ORIFICE_GAP_MIN,
    ORIFICE_THICKNESS_DEFAULT,
    ORIFICE_THICKNESS_MAX,
    ORIFICE_THICKNESS_MIN,
    ORIFICE_WALL_HALF,
} from "@/contracts/types";

export interface Point {
    x: number;
    y: number;
}

/** Max camber fraction accepted by naca4Airfoil. */
export const NACA_M_MAX = 0.095;
/** Max thickness fraction accepted by naca4Airfoil. */
export const NACA_T_MAX = 0.4;

function assertFiniteNumber(name: string, value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${name} must be a finite number, got ${String(value)}`);
    }
}

/**
 * NACA 4-digit airfoil polygon, y-up, closed trailing edge (coeff -0.1036).
 * Returns closed polygon: upper surface TE to LE, then lower surface LE to TE.
 */
export function naca4Airfoil(m: number, p: number, t: number, nPoints = 100): Point[] {
    if (!Number.isInteger(nPoints) || nPoints < 2) {
        throw new Error(`naca4Airfoil: nPoints must be an integer >= 2, got ${String(nPoints)}`);
    }
    if (!(m >= 0 && m <= NACA_M_MAX)) {
        throw new Error(`naca4Airfoil: m (max camber) must be in [0, ${NACA_M_MAX}], got ${m}`);
    }
    if (m > 1e-10 && !(p > 0 && p < 1)) {
        throw new Error(`naca4Airfoil: p (camber position) must be in (0, 1) when m > 0, got ${p}`);
    }
    if (!(t > 0 && t <= NACA_T_MAX)) {
        throw new Error(`naca4Airfoil: t (thickness) must be in (0, ${NACA_T_MAX}], got ${t}`);
    }
    const n = nPoints;
    const x: number[] = [];
    for (let i = 0; i < n; i++) {
        const beta = (i / (n - 1)) * Math.PI;
        x.push((1 - Math.cos(beta)) / 2);
    }
    const yt: number[] = x.map(
        (xi) =>
            5 * t * (0.2969 * Math.sqrt(xi) - 0.126 * xi - 0.3516 * xi * xi + 0.2843 * xi * xi * xi - 0.1036 * xi * xi * xi * xi)
    );
    const yc = new Array<number>(n).fill(0);
    const dyc = new Array<number>(n).fill(0);
    if (m > 1e-10 && p > 1e-10) {
        for (let i = 0; i < n; i++) {
            if (x[i] < p) {
                yc[i] = (m / (p * p)) * (2 * p * x[i] - x[i] * x[i]);
                dyc[i] = ((2 * m) / (p * p)) * (p - x[i]);
            } else {
                yc[i] = (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x[i] - x[i] * x[i]);
                dyc[i] = ((2 * m) / ((1 - p) * (1 - p))) * (p - x[i]);
            }
        }
    }
    const upper: Point[] = [];
    const lower: Point[] = [];
    for (let i = 0; i < n; i++) {
        const theta = Math.atan(dyc[i]);
        upper.push({ x: x[i] - yt[i] * Math.sin(theta), y: yc[i] + yt[i] * Math.cos(theta) });
        lower.push({ x: x[i] + yt[i] * Math.sin(theta), y: yc[i] - yt[i] * Math.cos(theta) });
    }
    const result: Point[] = [];
    for (let i = n - 1; i >= 0; i--) result.push(upper[i]);
    for (let i = 1; i < n; i++) result.push(lower[i]);
    return result;
}

/**
 * Rotate, scale, translate. Pure, returns new points.
 * angleDeg is an aerodynamic angle of attack: positive means nose up, which
 * is clockwise in y-up coords, so the math rotation angle is negated.
 */
export function transformPoints(points: Point[], cx: number, cy: number, scale: number, angleDeg: number): Point[] {
    if (!Array.isArray(points) || points.length === 0) {
        throw new Error("transformPoints: polygon must be non-empty");
    }
    assertFiniteNumber("transformPoints: cx", cx);
    assertFiniteNumber("transformPoints: cy", cy);
    if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`transformPoints: scale (chord) must be a positive finite number, got ${String(scale)}`);
    }
    assertFiniteNumber("transformPoints: angleDeg", angleDeg);
    // Aerodynamic sign: positive alpha is nose up, clockwise in y-up.
    const a = (-angleDeg * Math.PI) / 180;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    return points.map((pt) => {
        if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
            throw new Error(`transformPoints: polygon points must be finite, got (${String(pt.x)}, ${String(pt.y)})`);
        }
        const xs = pt.x * scale;
        const ys = pt.y * scale;
        return { x: xs * cosA - ys * sinA + cx, y: xs * sinA + ys * cosA + cy };
    });
}

/** Ray cast point in polygon. */
export function pointInPolygon(px: number, py: number, poly: Point[]): boolean {
    if (!Array.isArray(poly) || poly.length === 0) {
        throw new Error("pointInPolygon: polygon must be non-empty");
    }
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x;
        const yi = poly[i].y;
        const xj = poly[j].x;
        const yj = poly[j].y;
        if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/** Parse a 4 digit code into m, p, t fractions. Rejects unrealistic codes. */
export function parseNaca4(code: string): { m: number; p: number; t: number } {
    if (!/^\d{4}$/.test(code)) throw new Error(`NACA code must be 4 digits, got ${code}`);
    const m = parseInt(code[0], 10) / 100;
    const p = parseInt(code[1], 10) / 10;
    const t = parseInt(code.slice(2), 10) / 100;
    if (!(m >= 0 && m <= NACA_M_MAX)) {
        throw new Error(`parseNaca4: camber digit out of range in code ${code} (m=${m} not in [0, ${NACA_M_MAX}])`);
    }
    if (m > 1e-10 && !(p > 0 && p < 1)) {
        throw new Error(`parseNaca4: camber position digit out of range in code ${code} (p=${p} not in (0, 1))`);
    }
    if (!(t > 0 && t <= NACA_T_MAX)) {
        throw new Error(`parseNaca4: thickness digits out of range in code ${code} (t=${t} not in (0, ${NACA_T_MAX}])`);
    }
    return { m, p, t };
}

/** Signed distance approx: negative inside, normalized by chord. Uses edge distance + inside test. */
export function sdfNormalized(px: number, py: number, poly: Point[], chord = 1): number {
    if (!Array.isArray(poly) || poly.length === 0) {
        throw new Error("sdfNormalized: polygon must be non-empty");
    }
    if (!Number.isFinite(chord) || chord === 0) {
        throw new Error(`sdfNormalized: chord must be a nonzero finite number, got ${String(chord)}`);
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
    const dist = Math.sqrt(minD2) / chord;
    return pointInPolygon(px, py, poly) ? -dist : dist;
}

/** Hard cap on points per polygon so the dense panel solve stays interactive. */
export const MAX_POLYGON_POINTS = 160;

/** Cylinder polygon, counter-clockwise, y-up. Angle 0 sits at (cx + r, cy). */
export function cylinderPolygon(cx: number, cy: number, radius: number, nPoints = 64): Point[] {
    assertFiniteNumber("cylinderPolygon: cx", cx);
    assertFiniteNumber("cylinderPolygon: cy", cy);
    if (!Number.isFinite(radius) || radius <= 0) {
        throw new Error(`cylinderPolygon: radius must be a positive finite number, got ${String(radius)}`);
    }
    if (!Number.isInteger(nPoints) || nPoints < 4) {
        throw new Error(`cylinderPolygon: nPoints must be an integer >= 4, got ${String(nPoints)}`);
    }
    const pts: Point[] = [];
    for (let i = 0; i < nPoints; i++) {
        const a = (i / nPoints) * 2 * Math.PI;
        pts.push({ x: cx + radius * Math.cos(a), y: cy + radius * Math.sin(a) });
    }
    return pts;
}

/** Even arclength sampler around an axis aligned rectangle, CCW from (x0, y0). */
function sampleRectangle(x0: number, y0: number, x1: number, y1: number, nPoints: number): Point[] {
    const corners: Point[] = [
        { x: x0, y: y0 },
        { x: x1, y: y0 },
        { x: x1, y: y1 },
        { x: x0, y: y1 },
    ];
    const edgeLen: number[] = [];
    let perimeter = 0;
    for (let e = 0; e < 4; e++) {
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        edgeLen.push(len);
        perimeter += len;
    }
    const pts: Point[] = [];
    for (let i = 0; i < nPoints; i++) {
        let s = (i / nPoints) * perimeter;
        let e = 0;
        while (e < 3 && s > edgeLen[e]) {
            s -= edgeLen[e];
            e++;
        }
        const a = corners[e];
        const b = corners[(e + 1) % 4];
        const t = edgeLen[e] > 0 ? s / edgeLen[e] : 0;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    return pts;
}

/** Block polygon, counter-clockwise, centered at (cx, cy). */
export function blockPolygon(cx: number, cy: number, width: number, height: number, nPoints = 64): Point[] {
    assertFiniteNumber("blockPolygon: cx", cx);
    assertFiniteNumber("blockPolygon: cy", cy);
    if (!Number.isFinite(width) || width <= 0) {
        throw new Error(`blockPolygon: width must be a positive finite number, got ${String(width)}`);
    }
    if (!Number.isFinite(height) || height <= 0) {
        throw new Error(`blockPolygon: height must be a positive finite number, got ${String(height)}`);
    }
    if (!Number.isInteger(nPoints) || nPoints < 4) {
        throw new Error(`blockPolygon: nPoints must be an integer >= 4, got ${String(nPoints)}`);
    }
    return sampleRectangle(cx - width / 2, cy - height / 2, cx + width / 2, cy + height / 2, nPoints);
}

/**
 * Orifice plate polygons: two solid segments above and below a central gap
 * of full height `gap`, plate thickness `thickness` in x. Segments run from
 * the gap edge out to wallHalf in y (default 1.5, past the domain edge, to
 * limit bypass flow around the plate ends). Returns [upper, lower]. Alpha
 * rotation is ignored for orifice plates so the plate stays normal to the
 * channel axis.
 */
export function orificePolygons(
    cx: number,
    cy: number,
    thickness: number,
    gap: number,
    nPoints = 64,
    wallHalf = ORIFICE_WALL_HALF
): Point[][] {
    assertFiniteNumber("orificePolygons: cx", cx);
    assertFiniteNumber("orificePolygons: cy", cy);
    if (!Number.isFinite(thickness) || thickness < ORIFICE_THICKNESS_MIN || thickness > ORIFICE_THICKNESS_MAX) {
        throw new Error(`orificePolygons: thickness must be in [${ORIFICE_THICKNESS_MIN}, ${ORIFICE_THICKNESS_MAX}], got ${String(thickness)}`);
    }
    if (!Number.isFinite(gap) || gap < ORIFICE_GAP_MIN || gap > ORIFICE_GAP_MAX) {
        throw new Error(`orificePolygons: gap must be in [${ORIFICE_GAP_MIN}, ${ORIFICE_GAP_MAX}], got ${String(gap)}`);
    }
    if (!Number.isInteger(nPoints) || nPoints < 4) {
        throw new Error(`orificePolygons: nPoints must be an integer >= 4, got ${String(nPoints)}`);
    }
    if (!Number.isFinite(wallHalf) || wallHalf <= gap / 2) {
        throw new Error(`orificePolygons: wallHalf must be finite and exceed gap / 2, got ${String(wallHalf)}`);
    }
    const per = Math.max(4, Math.ceil(nPoints / 2));
    const upper = sampleRectangle(cx - thickness / 2, cy + gap / 2, cx + thickness / 2, cy + wallHalf, per);
    const lower = sampleRectangle(cx - thickness / 2, cy - wallHalf, cx + thickness / 2, cy - gap / 2, per);
    return [upper, lower];
}

/**
 * Migrate a legacy duct spec to the orifice plate body. The duct channel
 * height becomes the orifice gap (clamped to the gap envelope), the plate
 * thickness resets to the default because duct width measured the channel
 * length, not a plate thickness. Non-duct specs pass through unchanged.
 */
export function migrateDuctToOrifice(spec: GeometrySpec): GeometrySpec {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("migrateDuctToOrifice: spec must be an object");
    }
    if ((spec as unknown as { kind: string }).kind !== "duct") return { ...(spec as GeometrySpec) };
    const legacy = spec as unknown as Record<string, unknown>;
    const rawGap = typeof legacy.height === "number" ? (legacy.height as number) : ORIFICE_GAP_DEFAULT;
    const gap = Number.isFinite(rawGap)
        ? Math.min(ORIFICE_GAP_MAX, Math.max(ORIFICE_GAP_MIN, rawGap))
        : ORIFICE_GAP_DEFAULT;
    const next: GeometrySpec = {
        ...(spec as GeometrySpec),
        kind: "orifice",
        width: ORIFICE_THICKNESS_DEFAULT,
        height: gap,
    };
    return next;
}

/** Signed area of a closed polygon (positive for CCW). Shared with the panel solver. */
export function polygonSignedArea(pts: Point[]): number {
    let a = 0;
    for (let i = 0; i < pts.length; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % pts.length];
        a += p.x * q.y - q.x * p.y;
    }
    return a / 2;
}

function ensureCCW(pts: Point[]): Point[] {
    return polygonSignedArea(pts) < 0 ? [...pts].reverse() : pts;
}

/** Drop consecutive duplicates (tolerance 1e-12) and a duplicate closing point. Shared with the panel solver. */
export function dedupClosed(pts: Point[]): Point[] {
    const out: Point[] = [];
    for (const p of pts) {
        const q = out[out.length - 1];
        if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-12) out.push({ x: p.x, y: p.y });
    }
    if (out.length > 1) {
        const f = out[0];
        const l = out[out.length - 1];
        if (Math.hypot(f.x - l.x, f.y - l.y) <= 1e-12) out.pop();
    }
    return out;
}

/** Stride sample long polygons down to MAX_POLYGON_POINTS points. */
function strideCap(pts: Point[]): Point[] {
    if (pts.length <= MAX_POLYGON_POINTS) return pts;
    const stride = Math.ceil(pts.length / MAX_POLYGON_POINTS);
    const out: Point[] = [];
    for (let i = 0; i < pts.length; i += stride) out.push(pts[i]);
    return out;
}

/**
 * Build world space polygons for a GeometrySpec. Chord is 1 with LE at (0, 0),
 * y-up. Alpha rotates the geometry while the freestream stays fixed at (U, 0).
 * Returns one polygon per body (orifice plates return two wall polygons). Output is
 * deduplicated (closed TE point removed), stride capped, and CCW.
 */
export function buildPolygons(spec: GeometrySpec): Point[][] {
    if (typeof spec !== "object" || spec === null) {
        throw new Error("buildPolygons: spec must be an object");
    }
    const kinds = ["naca4", "cylinder", "block", "orifice", "custom"];
    if (!kinds.includes(spec.kind)) {
        throw new Error(`buildPolygons: kind must be one of ${kinds.join(", ")}, got ${String(spec.kind)}`);
    }
    assertFiniteNumber("buildPolygons: chord", spec.chord);
    if (spec.chord <= 0) {
        throw new Error(`buildPolygons: chord must be positive, got ${String(spec.chord)}`);
    }
    assertFiniteNumber("buildPolygons: alphaDeg", spec.alphaDeg);
    if (!Number.isInteger(spec.nPoints) || spec.nPoints < 4) {
        throw new Error(`buildPolygons: nPoints must be an integer >= 4, got ${String(spec.nPoints)}`);
    }
    const center = spec.center ?? { x: 0.5, y: 0 };
    assertFiniteNumber("buildPolygons: center.x", center.x);
    assertFiniteNumber("buildPolygons: center.y", center.y);
    let polys: Point[][];
    if (spec.kind === "naca4") {
        if (!spec.naca) throw new Error("buildPolygons: naca params are required for kind naca4");
        const raw = naca4Airfoil(spec.naca.m, spec.naca.p, spec.naca.t, spec.nPoints);
        polys = [transformPoints(raw, 0, 0, spec.chord, spec.alphaDeg)];
    } else if (spec.kind === "cylinder") {
        const radius = spec.radius ?? 0.25;
        polys = [cylinderPolygon(center.x, center.y, radius, spec.nPoints)];
    } else if (spec.kind === "block") {
        const width = spec.width ?? 0.5;
        const height = spec.height ?? 0.5;
        const raw = blockPolygon(0, 0, width, height, spec.nPoints);
        polys = [transformPoints(raw, center.x, center.y, 1, spec.alphaDeg)];
    } else if (spec.kind === "custom") {
        if (!Array.isArray(spec.polygon) || spec.polygon.length < 3) {
            throw new Error("buildPolygons: polygon with at least 3 points is required for kind custom");
        }
        const raw = spec.polygon.map((pt) => {
            assertFiniteNumber("buildPolygons: polygon.x", pt.x);
            assertFiniteNumber("buildPolygons: polygon.y", pt.y);
            return { x: pt.x, y: pt.y };
        });
        polys = [transformPoints(raw, 0, 0, spec.chord, spec.alphaDeg)];
    } else {
        const thickness = spec.width ?? ORIFICE_THICKNESS_DEFAULT;
        const gap = spec.height ?? ORIFICE_GAP_DEFAULT;
        polys = orificePolygons(center.x, center.y, thickness, gap, spec.nPoints);
    }
    return polys.map((poly) => ensureCCW(strideCap(dedupClosed(poly))));
}
