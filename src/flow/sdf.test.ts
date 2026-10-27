import { describe, it, expect } from "vitest";
import { buildSdfGrid, circleSdf, polygonSdf } from "./sdf";
import { cylinderPolygon, blockPolygon, orificePolygons } from "@/geometry/parametric";
import { DEFAULT_GRID } from "@/contracts/types";

const GRID = { nx: 32, ny: 32, domain: { ...DEFAULT_GRID.domain } };

describe("sdf", () => {
    it("sign: negative inside, positive outside", () => {
        const g = buildSdfGrid([cylinderPolygon(0.5, 0, 0.25, 64)], GRID);
        const at = (x: number, y: number): number => {
            const i = Math.round(((x - -0.5) / 2.5) * 31);
            const j = Math.round(((y - -1.0) / 2.0) * 31);
            return g.sdf[j * 32 + i];
        };
        expect(at(0.5, 0)).toBeLessThan(0);
        expect(at(-0.5, 1.0)).toBeGreaterThan(0);
        expect(g.obstacle.reduce((s, x) => s + x, 0)).toBeGreaterThan(0);
    });

    it("cylinder distance is exact", () => {
        expect(circleSdf(1.0, 0.3, 0.5, 0, 0.25)).toBeCloseTo(Math.hypot(0.5, 0.3) - 0.25, 12);
        const polys = [cylinderPolygon(0.5, 0, 0.25, 256)];
        const g = buildSdfGrid(polys, GRID, [{ x: 0.5, y: 0, r: 0.25 }]);
        for (let j = 0; j < 32; j += 4) {
            const y = -1 + (2 * j) / 31;
            for (let i = 0; i < 32; i += 4) {
                const x = -0.5 + (2.5 * i) / 31;
                expect(g.sdf[j * 32 + i]).toBeCloseTo(Math.hypot(x - 0.5, y) - 0.25, 5);
            }
        }
    });

    it("zero on the surface", () => {
        const poly = blockPolygon(0.5, 0, 0.5, 0.4, 16);
        expect(Math.abs(polygonSdf(poly[0].x, poly[0].y, poly))).toBeLessThan(1e-9);
        expect(polygonSdf(0.5, 0, poly)).toBeLessThan(0);
        expect(polygonSdf(-0.5, -1.0, poly)).toBeGreaterThan(0);
    });

    it("orifice union leaves the gap open", () => {
        const walls = orificePolygons(0.5, 0, 0.08, 0.4, 64);
        expect(walls).toHaveLength(2);
        const g = buildSdfGrid(walls, GRID);
        const at = (x: number, y: number): number => {
            const i = Math.round(((x - -0.5) / 2.5) * 31);
            const j = Math.round(((y - -1.0) / 2.0) * 31);
            return g.obstacle[j * 32 + i];
        };
        expect(at(0.5, 0)).toBe(0);
        expect(at(0.5, 0.5)).toBe(1);
        expect(at(0.5, -0.5)).toBe(1);
    });

    it("rejects non-finite points with specific errors", () => {
        expect(() => polygonSdf(0, 0, [{ x: 0, y: 0 }, { x: NaN, y: 0 }, { x: 1, y: 1 }])).toThrow(/polygon\[1\].*finite/);
        expect(() => polygonSdf(NaN, 0, [cylinderPolygon(0.5, 0, 0.25, 16)[0], cylinderPolygon(0.5, 0, 0.25, 16)[1], cylinderPolygon(0.5, 0, 0.25, 16)[2]])).toThrow(/query point.*finite/);
        expect(() => buildSdfGrid([[{ x: 0, y: 0 }, { x: 1, y: Infinity }, { x: 1, y: 1 }]], GRID)).toThrow(/polygons\[0\]\[1\].*finite/);
    });

    it("rejects bad inputs", () => {
        expect(() => buildSdfGrid([], GRID)).toThrow(/non-empty/);
        expect(() => buildSdfGrid([[{ x: 0, y: 0 }]], GRID)).toThrow(/at least 3/);
        expect(() => circleSdf(0, 0, 0, 0, 0)).toThrow(/positive/);
        expect(() => polygonSdf(0, 0, [])).toThrow(/at least 3/);
    });
});

describe("sdf allocation caps", () => {
    it("rejects too many bodies before allocation", () => {
        const polys = Array.from({ length: 9 }, () => cylinderPolygon(0.5, 0, 0.25, 8));
        expect(() => buildSdfGrid(polys, GRID)).toThrow(/bodies exceed cap/);
    });

    it("rejects excessive total points before allocation", () => {
        const ring = (cx: number): { x: number; y: number }[] =>
            Array.from({ length: 1200 }, (_, k) => {
                const a = (k / 1200) * 2 * Math.PI;
                return { x: cx + 0.1 * Math.cos(a), y: 0.1 * Math.sin(a) };
            });
        expect(() => buildSdfGrid([ring(0.5), ring(1.0)], GRID)).toThrow(/total points exceed cap/);
    });

    it("accepts a normal multi-body grid", () => {
        const walls = orificePolygons(0.5, 0, 0.08, 0.4, 64);
        const g = buildSdfGrid(walls, GRID);
        expect(g.sdf.length).toBe(GRID.nx * GRID.ny);
    });
});
