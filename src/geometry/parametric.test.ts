import { describe, it, expect } from "vitest";
import { naca4Airfoil, parseNaca4, transformPoints, pointInPolygon, sdfNormalized } from "./parametric";

describe("naca4Airfoil", () => {
    it("max thickness near 0.12 for 0012", () => {
        const pts = naca4Airfoil(0, 0, 0.12, 100);
        let maxT = 0;
        let xAtMax = 0;
        // Upper surface is first half; thickness approx y_upper - y_lower at same x needs pairing.
        // Simpler: max |y| over polygon times 2 approximates thickness envelope.
        for (const p of pts) {
            if (Math.abs(p.y) > maxT) {
                maxT = Math.abs(p.y);
                xAtMax = p.x;
            }
        }
        // Half thickness peak near 0.06, full near 0.12
        expect(maxT).toBeGreaterThan(0.05);
        expect(maxT).toBeLessThan(0.07);
        expect(xAtMax).toBeGreaterThan(0.2);
        expect(xAtMax).toBeLessThan(0.45);
    });

    it("camber peak y > 0 for 2412", () => {
        const { m, p, t } = parseNaca4("2412");
        const pts = naca4Airfoil(m, p, t, 100);
        const maxY = Math.max(...pts.map((q) => q.y));
        expect(maxY).toBeGreaterThan(0);
    });

    it("y-up: upper surface positive for cambered foil", () => {
        const pts = naca4Airfoil(0.02, 0.4, 0.12, 60);
        // First point is TE upper, should sit near y >= 0 for cambered foil with closed TE
        expect(pts[0].y).toBeGreaterThanOrEqual(-0.01);
    });

    it("closed trailing edge: first and last points coincide", () => {
        const pts = naca4Airfoil(0.02, 0.4, 0.12, 100);
        const first = pts[0];
        const last = pts[pts.length - 1];
        expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeLessThan(1e-9);
    });

    it("rejects invalid inputs with specific errors", () => {
        expect(() => naca4Airfoil(0.02, 0.4, 0.12, 1)).toThrow(/nPoints/);
        expect(() => naca4Airfoil(0.2, 0.4, 0.12, 10)).toThrow(/m.*\[0, 0\.095\]/);
        expect(() => naca4Airfoil(0.02, 0, 0.12, 10)).toThrow(/p.*\(0, 1\)/);
        expect(() => naca4Airfoil(0.02, 0.4, 0.5, 10)).toThrow(/t.*\(0, 0\.4\]/);
        expect(() => naca4Airfoil(0.02, 0.4, 0, 10)).toThrow(/t.*\(0, 0\.4\]/);
        expect(() => parseNaca4("9999")).toThrow(/thickness/);
        expect(() => parseNaca4("912")).toThrow(/4 digits/);
    });
});

describe("transformPoints aerodynamic alpha sign", () => {
    it("positive alpha is nose up: (1,0) at +6deg moves TE down in y-up", () => {
        const [te] = transformPoints([{ x: 1, y: 0 }], 0, 0, 1, 6);
        // Math rotation is negated, so TE drops below the chord line.
        expect(te.x).toBeCloseTo(Math.cos((6 * Math.PI) / 180), 10);
        expect(te.y).toBeCloseTo(-Math.sin((6 * Math.PI) / 180), 10);
        expect(te.y).toBeLessThan(0);
    });

    it("rejects empty polygon and non-positive scale", () => {
        expect(() => transformPoints([], 0, 0, 1, 0)).toThrow(/non-empty/);
        expect(() => transformPoints([{ x: 0, y: 0 }], 0, 0, 0, 0)).toThrow(/scale/);
        expect(() => transformPoints([{ x: 0, y: 0 }], 0, 0, -1, 0)).toThrow(/scale/);
    });
});

describe("pointInPolygon", () => {
    const square = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
    ];
    it("classifies inside and outside", () => {
        expect(pointInPolygon(0.5, 0.5, square)).toBe(true);
        expect(pointInPolygon(2, 2, square)).toBe(false);
    });

    it("rejects empty polygon", () => {
        expect(() => pointInPolygon(0, 0, [])).toThrow(/non-empty/);
    });
});

describe("sdfNormalized", () => {
    it("negative inside, positive outside, near zero on surface", () => {
        const pts = naca4Airfoil(0, 0, 0.12, 100);
        expect(sdfNormalized(0.5, 0, pts, 1)).toBeLessThan(0);
        expect(sdfNormalized(0.5, 0.5, pts, 1)).toBeGreaterThan(0);
        expect(Math.abs(sdfNormalized(0, 0, pts, 1))).toBeLessThan(0.02);
    });

    it("rejects zero chord and empty polygon", () => {
        const pts = naca4Airfoil(0, 0, 0.12, 10);
        expect(() => sdfNormalized(0, 0, pts, 0)).toThrow(/chord/);
        expect(() => sdfNormalized(0, 0, [], 1)).toThrow(/non-empty/);
    });
});
