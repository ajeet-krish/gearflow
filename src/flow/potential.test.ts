import { describe, it, expect } from "vitest";
import { buildPanels, solveBodies, solvePanels, panelVelocity, cylinderVelocity } from "./potential";
import { buildPolygons, blockPolygon, cylinderPolygon, ductPolygons } from "@/geometry/parametric";

const CX = 0.5;
const CY = 0;
const R = 0.25;

function cylinderSol(nPoints = 128) {
    const panels = buildPanels(cylinderPolygon(CX, CY, R, nPoints));
    return solvePanels(panels, 1);
}

describe("panel solver on cylinder", () => {
    it("recovers stagnation Cp near 1 and suction minimum near -3", () => {
        const sol = cylinderSol();
        let cpMax = -Infinity;
        let cpMin = Infinity;
        for (const c of sol.cp) {
            if (c > cpMax) cpMax = c;
            if (c < cpMin) cpMin = c;
        }
        expect(cpMax).toBeGreaterThan(0.95);
        expect(cpMax).toBeLessThanOrEqual(1);
        expect(cpMin).toBeLessThan(-2.7);
        expect(cpMin).toBeGreaterThan(-3.3);
        expect(Math.abs(sol.gamma)).toBeLessThan(1e-9);
    });

    it("far field matches freestream within 1 percent", () => {
        const fx = CX + 20 * R;
        const exact = cylinderVelocity(fx, CY, CX, CY, R, 1);
        expect(Math.abs(exact.u - 1)).toBeLessThan(0.01);
        expect(Math.abs(exact.v)).toBeLessThan(0.01);
        const sol = cylinderSol();
        const pv = panelVelocity(fx, CY, sol, 1);
        expect(Math.abs(pv.u - 1)).toBeLessThan(0.01);
        expect(Math.abs(pv.v)).toBeLessThan(0.01);
    });

    it("panel velocity matches analytic RMS below 0.05", () => {
        const sol = cylinderSol();
        let sum = 0;
        let count = 0;
        for (let j = 0; j < 48; j++) {
            const y = -1 + (2 * j) / 47;
            for (let i = 0; i < 48; i++) {
                const x = -0.5 + (2.5 * i) / 47;
                const r = Math.hypot(x - CX, y - CY);
                if (r < 2 * R) continue;
                const a = panelVelocity(x, y, sol, 1);
                const b = cylinderVelocity(x, y, CX, CY, R, 1);
                sum += (a.u - b.u) * (a.u - b.u) + (a.v - b.v) * (a.v - b.v);
                count++;
            }
        }
        expect(count).toBeGreaterThan(1000);
        expect(Math.sqrt(sum / count)).toBeLessThan(0.05);
    });

    it("lifts an airfoil at positive alpha", () => {
        const polys = buildPolygons({
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 80,
        });
        const sol = solvePanels(buildPanels(polys[0]), 1);
        expect(sol.cl).toBeGreaterThan(0.5);
        expect(sol.cl).toBeLessThan(1.6);
        let cpMin = Infinity;
        for (const c of sol.cp) if (c < cpMin) cpMin = c;
        expect(cpMin).toBeLessThan(-1);
    });

    it("cylinderVelocity is zero inside and validates inputs", () => {
        const inside = cylinderVelocity(CX, CY, CX, CY, R, 1);
        expect(inside.u).toBe(0);
        expect(inside.v).toBe(0);
        expect(() => cylinderVelocity(0, 0, 0, 0, -1, 1)).toThrow(/radius/);
        expect(() => solvePanels([], 1)).toThrow(/at least 3/);
        expect(() => buildPanels([{ x: 0, y: 0 }])).toThrow(/at least 3/);
    });
});

describe("non-lifting bodies carry gamma 0 with no Kutta row", () => {
    it("cylinder with kutta false has exactly zero gamma and near zero Cl", () => {
        const sol = solvePanels(buildPanels(cylinderPolygon(CX, CY, R, 96)), 1, 1, { kutta: false });
        expect(sol.gamma).toBe(0);
        for (const g of sol.gammas) expect(g).toBe(0);
        expect(Math.abs(sol.cl)).toBeLessThan(0.05);
    });

    it("block with kutta false has exactly zero gamma and near zero Cl", () => {
        const sol = solvePanels(buildPanels(blockPolygon(0.5, 0, 0.5, 0.5, 64)), 1, 1, { kutta: false });
        expect(sol.gamma).toBe(0);
        for (const g of sol.gammas) expect(g).toBe(0);
        expect(Math.abs(sol.cl)).toBeLessThan(0.05);
    });

    it("duct walls with no Kutta have zero per-body gammas and near zero Cl", () => {
        const walls = ductPolygons(0.5, 0, 1.0, 0.4, 64);
        const bodies = walls.map((w) => buildPanels(w));
        const sol = solveBodies(bodies, 1, 1, [false, false]);
        expect(sol.gammas).toHaveLength(2);
        expect(sol.gammas[0]).toBe(0);
        expect(sol.gammas[1]).toBe(0);
        expect(sol.gamma).toBe(0);
        expect(Math.abs(sol.cl)).toBeLessThan(0.1);
    });

    it("naca4 with Kutta keeps positive lift and nonzero gamma", () => {
        const polys = buildPolygons({
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 80,
        });
        const sol = solveBodies([buildPanels(polys[0])], 1, 1, [true]);
        expect(sol.cl).toBeGreaterThan(0.5);
        expect(Math.abs(sol.gamma)).toBeGreaterThan(1e-6);
    });
});

describe("panel allocation caps (oversize rejected before allocation)", () => {
    it("solvePanels rejects arrays over the per-body cap", () => {
        const panels = buildPanels(cylinderPolygon(CX, CY, R, 96));
        const oversize = [...panels];
        while (oversize.length <= 160) oversize.push({ ...oversize[0] });
        expect(oversize.length).toBeGreaterThan(160);
        expect(() => solvePanels(oversize, 1)).toThrow(/cap/);
    });

    it("solveBodies rejects a body over the per-body cap", () => {
        const panels = buildPanels(cylinderPolygon(CX, CY, R, 96));
        const oversize = [...panels];
        while (oversize.length <= 160) oversize.push({ ...oversize[0] });
        expect(() => solveBodies([oversize], 1)).toThrow(/per-body cap/);
    });

    it("solveBodies rejects totals over the combined cap before allocating", () => {
        const a = buildPanels(cylinderPolygon(CX, CY, R, 128));
        const b = buildPanels(blockPolygon(0.5, 0, 0.5, 0.5, 128));
        const c = buildPanels(cylinderPolygon(-0.5, 0.5, 0.2, 128));
        const total = a.length + b.length + c.length;
        expect(total).toBeGreaterThan(320);
        expect(() => solveBodies([a, b, c], 1, 1, [false, false, false])).toThrow(/total unknowns.*exceed cap/);
    });

    it("two capped bodies at the boundary still solve", () => {
        const a = buildPanels(cylinderPolygon(CX, CY, R, 128));
        const b = buildPanels(blockPolygon(2.5, 0, 0.5, 0.5, 64));
        expect(a.length + b.length).toBeLessThanOrEqual(320);
        const sol = solveBodies([a, b], 1, 1, [false, false]);
        expect(Number.isFinite(sol.cl)).toBe(true);
    });
});
