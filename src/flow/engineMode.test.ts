// Engine mode parsing plus LBM square-cell grid sizing.

import { describe, expect, it } from "vitest";
import { blockageForGeometry, lbmGridFor, readEngineMode } from "./engineMode";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function cellError(nx: number, ny: number): number {
    const w = DEFAULT_DOMAIN.xMax - DEFAULT_DOMAIN.xMin;
    const h = DEFAULT_DOMAIN.yMax - DEFAULT_DOMAIN.yMin;
    const dx = w / (nx - 1);
    const dy = h / (ny - 1);
    return Math.abs(dx - dy) / ((dx + dy) / 2);
}

describe("readEngineMode", () => {
    it("selects lbm for ?engine=lbm", () => {
        expect(readEngineMode("?engine=lbm")).toBe("lbm");
    });
    it("selects wasm for ?engine=wasm", () => {
        expect(readEngineMode("?engine=wasm")).toBe("wasm");
    });
    it("keeps ?wasm=1 as a wasm alias", () => {
        expect(readEngineMode("?wasm=1")).toBe("wasm");
    });
    it("prefers an explicit engine over the wasm alias", () => {
        expect(readEngineMode("?engine=lbm&wasm=1")).toBe("lbm");
        expect(readEngineMode("?engine=analytic&wasm=1")).toBe("analytic");
    });
    it("falls back to analytic for unknown engine values", () => {
        expect(readEngineMode("?engine=bogus")).toBe("analytic");
        expect(readEngineMode("?engine=")).toBe("analytic");
    });
    it("defaults to analytic with no flags", () => {
        expect(readEngineMode("")).toBe("analytic");
        expect(readEngineMode("?foo=bar")).toBe("analytic");
    });
});

describe("lbmGridFor", () => {
    it("returns square cells for the default domain at 128 class", () => {
        const g = lbmGridFor(DEFAULT_DOMAIN, 128);
        expect(g.reason).toBeNull();
        expect(g.ny).toBe(128);
        expect(g.nx).toBe(160);
        expect(cellError(g.nx, g.ny)).toBeLessThanOrEqual(0.01);
        expect(g.nx * g.ny).toBeLessThanOrEqual(262144);
    });
    it("returns a compliant square-cell grid for a 256 request", () => {
        const g = lbmGridFor(DEFAULT_DOMAIN, 256);
        expect(g.reason).toBeNull();
        expect(cellError(g.nx, g.ny)).toBeLessThanOrEqual(0.01);
        expect(g.nx).toBeLessThanOrEqual(512);
        expect(g.ny).toBeLessThanOrEqual(512);
        expect(g.nx * g.ny).toBeLessThanOrEqual(262144);
    });
    it("rejects impossibly small or degenerate domains", () => {
        const flat = lbmGridFor({ xMin: 0, xMax: 0, yMin: 0, yMax: 1 }, 128);
        expect(flat.reason).not.toBeNull();
        const extreme = lbmGridFor({ xMin: 0, xMax: 100, yMin: 0, yMax: 0.001 }, 128);
        expect(extreme.reason).not.toBeNull();
    });
});

describe("blockageForGeometry", () => {
    it("reports 25 percent for a default cylinder on the default domain", () => {
        const out = blockageForGeometry(
            { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.25, center: { x: 0.5, y: 0 } },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeCloseTo(0.25, 12);
        expect(out.percent).toBeCloseTo(25, 12);
        expect(out.limitPercent).toBe(5);
        expect(out.warning).toBe("blockage 25.0 percent exceeds 5 percent reference limit, Cd will read high");
    });
    it("stays quiet for a small cylinder at the limit", () => {
        const out = blockageForGeometry(
            { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.05, center: { x: 0.5, y: 0 } },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeCloseTo(0.05, 12);
        expect(out.percent).toBeCloseTo(5, 12);
        expect(out.warning).toBeNull();
    });
    it("warns for an airfoil with real thickness", () => {
        const out = blockageForGeometry(
            { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeGreaterThan(0.05);
        expect(out.warning).toContain("exceeds 5 percent reference limit");
        expect(out.warning).toContain("Cd will read high");
    });
    it("uses projected height for a block at 0 and 20 degrees", () => {
        const base = { kind: "block", chord: 1, nPoints: 64, width: 1.0, height: 0.5, center: { x: 0.5, y: 0 } } as const;
        const atZero = blockageForGeometry({ ...base, alphaDeg: 0 }, DEFAULT_DOMAIN);
        expect(atZero.ratio).toBeCloseTo(0.25, 12);
        expect(atZero.percent).toBeCloseTo(25, 12);
        const alphaRad = (20 * Math.PI) / 180;
        const expected = (0.5 * Math.abs(Math.cos(alphaRad)) + 1.0 * Math.abs(Math.sin(alphaRad))) / 2;
        const atTwenty = blockageForGeometry({ ...base, alphaDeg: 20 }, DEFAULT_DOMAIN);
        expect(atTwenty.ratio).toBeCloseTo(expected, 12);
        expect(atTwenty.percent).toBeCloseTo(expected * 100, 12);
    });
    it("uses height for a duct rather than width", () => {
        const out = blockageForGeometry(
            { kind: "duct", chord: 1, alphaDeg: 0, nPoints: 64, width: 1.0, height: 0.4, center: { x: 0.5, y: 0 } },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeCloseTo(0.2, 12);
        expect(out.percent).toBeCloseTo(20, 12);
    });
    it("uses polygon y extent for custom geometry", () => {
        const out = blockageForGeometry(
            {
                kind: "custom",
                chord: 1,
                alphaDeg: 0,
                nPoints: 4,
                polygon: [
                    { x: 0, y: -0.1 },
                    { x: 1, y: -0.1 },
                    { x: 1, y: 0.2 },
                    { x: 0, y: 0.2 },
                ],
            },
            DEFAULT_DOMAIN
        );
        expect(out.ratio).toBeCloseTo(0.15, 12);
        expect(out.percent).toBeCloseTo(15, 12);
    });
});
