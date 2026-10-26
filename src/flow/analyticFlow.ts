// Analytic potential flow fields for GearFlow Phase 2. Panel solution sets the
// inviscid velocity, Bernoulli sets pressure, central differences set
// vorticity, and the wake overlay adds the only Reynolds number dependence.
// Deterministic: same inputs always give identical outputs.
// Pure math, no rendering or framework imports.

import type { FlowField, GeometrySpec, GridSpec } from "@/contracts/types";
import { validateGeometrySpec, validateGridSpec } from "@/contracts/schema";
import { buildPolygons } from "@/geometry/parametric";
import type { Point } from "@/geometry/parametric";
import { buildPanels, solveBodies, panelVelocity } from "./potential";
import type { Panel, PanelSolution } from "./potential";
import { buildSdfGrid } from "./sdf";
import type { CircleDef } from "./sdf";
import { applyWake } from "./wake";

export interface AnalyticFlowParams {
    /** Freestream speed. Defaults to 1. */
    U?: number;
    /** Reynolds number, wake only. Defaults to 1000. */
    Re?: number;
}

export interface ResolvedBody {
    polygons: Point[][];
    panels: Panel[];
    sol: PanelSolution;
    circles: CircleDef[];
}

export interface AnalyticFlowResult {
    field: FlowField;
    cl: number;
    cpMin: number;
    solveMs: number;
    panelCount: number;
}

function resolveParams(params: AnalyticFlowParams = {}): { U: number; Re: number } {
    const U = params.U ?? 1;
    const Re = params.Re ?? 1000;
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`generateAnalyticFlow: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(Re) || Re <= 0) {
        throw new Error(`generateAnalyticFlow: Re must be a positive finite number, got ${String(Re)}`);
    }
    return { U, Re };
}

/** Build polygons, panels with exact cylinder circles, and the panel solution. */
export function resolveBody(geom: GeometrySpec, U: number): { body: ResolvedBody; solveMs: number } {
    validateGeometrySpec(geom);
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`resolveBody: U must be a positive finite number, got ${String(U)}`);
    }
    const t0 = Date.now();
    const polygons = buildPolygons(geom);
    const bodies = polygons.map((poly) => buildPanels(poly));
    const kuttaPerBody = bodies.map(() => geom.kind === 'naca4');
    const sol = solveBodies(bodies, U, geom.chord, kuttaPerBody);
    if (!Number.isFinite(sol.cl)) {
        throw new Error("resolveBody: non-finite cl (singular panel evaluation)");
    }
    for (const c of sol.cp) {
        if (!Number.isFinite(c)) {
            throw new Error("resolveBody: non-finite cp (singular panel evaluation)");
        }
    }
    const panels = sol.panels;
    let circles: CircleDef[] = [];
    if (geom.kind === "cylinder") {
        const c = geom.center ?? { x: 0.5, y: 0 };
        circles = [{ x: c.x, y: c.y, r: geom.radius ?? 0.25 }];
    }
    const solveMs = Date.now() - t0;
    return { body: { polygons, panels, sol, circles }, solveMs };
}

/** Evaluate the full field from a cached panel solution. Re is wake only. */
export function fieldFromResolved(
    grid: GridSpec,
    geom: GeometrySpec,
    body: ResolvedBody,
    U: number,
    Re: number
): FlowField {
    validateGridSpec(grid);
    if (!Number.isFinite(U) || U <= 0) {
        throw new Error(`fieldFromResolved: U must be a positive finite number, got ${String(U)}`);
    }
    if (!Number.isFinite(Re) || Re <= 0) {
        throw new Error(`fieldFromResolved: Re must be a positive finite number, got ${String(Re)}`);
    }
    const { nx, ny, domain } = grid;
    const n = nx * ny;
    const sdfGrid = buildSdfGrid(body.polygons, grid, body.circles);
    const obstacle = sdfGrid.obstacle;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    const p = new Float32Array(n);
    const omega = new Float32Array(n);
    const dx = (domain.xMax - domain.xMin) / (nx - 1);
    const dy = (domain.yMax - domain.yMin) / (ny - 1);
    for (let j = 0; j < ny; j++) {
        const y = domain.yMin + dy * j;
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (obstacle[k] > 0.5) continue;
            const x = domain.xMin + dx * i;
            const vel = panelVelocity(x, y, body.sol, U);
            u[k] = vel.u;
            v[k] = vel.v;
        }
    }
    let baseY = geom.center?.y ?? 0;
    if (geom.kind === "naca4" && body.polygons[0] && body.polygons[0].length > 0) {
        let sum = 0;
        for (const pt of body.polygons[0]) sum += pt.y;
        baseY = sum / body.polygons[0].length;
    }
    const slope = -Math.tan((geom.alphaDeg * Math.PI) / 180) * 0.5;
    applyWake(u, v, nx, ny, domain, obstacle, { U, Re, baseY, slope });
    const cap = 3 * U;
    for (let k = 0; k < n; k++) {
        if (obstacle[k] > 0.5) continue;
        const sp = Math.hypot(u[k], v[k]);
        if (sp > cap && sp > 0) {
            const s = cap / sp;
            u[k] *= s;
            v[k] *= s;
        }
    }
    const halfU2 = 0.5 * U * U;
    for (let k = 0; k < n; k++) {
        if (obstacle[k] > 0.5) continue;
        p[k] = halfU2 - 0.5 * (u[k] * u[k] + v[k] * v[k]);
    }
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const k = j * nx + i;
            if (obstacle[k] > 0.5) {
                omega[k] = 0;
                continue;
            }
            const iL = i > 0 ? i - 1 : i;
            const iR = i < nx - 1 ? i + 1 : i;
            const jB = j > 0 ? j - 1 : j;
            const jT = j < ny - 1 ? j + 1 : j;
            const dvdx = (v[j * nx + iR] - v[j * nx + iL]) / ((iR - iL) * dx || 1);
            const dudy = (u[jT * nx + i] - u[jB * nx + i]) / ((jT - jB) * dy || 1);
            omega[k] = dvdx - dudy;
        }
    }
    for (let k = 0; k < n; k++) {
        if (obstacle[k] > 0.5) {
            u[k] = 0;
            v[k] = 0;
            p[k] = 0;
            omega[k] = 0;
        }
    }
    let nonFiniteCount = 0;
    for (let k = 0; k < n; k++) {
        if (obstacle[k] > 0.5) continue;
        if (!Number.isFinite(u[k]) || !Number.isFinite(v[k]) || !Number.isFinite(p[k]) || !Number.isFinite(omega[k])) nonFiniteCount++;
    }
    if (nonFiniteCount > 0) {
        throw new Error('fieldFromResolved: ' + nonFiniteCount + ' non-finite field values (singular panel evaluation)');
    }
    return { nx, ny, domain: { ...domain }, u, v, p, omega, obstacle };
}

/** Full pipeline: resolve panels, then evaluate the field. */
export function generateAnalyticFlow(
    grid: GridSpec,
    geom: GeometrySpec,
    params: AnalyticFlowParams = {}
): AnalyticFlowResult {
    const { U, Re } = resolveParams(params);
    const { body, solveMs } = resolveBody(geom, U);
    const field = fieldFromResolved(grid, geom, body, U, Re);
    if (!Number.isFinite(body.sol.cl)) {
        throw new Error("generateAnalyticFlow: non-finite cl (singular panel evaluation)");
    }
    let cpMin = Infinity;
    for (const c of body.sol.cp) {
        if (!Number.isFinite(c)) {
            throw new Error("generateAnalyticFlow: non-finite cp (singular panel evaluation)");
        }
        if (c < cpMin) cpMin = c;
    }
    if (!Number.isFinite(cpMin)) {
        throw new Error("generateAnalyticFlow: non-finite cpMin (empty or singular panel solution)");
    }
    return { field, cl: body.sol.cl, cpMin, solveMs, panelCount: body.panels.length };
}
