// SAM mask unit tests. Pure functions, no network.

import { describe, expect, it } from "vitest";
import { bboxFallbackPolygon, maskIou, maskToPolygon } from "./samMask";

function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const mask = new Uint8Array(w * h);
    for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
            mask[y * w + x] = 1;
        }
    }
    return mask;
}

describe("maskToPolygon", () => {
    it("traces a filled rectangle into a chord normalized polygon", () => {
        const w = 64;
        const h = 32;
        const polygon = maskToPolygon(rectMask(w, h, 10, 10, 50, 22), w, h);
        expect(polygon.length).toBeGreaterThanOrEqual(3);
        expect(polygon.length).toBeLessThanOrEqual(120);
        for (const pt of polygon) {
            expect(Number.isFinite(pt.x)).toBe(true);
            expect(Number.isFinite(pt.y)).toBe(true);
            expect(pt.x).toBeGreaterThanOrEqual(-0.05);
            expect(pt.x).toBeLessThanOrEqual(1.05);
        }
    });
    it("falls back to the bbox proxy on an empty mask", () => {
        const polygon = maskToPolygon(new Uint8Array(64 * 32), 64, 32);
        expect(polygon).toHaveLength(6);
    });
    it("rejects dimension mismatches", () => {
        expect(() => maskToPolygon(new Uint8Array(10), 4, 4)).toThrow();
    });
});

describe("bboxFallbackPolygon", () => {
    it("returns a chord normalized proxy", () => {
        const polygon = bboxFallbackPolygon(256, 256);
        expect(polygon.length).toBeGreaterThanOrEqual(3);
        const xs = polygon.map((p) => p.x);
        expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.05);
        expect(Math.max(...xs)).toBeLessThanOrEqual(1.05);
    });
});

describe("maskIou", () => {
    it("scores identical masks as 1 and disjoint masks as 0", () => {
        const a = rectMask(16, 16, 2, 2, 8, 8);
        const b = Uint8Array.from(a);
        expect(maskIou(a, b)).toBe(1);
        const c = rectMask(16, 16, 10, 10, 14, 14);
        expect(maskIou(a, c)).toBe(0);
    });
    it("scores empty masks as 1", () => {
        expect(maskIou(new Uint8Array(8), new Uint8Array(8))).toBe(1);
    });
});
