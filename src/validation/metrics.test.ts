// Unit tests for pure validation metrics with known analytic values.

import { describe, it, expect } from "vitest";
import {
    alphaZero,
    bandCpMin,
    circulationCl,
    cpShoulder,
    cpStagnation,
    fitSlope,
} from "./metrics";
import type { FlowField } from "@/contracts/types";
import type { PolarRecord } from "@/contracts/types";

function polarLine(alpha: number, cl: number): PolarRecord {
    return { alpha, cl, cd: 0.01, cdp: 0.008, cm: 0, topXtr: 1, botXtr: 0.5 };
}

function uniformField(u0: number, v0: number): FlowField {
    const nx = 8;
    const ny = 6;
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 },
        u: new Float32Array(n).fill(u0),
        v: new Float32Array(n).fill(v0),
        p: new Float32Array(n).fill(0.5),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

describe("fitSlope and alphaZero", () => {
    it("recovers the 2 pi per rad slope on a synthetic polar", () => {
        const perDeg = (2 * Math.PI) / 180;
        const records = [-4, -2, 0, 2, 4, 6].map((a) => polarLine(a, perDeg * (a + 2)));
        const fit = fitSlope(records, -4, 6);
        expect(fit.slope).toBeCloseTo(perDeg, 9);
        expect(fit.n).toBe(6);
        expect(alphaZero(fit)).toBeCloseTo(-2, 9);
    });

    it("restricts the fit to [lo, hi]", () => {
        const records = [0, 2, 4, 6, 8, 10].map((a) => polarLine(a, 0.1 * a));
        const fit = fitSlope(records, 4, 8);
        expect(fit.n).toBe(3);
        expect(fit.slope).toBeCloseTo(0.1, 9);
    });

    it("throws on too few points or a flat slope", () => {
        const records = [polarLine(4, 0.4)];
        expect(() => fitSlope(records, 4, 8)).toThrow();
        expect(() => alphaZero({ slope: 0, intercept: 0.1, n: 2 })).toThrow();
    });
});

describe("cpStagnation and cpShoulder", () => {
    it("returns max and min of the panel Cp", () => {
        const cp = new Float64Array([0.2, 1.0, -0.5, -3.0, 0.1]);
        expect(cpStagnation(cp)).toBe(1.0);
        expect(cpShoulder(cp)).toBe(-3.0);
    });

    it("throws on empty or non-finite input", () => {
        expect(() => cpStagnation(new Float64Array(0))).toThrow();
        expect(() => cpShoulder(new Float64Array([Number.NaN]))).toThrow();
    });
});

describe("circulationCl", () => {
    it("is zero for uniform flow", () => {
        const cl = circulationCl(uniformField(1, 0), 1, 1);
        expect(cl).toBeCloseTo(0, 6);
    });

    it("matches solid body rotation with the Kutta-Joukowski sign", () => {
        const nx = 9;
        const ny = 9;
        const n = nx * ny;
        const u = new Float32Array(n);
        const v = new Float32Array(n);
        const omega = 0.5;
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                const x = -1 + (2 * i) / (nx - 1);
                const y = -1 + (2 * j) / (ny - 1);
                u[j * nx + i] = -omega * y;
                v[j * nx + i] = omega * x;
            }
        }
        const field: FlowField = {
            nx,
            ny,
            domain: { xMin: -1, xMax: 1, yMin: -1, yMax: 1 },
            u,
            v,
            p: new Float32Array(n),
            omega: new Float32Array(n),
            obstacle: new Float32Array(n),
        };
        const cl = circulationCl(field, 1, 1);
        expect(cl).toBeLessThan(0);
        expect(cl).toBeCloseTo(-2 * omega * 4 * 2, 0);
    });
});

describe("bandCpMin", () => {
    it("returns the minimum Cp over near-wall cells only", () => {
        const field = uniformField(1, 0);
        field.p.fill(0.5);
        field.p[10] = -2.0;
        const sdf = new Float32Array(field.nx * field.ny).fill(1.0);
        sdf[10] = 0.02;
        sdf[11] = 0.02;
        field.p[11] = -1.0;
        expect(bandCpMin(field, sdf, 1, 0.05)).toBeCloseTo(-4.0, 9);
    });

    it("throws when no fluid cells sit in the band", () => {
        const field = uniformField(1, 0);
        const sdf = new Float32Array(field.nx * field.ny).fill(5.0);
        expect(() => bandCpMin(field, sdf, 1, 0.05)).toThrow();
    });
});
