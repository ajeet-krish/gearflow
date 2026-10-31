// P2 Re/velocity visual coupling: scale monotonicity and clamps, 2x
// velocity equals 2x displacement, and the wake byte difference across Re
// proving the live-Re texture path. Display only, never physics.

import { describe, expect, it } from "vitest";
import {
    ADVECTION_SCALE_MAX,
    ADVECTION_SCALE_MIN,
    advectionScaleForRe,
    clampVelocityMult,
    combineVelocity,
} from "./advectionScale";
import { advectParticles, mulberry32 } from "./particles";
import { generateAnalyticFlow } from "@/flow/analyticFlow";
import { createFieldTextures, disposeFieldTextures } from "./fieldTexture";
import type { FlowField, GeometrySpec } from "@/contracts/types";

function uniformFlow(u0 = 1, v0 = 0): FlowField {
    const nx = 16;
    const ny = 12;
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
        u: new Float32Array(n).fill(u0),
        v: new Float32Array(n).fill(v0),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

describe("advectionScaleForRe", () => {
    it("is log monotonic and clamped to [0.6, 2.4]", () => {
        const res = [100, 1000, 50000, 1000000].map(advectionScaleForRe);
        for (let i = 1; i < res.length; i++) {
            expect(res[i]).toBeGreaterThan(res[i - 1]);
        }
        for (const r of res) {
            expect(r).toBeGreaterThanOrEqual(ADVECTION_SCALE_MIN);
            expect(r).toBeLessThanOrEqual(ADVECTION_SCALE_MAX);
        }
        expect(advectionScaleForRe(100)).toBeCloseTo(ADVECTION_SCALE_MIN, 6);
        expect(advectionScaleForRe(1000000)).toBeCloseTo(ADVECTION_SCALE_MAX, 6);
        expect(advectionScaleForRe(1)).toBe(ADVECTION_SCALE_MIN);
        expect(advectionScaleForRe(1e9)).toBe(ADVECTION_SCALE_MAX);
    });

    it("never throws on garbage input", () => {
        for (const bad of [Number.NaN, Infinity, -Infinity, -5, 0, null, undefined, "fast", {}]) {
            expect(() => advectionScaleForRe(bad)).not.toThrow();
            expect(advectionScaleForRe(bad)).toBe(1.0);
        }
    });
});

describe("combineVelocity", () => {
    it("clamps the multiplier to 0.5x-2x and multiplies", () => {
        expect(clampVelocityMult(1)).toBe(1);
        expect(clampVelocityMult(0.1)).toBe(0.5);
        expect(clampVelocityMult(9)).toBe(2);
        expect(clampVelocityMult(Number.NaN)).toBe(1);
        expect(combineVelocity(1.2, 2)).toBeCloseTo(2.4, 9);
        expect(combineVelocity(1.0, 0.5)).toBeCloseTo(0.5, 9);
    });

    it("never throws on garbage input", () => {
        for (const bad of [Number.NaN, Infinity, null, undefined, "x", {}]) {
            expect(() => combineVelocity(bad, bad)).not.toThrow();
            expect(Number.isFinite(combineVelocity(bad, bad))).toBe(true);
        }
    });

    it("2x velocity equals 2x displacement within 5 percent on a fixed field", () => {
        const flow = uniformFlow(1, 0);
        const dt = 0.016;
        const scale = advectionScaleForRe(50000);
        const mk = () => ({
            x: new Float32Array([0.2]),
            y: new Float32Array([0.3]),
            age: new Float32Array([0]),
            count: 1,
        });
        const p1 = mk();
        const p2 = mk();
        const x0 = p1.x[0];
        advectParticles(p1, flow, dt * combineVelocity(scale, 1), mulberry32(11));
        advectParticles(p2, flow, dt * combineVelocity(scale, 2), mulberry32(11));
        const d1 = p1.x[0] - x0;
        const d2 = p2.x[0] - x0;
        expect(d1).toBeGreaterThan(0);
        expect(d2 / d1).toBeCloseTo(2, 1);
        expect(Math.abs(d2 / d1 - 2) / 2).toBeLessThan(0.05);
    });
});

describe("live-Re texture path", () => {
    it("wake bytes differ across Re 100, 1k, 50k, 1M", () => {
        const geom: GeometrySpec = {
            kind: "naca4",
            naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
            chord: 1,
            alphaDeg: 6,
            nPoints: 60,
        };
        const grid = { nx: 48, ny: 48, domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 } };
        const res = [100, 1000, 50000, 1000000].map((Re) => generateAnalyticFlow(grid, geom, { Re }).field);
        for (let i = 1; i < res.length; i++) {
            let diff = 0;
            for (let k = 0; k < res[0].u.length; k++) {
                if (res[i].u[k] !== res[0].u[k]) diff++;
            }
            expect(diff).toBeGreaterThan(0);
        }
        const texes = res.map((flow) => createFieldTextures(flow));
        try {
            const base = texes[0].field.image.data as Uint8Array;
            for (let i = 1; i < texes.length; i++) {
                const cur = texes[i].field.image.data as Uint8Array;
                let byteDiff = 0;
                for (let b = 0; b < base.length; b++) {
                    if (cur[b] !== base[b]) byteDiff++;
                }
                expect(byteDiff).toBeGreaterThan(0);
            }
        } finally {
            for (const t of texes) disposeFieldTextures(t);
        }
    });
});
