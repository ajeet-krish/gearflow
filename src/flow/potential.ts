// Constant source plus per-body vortex panel solver (Hess and Smith style).
// Closed bodies only: N constant source strengths plus one vortex strength per
// lifting body. Each Kutta body contributes one Kutta equation (trailing edge
// tangential velocities sum to zero). Non-lifting bodies (cylinder, block,
// duct walls) carry gamma 0 with no Kutta row. Pure math, no rendering or
// framework imports.

import type { Point } from "@/geometry/parametric";
import { dedupClosed, polygonSignedArea } from "@/geometry/parametric";

export interface Panel {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    xc: number;
    yc: number;
    tx: number;
    ty: number;
    nx: number;
    ny: number;
    len: number;
}

export interface PanelSolution {
    panels: Panel[];
    sigma: Float64Array;
    /** Legacy single gamma: gammas[0] for single-body solves, 0 when no Kutta body. */
    gamma: number;
    /** Per-body vortex strength, index aligns with the bodies array passed to solveBodies. */
    gammas: Float64Array;
    /** Body index per panel in panels order. */
    panelBody: number[];
    /** Pressure coefficient per panel, 1 - (Vt / U)^2. */
    cp: Float64Array;
    /** Lift coefficient from pressure integration, referenced to chordRef. */
    cl: number;
}

/** Hard cap on panels per body so the dense solve stays interactive. */
export const MAX_PANELS = 160;
/** Hard cap on total unknowns (panels plus Kutta rows) so Nx(N+1) stays bounded. */
export const MAX_TOTAL_PANELS = 320;
/** Distance guard that keeps near singular evaluations finite. */
export const SINGULARITY_GUARD = 1e-9;

/** Options for solvePanels. kutta false gives pure source flow with gamma 0. */
export interface SolvePanelsOptions {
    kutta?: boolean;
}

function signedArea(pts: Point[]): number {
    // Shared implementation lives in geometry/parametric; kept as a thin alias
    // so existing imports of this module keep working.
    return polygonSignedArea(pts);
}

/**
 * Convert a closed polygon into panels. Deduplicates the closing point,
 * stride caps to MAX_PANELS, enforces CCW (outward normals), and builds
 * collocation points plus tangent and outward normal frames.
 */
export function buildPanels(points: Point[]): Panel[] {
    if (!Array.isArray(points) || points.length < 3) {
        throw new Error(`buildPanels: polygon must have at least 3 points, got ${Array.isArray(points) ? points.length : String(points)}`);
    }
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (typeof p !== "object" || p === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
            throw new Error(`buildPanels: polygon points must be finite, got (${String((p as Point)?.x)}, ${String((p as Point)?.y)})`);
        }
    }
    const clean = dedupClosed(points.map((p) => ({ x: p.x, y: p.y })));
    if (clean.length < 3) {
        throw new Error("buildPanels: polygon collapsed to fewer than 3 distinct points");
    }
    let ordered = clean;
    if (signedArea(ordered) < 0) ordered = [...ordered].reverse();
    let sampled = ordered;
    if (ordered.length > MAX_PANELS) {
        const stride = Math.ceil(ordered.length / MAX_PANELS);
        sampled = [];
        for (let i = 0; i < ordered.length; i += stride) sampled.push(ordered[i]);
    }
    const panels: Panel[] = [];
    for (let i = 0; i < sampled.length; i++) {
        const a = sampled[i];
        const b = sampled[(i + 1) % sampled.length];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const len = Math.hypot(dx, dy);
        if (!(len > 1e-12)) {
            throw new Error(`buildPanels: panel ${i} is degenerate (zero length)`);
        }
        const tx = dx / len;
        const ty = dy / len;
        panels.push({
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            xc: (a.x + b.x) / 2,
            yc: (a.y + b.y) / 2,
            tx,
            ty,
            nx: ty,
            ny: -tx,
            len,
        });
    }
    return panels;
}

interface UnitInfluence {
    /** Normal velocity from unit source strength. */
    cnS: number;
    /** Tangential velocity from unit source strength. */
    ctS: number;
    /** Normal velocity from unit vortex strength (CCW positive). */
    cnV: number;
    /** Tangential velocity from unit vortex strength. */
    ctV: number;
}

/**
 * Unit strength influence of panel pj at the collocation point of panel pi.
 * Source field (us along pj tangent, ws along pj normal) and the vortex field
 * (source field rotated +90 degrees, CCW positive) are projected onto pi's
 * normal and tangent frames.
 */
function influence(pi: Panel, pj: Panel): UnitInfluence {
    const dx = pi.xc - pj.x1;
    const dy = pi.yc - pj.y1;
    const x = dx * pj.tx + dy * pj.ty;
    const z = dx * pj.nx + dy * pj.ny;
    const L = pj.len;
    const g2 = SINGULARITY_GUARD * SINGULARITY_GUARD;
    const r1 = Math.max(x * x + z * z, g2);
    const xL = x - L;
    const r2 = Math.max(xL * xL + z * z, g2);
    const us = (Math.log(r1) - Math.log(r2)) / (4 * Math.PI);
    const a1 = Math.atan2(z, x);
    const a2 = Math.atan2(z, xL);
    const ws = (a2 - a1) / (2 * Math.PI);
    const tjn = pj.tx * pi.nx + pj.ty * pi.ny;
    const njn = pj.nx * pi.nx + pj.ny * pi.ny;
    const tjt = pj.tx * pi.tx + pj.ty * pi.ty;
    const njt = pj.nx * pi.tx + pj.ny * pi.ty;
    return {
        cnS: us * tjn + ws * njn,
        ctS: us * tjt + ws * njt,
        cnV: -ws * tjn + us * njn,
        ctV: -ws * tjt + us * njt,
    };
}

/** Unit strength field of panel p at an arbitrary point (global frame). */
function unitField(px: number, py: number, p: Panel): { us: number; ws: number } {
    const dx = px - p.x1;
    const dy = py - p.y1;
    const x = dx * p.tx + dy * p.ty;
    const z = dx * p.nx + dy * p.ny;
    const L = p.len;
    const g2 = SINGULARITY_GUARD * SINGULARITY_GUARD;
    const r1 = Math.max(x * x + z * z, g2);
    const xL = x - L;
    const r2 = Math.max(xL * xL + z * z, g2);
    const us = (Math.log(r1) - Math.log(r2)) / (4 * Math.PI);
    const a1 = Math.atan2(z, x);
    const a2 = Math.atan2(z, xL);
    const ws = (a2 - a1) / (2 * Math.PI);
    return { us, ws };
}

/**
 * Solve the multi-body panel system for freestream (U, 0). Each entry of
 * bodies holds that body's panels; kuttaPerBody selects which bodies carry a
 * vortex unknown plus a Kutta equation on that body's own TE pair. Bodies
 * without Kutta keep gamma 0. Returns per-body gammas, per panel Cp, and
 * lift coefficient.
 */
export function solveBodies(
    bodies: Panel[][],
    U: number,
    chordRef = 1,
    kuttaPerBody?: boolean[]
): PanelSolution {
    if (!Array.isArray(bodies) || bodies.length === 0) {
        throw new Error("solveBodies: need at least one body");
    }
    for (let b = 0; b < bodies.length; b++) {
        if (!Array.isArray(bodies[b]) || bodies[b].length < 3) {
            throw new Error(`solveBodies: body ${b} needs at least 3 panels, got ${Array.isArray(bodies[b]) ? bodies[b].length : String(bodies[b])}`);
        }
        if (bodies[b].length > MAX_PANELS) {
            throw new Error(`solveBodies: body ${b} has ${bodies[b].length} panels, exceeds per-body cap ${MAX_PANELS}`);
        }
    }
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`solveBodies: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(chordRef) || chordRef <= 0) {
        throw new Error(`solveBodies: chordRef must be a positive finite number, got ${String(chordRef)}`);
    }
    const kutta = bodies.map((_, b) => kuttaPerBody?.[b] ?? false);
    if (kuttaPerBody !== undefined && kuttaPerBody.length !== bodies.length) {
        throw new Error(`solveBodies: kuttaPerBody length ${kuttaPerBody.length} does not match bodies ${bodies.length}`);
    }
    const panels: Panel[] = [];
    const panelBody: number[] = [];
    const bodyStart: number[] = [];
    for (let b = 0; b < bodies.length; b++) {
        bodyStart.push(panels.length);
        for (const p of bodies[b]) {
            panels.push(p);
            panelBody.push(b);
        }
    }
    const n = panels.length;
    const kuttaBodies: number[] = [];
    for (let b = 0; b < bodies.length; b++) if (kutta[b]) kuttaBodies.push(b);
    const K = kuttaBodies.length;
    const N = n + K;
    // Enforce total cap before allocating the Nx(N+1) augmented system.
    if (N > MAX_TOTAL_PANELS) {
        throw new Error(`solveBodies: total unknowns ${N} (panels ${n} plus ${K} Kutta rows) exceed cap ${MAX_TOTAL_PANELS}`);
    }
    const aug: Float64Array[] = [];
    for (let i = 0; i < N; i++) aug.push(new Float64Array(N + 1));
    const gammaColOfBody = new Map<number, number>();
    kuttaBodies.forEach((b, k) => gammaColOfBody.set(b, n + k));
    for (let i = 0; i < n; i++) {
        const c = panels[i];
        for (let j = 0; j < n; j++) {
            let cnS: number;
            if (i === j) {
                cnS = 0.5;
            } else {
                cnS = influence(c, panels[j]).cnS;
            }
            aug[i][j] = cnS;
        }
        for (let k = 0; k < K; k++) {
            const b = kuttaBodies[k];
            let sumCnV = 0;
            const start = bodyStart[b];
            const end = start + bodies[b].length;
            for (let j = start; j < end; j++) {
                if (i === j) continue;
                sumCnV += influence(c, panels[j]).cnV;
            }
            aug[i][n + k] = sumCnV;
        }
        aug[i][N] = -(U * c.nx);
    }
    for (let k = 0; k < K; k++) {
        const b = kuttaBodies[k];
        const row = n + k;
        const te0 = bodyStart[b];
        const te1 = bodyStart[b] + bodies[b].length - 1;
        const p0 = panels[te0];
        const p1 = panels[te1];
        for (let j = 0; j < n; j++) {
            let ctS0: number;
            let ctS1: number;
            if (j === te0) {
                ctS0 = 0;
            } else {
                ctS0 = influence(p0, panels[j]).ctS;
            }
            if (j === te1) {
                ctS1 = 0;
            } else {
                ctS1 = influence(p1, panels[j]).ctS;
            }
            aug[row][j] = ctS0 + ctS1;
        }
        for (let m = 0; m < K; m++) {
            const bm = kuttaBodies[m];
            let sumCtV = 0;
            const start = bodyStart[bm];
            const end = start + bodies[bm].length;
            for (let j = start; j < end; j++) {
                let ctV0: number;
                let ctV1: number;
                if (j === te0) {
                    ctV0 = -0.5;
                } else {
                    ctV0 = influence(p0, panels[j]).ctV;
                }
                if (j === te1) {
                    ctV1 = -0.5;
                } else {
                    ctV1 = influence(p1, panels[j]).ctV;
                }
                sumCtV += ctV0 + ctV1;
            }
            aug[row][n + m] = sumCtV;
        }
        aug[row][N] = -(U * p0.tx + U * p1.tx);
    }
    for (let col = 0; col < N; col++) {
        let piv = col;
        let best = Math.abs(aug[col][col]);
        for (let r = col + 1; r < N; r++) {
            const v = Math.abs(aug[r][col]);
            if (v > best) {
                best = v;
                piv = r;
            }
        }
        if (!(best > 0) || !Number.isFinite(best)) {
            throw new Error("solveBodies: singular panel system");
        }
        if (piv !== col) {
            const tmp = aug[col];
            aug[col] = aug[piv];
            aug[piv] = tmp;
        }
        const diag = aug[col][col];
        for (let r = col + 1; r < N; r++) {
            const f = aug[r][col] / diag;
            if (f !== 0) {
                for (let c = col; c <= N; c++) aug[r][c] -= f * aug[col][c];
            }
        }
    }
    const x = new Float64Array(N);
    for (let r = N - 1; r >= 0; r--) {
        let s = aug[r][N];
        for (let c = r + 1; c < N; c++) s -= aug[r][c] * x[c];
        x[r] = s / aug[r][r];
        if (!Number.isFinite(x[r])) {
            throw new Error("solveBodies: singular panel system");
        }
    }
    const sigma = x.slice(0, n);
    const gammas = new Float64Array(bodies.length);
    for (let k = 0; k < K; k++) gammas[kuttaBodies[k]] = x[n + k];
    const gamma = K > 0 ? gammas[kuttaBodies[0]] : 0;
    const cp = new Float64Array(n);
    let lift = 0;
    for (let i = 0; i < n; i++) {
        const c = panels[i];
        let vt = U * c.tx;
        for (let j = 0; j < n; j++) {
            let ctS: number;
            let ctV: number;
            if (i === j) {
                ctS = 0;
                ctV = -0.5;
            } else {
                const inf = influence(c, panels[j]);
                ctS = inf.ctS;
                ctV = inf.ctV;
            }
            const gj = gammas[panelBody[j]];
            vt += sigma[j] * ctS + gj * ctV;
        }
        const vtr = vt / U;
        cp[i] = 1 - vtr * vtr;
        lift += -cp[i] * c.ny * c.len;
    }
    for (let i = 0; i < n; i++) {
        if (!Number.isFinite(cp[i])) {
            throw new Error(`solveBodies: non-finite cp[${i}] (singular panel evaluation)`);
        }
    }
    const cl = lift / chordRef;
    if (!Number.isFinite(cl)) {
        throw new Error("solveBodies: non-finite cl (singular panel evaluation)");
    }
    return { panels, sigma, gamma, gammas, panelBody, cp, cl };
}

/**
 * Solve a single body panel system for freestream (U, 0). Kutta defaults to
 * true for backward compatibility; pass { kutta: false } for non-lifting
 * bodies (cylinder, block, duct) to get pure source flow with gamma 0.
 */
export function solvePanels(panels: Panel[], U: number, chordRef = 1, opts: SolvePanelsOptions = {}): PanelSolution {
    if (!Array.isArray(panels) || panels.length < 3) {
        throw new Error(`solvePanels: need at least 3 panels, got ${Array.isArray(panels) ? panels.length : String(panels)}`);
    }
    // Enforce per-body cap before delegating so raw arrays cannot bypass it.
    if (panels.length > MAX_PANELS) {
        throw new Error(`solvePanels: ${panels.length} panels exceed cap ${MAX_PANELS}`);
    }
    return solveBodies([panels], U, chordRef, [opts.kutta ?? true]);
}

/** Velocity at (x, y) from a solved panel system plus freestream (U, 0). Uses per-body gamma. */
export function panelVelocity(x: number, y: number, sol: PanelSolution, U: number): { u: number; v: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`panelVelocity: point must be finite, got (${String(x)}, ${String(y)})`);
    }
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`panelVelocity: U must be a positive finite number, got ${String(U)}`);
    }
    const { panels, sigma } = sol;
    const gammas = sol.gammas ?? new Float64Array([sol.gamma]);
    const body = sol.panelBody ?? panels.map(() => 0);
    let u = U;
    let v = 0;
    for (let j = 0; j < panels.length; j++) {
        const p = panels[j];
        const gj = gammas[body[j]] ?? 0;
        const f = unitField(x, y, p);
        const lu = sigma[j] * f.us - gj * f.ws;
        const lw = sigma[j] * f.ws + gj * f.us;
        u += lu * p.tx + lw * p.nx;
        v += lu * p.ty + lw * p.ny;
    }
    return { u, v };
}

/**
 * Exact potential flow around a cylinder (uniform stream plus doublet, with
 * optional circulation gamma, CCW positive). Returns zero velocity inside the
 * solid. Freestream is (U, 0); alpha enters through geometry placement.
 */
export function cylinderVelocity(
    x: number,
    y: number,
    cx: number,
    cy: number,
    radius: number,
    U: number,
    gamma = 0
): { u: number; v: number } {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`cylinderVelocity: point must be finite, got (${String(x)}, ${String(y)})`);
    }
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
        throw new Error(`cylinderVelocity: center must be finite, got (${String(cx)}, ${String(cy)})`);
    }
    if (!Number.isFinite(radius) || radius <= 0) {
        throw new Error(`cylinderVelocity: radius must be a positive finite number, got ${String(radius)}`);
    }
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`cylinderVelocity: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(gamma)) {
        throw new Error(`cylinderVelocity: gamma must be finite, got ${String(gamma)}`);
    }
    const dx = x - cx;
    const dy = y - cy;
    const r2 = dx * dx + dy * dy;
    const R2 = radius * radius;
    if (r2 <= R2) return { u: 0, v: 0 };
    const r4 = r2 * r2;
    const doublet = (U * R2) / r4;
    let u = U - doublet * (dx * dx - dy * dy);
    let v = -doublet * 2 * dx * dy;
    if (gamma !== 0) {
        const circ = gamma / (2 * Math.PI * r2);
        u += -circ * dy;
        v += circ * dx;
    }
    return { u, v };
}
