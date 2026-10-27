import { describe, it, expect } from "vitest";
import { AnalyticFlowProvider, FixtureFlowProvider } from "./frameSource";
import { generateFakeFlow } from "./fakeFlow";
import { DEFAULT_GRID } from "@/contracts/types";
import type { GeometrySpec, GridSpec } from "@/contracts/types";

const SMALL: GridSpec = { nx: 64, ny: 64, domain: { ...DEFAULT_GRID.domain } };

const NACA: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 48,
};

describe("AnalyticFlowProvider", () => {
    it("caches the same field reference", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        expect(p.label).toBe("analytic-potential");
        const a = p.getFrame();
        const b = p.getFrame();
        expect(a).toBe(b);
        expect(p.solveCount).toBe(1);
    });

    it("alpha change re-resolves panels", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        const before = p.getFrame();
        expect(p.solveCount).toBe(1);
        p.setAlpha(10);
        const after = p.getFrame();
        expect(p.solveCount).toBe(2);
        expect(after).not.toBe(before);
        let diff = 0;
        for (let k = 0; k < after.u.length; k++) {
            diff = Math.max(diff, Math.abs(after.u[k] - before.u[k]));
        }
        expect(diff).toBeGreaterThan(1e-9);
    });

    it("Re change reuses panels and only touches the wake", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA, { Re: 100 });
        const before = p.getFrame();
        expect(p.solveCount).toBe(1);
        p.setRe(2000);
        const after = p.getFrame();
        expect(p.solveCount).toBe(1);
        expect(after).not.toBe(before);
        let upstreamSame = true;
        let downstreamDiff = 0;
        const { domain } = SMALL;
        for (let j = 0; j < SMALL.ny; j++) {
            for (let i = 0; i < SMALL.nx; i++) {
                const x = domain.xMin + ((domain.xMax - domain.xMin) * i) / (SMALL.nx - 1);
                const k = j * SMALL.nx + i;
                if (before.obstacle[k] > 0.5) continue;
                if (x < 0.8) {
                    if (before.u[k] !== after.u[k] || before.v[k] !== after.v[k]) upstreamSame = false;
                } else if (x > 1.0) {
                    downstreamDiff = Math.max(downstreamDiff, Math.abs(before.u[k] - after.u[k]));
                }
            }
        }
        expect(upstreamSame).toBe(true);
        expect(downstreamDiff).toBeGreaterThan(1e-6);
    });

    it("exposes lift and panel stats", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        const res = p.getResult();
        expect(res.cl).toBeGreaterThan(0.5);
        expect(res.cpMin).toBeLessThan(-1);
        expect(res.panelCount).toBeGreaterThan(10);
    });

    it("setGeometry with an equal value does not re-solve", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        p.getFrame();
        expect(p.solveCount).toBe(1);
        p.setGeometry({ ...NACA, naca: { ...NACA.naca! } });
        p.getFrame();
        expect(p.solveCount).toBe(1);
        p.setGeometry({ ...NACA, alphaDeg: 8, naca: { ...NACA.naca! } });
        p.getFrame();
        expect(p.solveCount).toBe(2);
    });

    it("App setter sequence with unchanged geometry reuses panels on Re change", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA, { Re: 100 });
        p.getFrame();
        expect(p.solveCount).toBe(1);
        const sameSpec: GeometrySpec = {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 48,
        };
        p.setGeometry(sameSpec);
        p.setRe(2000);
        p.getFrame();
        expect(p.solveCount).toBe(1);
        p.setGeometry({ ...sameSpec, alphaDeg: 10 });
        p.setRe(3000);
        p.getFrame();
        expect(p.solveCount).toBe(2);
    });

    it("FixtureFlowProvider still returns its field", () => {
        const field = generateFakeFlow(SMALL, NACA, "frame-source-check");
        const f = new FixtureFlowProvider(field);
        expect(f.label).toBe("fixture");
        expect(f.getFrame()).toBe(field);
    });
});

describe("AnalyticFlowProvider envelope (no bypass)", () => {
    it("constructor rejects out-of-hard-envelope geometry fail-fast", () => {
        expect(() => new AnalyticFlowProvider(SMALL, { ...NACA, alphaDeg: 200 })).toThrow(/alphaDeg/);
        expect(
            () => new AnalyticFlowProvider(SMALL, { ...NACA, naca: { code: "2419", m: 0.02, p: 0.4, t: 0.19 } })
        ).toThrow(/naca\.t/);
    });

    it("setAlpha rejects out-of-hard-envelope values without mutating state", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        p.getFrame();
        const solves = p.solveCount;
        expect(() => p.setAlpha(200)).toThrow(/alphaDeg/);
        expect(() => p.setAlpha(-200)).toThrow(/alphaDeg/);
        p.getFrame();
        expect(p.solveCount).toBe(solves);
    });

    it("setGeometry rejects out-of-hard-envelope specs without mutating state", () => {
        const p = new AnalyticFlowProvider(SMALL, NACA);
        p.getFrame();
        const solves = p.solveCount;
        expect(() => p.setGeometry({ ...NACA, alphaDeg: 200 })).toThrow(/alphaDeg/);
        expect(() =>
            p.setGeometry({ ...NACA, naca: { code: "2912", m: 0.02, p: 0.9, t: 0.12 } })
        ).toThrow(/naca\.p/);
        p.getFrame();
        expect(p.solveCount).toBe(solves);
    });

    it("constructor rejects invalid grids fail-fast", () => {
        const bad = { nx: 4, ny: 4, domain: { xMin: 1, xMax: 0, yMin: -1, yMax: 1 } };
        expect(() => new AnalyticFlowProvider(bad, NACA)).toThrow();
    });
});
