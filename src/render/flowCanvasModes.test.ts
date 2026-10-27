// FlowCanvas Phase 12b helpers: log normalisation for TKE and the binary
// recirculation mapping as pure exported functions. Covers all zero input,
// a constant nonzero field, NaN input, and a solid cell. The field texture
// packing test proves solid cells keep the obstacle flag so the shader and
// vertex paths dim them to the obstacle colour.

import { describe, expect, it } from "vitest";
import {
    kDisplayScaleFor,
    normalizeKDisplay,
    normalizeRecircDisplay,
} from "./FlowCanvas";
import { createFieldTextures, disposeFieldTextures } from "./fieldTexture";
import type { FlowField } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function makeFlow(n: number, k: Float32Array | undefined, obstacleAt = -1): FlowField {
    const obstacle = new Float32Array(n);
    if (obstacleAt >= 0 && obstacleAt < n) obstacle[obstacleAt] = 1;
    return {
        nx: n, ny: 1, domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle,
        ...(k === undefined ? null : { k }),
    };
}

describe("TKE log normalisation", () => {
    it("returns a null scale for a missing channel", () => {
        expect(kDisplayScaleFor(undefined)).toBeNull();
        expect(normalizeKDisplay(0.5, null)).toBe(0);
    });

    it("returns a null scale for an all zero field and maps samples to zero", () => {
        const scale = kDisplayScaleFor(new Float32Array(16));
        expect(scale).toBeNull();
        expect(normalizeKDisplay(0, scale)).toBe(0);
    });

    it("maps a constant nonzero field from floor to full scale", () => {
        const scale = kDisplayScaleFor(new Float32Array(16).fill(0.25));
        expect(scale).not.toBeNull();
        expect(normalizeKDisplay(0.25, scale)).toBeCloseTo(1, 9);
        expect(normalizeKDisplay(0, scale)).toBe(0);
        expect(normalizeKDisplay(scale!.floor, scale)).toBe(0);
    });

    it("spreads decades across the unit range", () => {
        const k = new Float32Array([1e-5, 1e-3, 1e-1]);
        const scale = kDisplayScaleFor(k);
        expect(scale).not.toBeNull();
        const lo = normalizeKDisplay(1e-5, scale);
        const mid = normalizeKDisplay(1e-3, scale);
        const hi = normalizeKDisplay(1e-1, scale);
        expect(lo).toBeGreaterThanOrEqual(0);
        expect(lo).toBeLessThan(mid);
        expect(mid).toBeLessThan(hi);
        expect(hi).toBeLessThanOrEqual(1);
    });

    it("maps NaN input to zero without throwing", () => {
        const scale = kDisplayScaleFor(new Float32Array([1e-4, 1e-2]));
        expect(normalizeKDisplay(Number.NaN, scale)).toBe(0);
        expect(normalizeKDisplay(Number.POSITIVE_INFINITY, scale)).toBe(0);
    });

    it("ignores NaN samples when building the scale", () => {
        const k = new Float32Array([Number.NaN, 1e-3, 1e-1]);
        const scale = kDisplayScaleFor(k);
        expect(scale).not.toBeNull();
        expect(normalizeKDisplay(1e-1, scale)).toBeLessThanOrEqual(1);
    });

    it("normalises a solid cell value to a finite fraction for the dim path", () => {
        const k = new Float32Array([1e-4, 1e-2, 0.5]);
        const flow = makeFlow(3, k, 2);
        const scale = kDisplayScaleFor(flow.k);
        const t = normalizeKDisplay(flow.k![2], scale);
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(1);
        expect(flow.obstacle[2]).toBe(1);
    });
});

describe("recirculation mapping", () => {
    it("maps reverse flow to 1 and attached flow to 0", () => {
        expect(normalizeRecircDisplay(1)).toBe(1);
        expect(normalizeRecircDisplay(0)).toBe(0);
        expect(normalizeRecircDisplay(0.7)).toBe(1);
        expect(normalizeRecircDisplay(0.4)).toBe(0);
    });

    it("maps NaN to attached so the shape stays honest", () => {
        expect(normalizeRecircDisplay(Number.NaN)).toBe(0);
    });

    it("normalises a solid cell mask sample without throwing", () => {
        const recirc = new Float32Array([0, 1, 1]);
        const flow = makeFlow(3, undefined, 2);
        flow.recirc = recirc;
        const t = normalizeRecircDisplay(flow.recirc[2]);
        expect(t).toBe(1);
        expect(flow.obstacle[2]).toBe(1);
    });
});

describe("field texture packing for the new modes", () => {
    it("packs TKE as a log ramp with the obstacle flag intact", () => {
        const n = 12;
        const k = new Float32Array(n);
        for (let i = 0; i < n; i++) k[i] = Math.pow(10, -4 + (3 * i) / (n - 1));
        const flow = makeFlow(n, k, 5);
        const tex = createFieldTextures(flow, "viridis", "k");
        const data = tex.field.image.data as Uint8Array;
        const b = (i: number): number => data[i * 4 + 2];
        expect(b(0)).toBe(0);
        expect(b(n - 1)).toBe(255);
        expect(b(5)).toBeGreaterThanOrEqual(0);
        expect(data[5 * 4 + 3]).toBe(255);
        disposeFieldTextures(tex);
    });

    it("packs recirculation as a binary mask with the obstacle flag intact", () => {
        const n = 8;
        const recirc = new Float32Array(n);
        for (let i = 0; i < n; i++) recirc[i] = i % 2;
        const flow = makeFlow(n, undefined, 3);
        flow.recirc = recirc;
        const tex = createFieldTextures(flow, "viridis", "recirc");
        const data = tex.field.image.data as Uint8Array;
        for (let i = 0; i < n; i++) {
            expect(data[i * 4 + 2]).toBe(i % 2 === 0 ? 0 : 255);
        }
        expect(data[3 * 4 + 3]).toBe(255);
        disposeFieldTextures(tex);
    });

    it("packs the time mean for u when mean fields are on", () => {
        const n = 8;
        const flow = makeFlow(n, undefined);
        flow.uMean = new Float32Array(n);
        for (let i = 0; i < n; i++) flow.uMean[i] = i / (n - 1);
        const mean = createFieldTextures(flow, "viridis", "u", true);
        const inst = createFieldTextures(flow, "viridis", "u", false);
        const m = mean.field.image.data as Uint8Array;
        const s = inst.field.image.data as Uint8Array;
        expect(m[0 * 4 + 2]).toBe(0);
        expect(m[(n - 1) * 4 + 2]).toBe(255);
        for (let i = 0; i < n; i++) expect(s[i * 4 + 2]).toBe(s[0 * 4 + 2]);
        disposeFieldTextures(mean);
        disposeFieldTextures(inst);
    });
});
