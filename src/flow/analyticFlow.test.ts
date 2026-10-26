import { describe, it, expect } from "vitest";
import { generateAnalyticFlow } from "./analyticFlow";
import { DEFAULT_GRID } from "@/contracts/types";
import type { GeometrySpec } from "@/contracts/types";

const NACA: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 60,
};

function assertFiniteField(r: ReturnType<typeof generateAnalyticFlow>): void {
    const { field } = r;
    for (let k = 0; k < field.u.length; k++) {
        expect(Number.isFinite(field.u[k])).toBe(true);
        expect(Number.isFinite(field.v[k])).toBe(true);
        expect(Number.isFinite(field.p[k])).toBe(true);
        expect(Number.isFinite(field.omega[k])).toBe(true);
    }
}

describe("analyticFlow", () => {
    it("finite field with positive lift and suction peak", () => {
        const r = generateAnalyticFlow(DEFAULT_GRID, NACA);
        assertFiniteField(r);
        expect(r.panelCount).toBeGreaterThan(10);
        expect(Number.isFinite(r.solveMs)).toBe(true);
        expect(r.cl).toBeGreaterThan(0.5);
        expect(r.cpMin).toBeLessThan(-1);
    });

    it("obstacle cells are zeroed", () => {
        const r = generateAnalyticFlow(DEFAULT_GRID, NACA);
        const { field } = r;
        let blocked = 0;
        for (let k = 0; k < field.u.length; k++) {
            if (field.obstacle[k] > 0.5) {
                blocked++;
                expect(field.u[k]).toBe(0);
                expect(field.v[k]).toBe(0);
            }
        }
        expect(blocked).toBeGreaterThan(10);
    });

    it("deterministic: same inputs give identical outputs", () => {
        const a = generateAnalyticFlow(DEFAULT_GRID, NACA);
        const b = generateAnalyticFlow(DEFAULT_GRID, NACA);
        expect(a.field.u).toEqual(b.field.u);
        expect(a.field.v).toEqual(b.field.v);
        expect(a.field.p).toEqual(b.field.p);
        expect(a.field.omega).toEqual(b.field.omega);
        expect(a.cl).toBe(b.cl);
    });

    it("Re is wake only: upstream identical, downstream differs", () => {
        const low = generateAnalyticFlow(DEFAULT_GRID, NACA, { Re: 100 });
        const high = generateAnalyticFlow(DEFAULT_GRID, NACA, { Re: 5000 });
        expect(low.cl).toBe(high.cl);
        expect(low.cpMin).toBe(high.cpMin);
        const { domain } = DEFAULT_GRID;
        let downstreamDiff = 0;
        for (let j = 0; j < DEFAULT_GRID.ny; j++) {
            const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (DEFAULT_GRID.ny - 1);
            void y;
            for (let i = 0; i < DEFAULT_GRID.nx; i++) {
                const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (DEFAULT_GRID.nx - 1);
                const k = j * DEFAULT_GRID.nx + i;
                if (low.field.obstacle[k] > 0.5) continue;
                if (x < 0.8) {
                    expect(low.field.u[k]).toBe(high.field.u[k]);
                    expect(low.field.v[k]).toBe(high.field.v[k]);
                } else if (x > 1.0) {
                    downstreamDiff = Math.max(downstreamDiff, Math.abs(low.field.u[k] - high.field.u[k]));
                }
            }
        }
        expect(downstreamDiff).toBeGreaterThan(1e-6);
    });

    it("duct shows speedup in the channel", () => {
        const duct: GeometrySpec = {
            kind: "duct",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 1.0,
            height: 0.4,
            center: { x: 0.5, y: 0 },
        };
        const r = generateAnalyticFlow(DEFAULT_GRID, duct);
        assertFiniteField(r);
        let maxU = -Infinity;
        const { domain } = DEFAULT_GRID;
        for (let j = 0; j < DEFAULT_GRID.ny; j++) {
            const y = domain.yMin + ((domain.yMax - domain.yMin) * j) / (DEFAULT_GRID.ny - 1);
            if (Math.abs(y) > 0.15) continue;
            for (let i = 0; i < DEFAULT_GRID.nx; i++) {
                const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (DEFAULT_GRID.nx - 1);
                if (x < 0 || x > 1) continue;
                const k = j * DEFAULT_GRID.nx + i;
                if (r.field.obstacle[k] > 0.5) continue;
                if (r.field.u[k] > maxU) maxU = r.field.u[k];
            }
        }
        expect(maxU).toBeGreaterThan(1.02);
    });

    it("cylinder recovers stagnation pressure and suction", () => {
        const cyl: GeometrySpec = {
            kind: "cylinder",
            chord: 1,
            alphaDeg: 0,
            nPoints: 96,
            radius: 0.25,
            center: { x: 0.5, y: 0 },
        };
        const r = generateAnalyticFlow(DEFAULT_GRID, cyl, { Re: 1000 });
        assertFiniteField(r);
        let pMax = -Infinity;
        let pMin = Infinity;
        for (let k = 0; k < r.field.u.length; k++) {
            if (r.field.obstacle[k] > 0.5) continue;
            if (r.field.p[k] > pMax) pMax = r.field.p[k];
            if (r.field.p[k] < pMin) pMin = r.field.p[k];
        }
        expect(pMax).toBeGreaterThan(0.35);
        expect(pMin).toBeLessThan(-0.8);
    });

    it("non-lifting bodies have zero gamma and near zero Cl", async () => {
        const { resolveBody } = await import("./analyticFlow");
        const cyl: GeometrySpec = {
            kind: "cylinder",
            chord: 1,
            alphaDeg: 0,
            nPoints: 96,
            radius: 0.25,
            center: { x: 0.5, y: 0 },
        };
        const cylBody = resolveBody(cyl, 1);
        for (const g of cylBody.body.sol.gammas) expect(g).toBe(0);
        expect(Math.abs(cylBody.body.sol.cl)).toBeLessThan(0.05);

        const block: GeometrySpec = {
            kind: "block",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 0.5,
            height: 0.5,
            center: { x: 0.5, y: 0 },
        };
        const blockBody = resolveBody(block, 1);
        for (const g of blockBody.body.sol.gammas) expect(g).toBe(0);
        expect(Math.abs(blockBody.body.sol.cl)).toBeLessThan(0.05);

        const duct: GeometrySpec = {
            kind: "duct",
            chord: 1,
            alphaDeg: 0,
            nPoints: 64,
            width: 1.0,
            height: 0.4,
            center: { x: 0.5, y: 0 },
        };
        const ductBody = resolveBody(duct, 1);
        expect(ductBody.body.sol.gammas).toHaveLength(2);
        for (const g of ductBody.body.sol.gammas) expect(g).toBe(0);
        expect(Math.abs(ductBody.body.sol.cl)).toBeLessThan(0.1);
        const ductFlow = generateAnalyticFlow(DEFAULT_GRID, duct);
        expect(Math.abs(ductFlow.cl)).toBeLessThan(0.1);
    });

    it("rejects bad params", () => {
        expect(() => generateAnalyticFlow(DEFAULT_GRID, NACA, { U: 0 })).toThrow(/U/);
        expect(() => generateAnalyticFlow(DEFAULT_GRID, NACA, { Re: -5 })).toThrow(/Re/);
        expect(() => generateAnalyticFlow(DEFAULT_GRID, { ...NACA, chord: 0 })).toThrow(/chord/);
    });
});
