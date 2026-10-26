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
