// Phase reconstruction tests: exact phase identities, mean fallback on
// invalid harmonics, vorticity flagging, and the display clock. No network.

import { describe, expect, it } from "vitest";
import type { FlowField } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    PHASE_DISPLAY_MAX_HZ,
    PHASE_TAU,
    PhaseClock,
    cappedDisplayHz,
    displayFrequencyHz,
    reconstructAtPhase,
    slowFactorForFrequency,
} from "./phaseReconstruction";

const NX = 4;
const NY = 3;
const N = NX * NY;
const SOLID = 5;
const TOL = 1e-6;

function makeField(harmonicValid: boolean): FlowField {
    const uMean = new Float32Array(N);
    const vMean = new Float32Array(N);
    const omegaMean = new Float32Array(N);
    const uCos = new Float32Array(N);
    const uSin = new Float32Array(N);
    const vCos = new Float32Array(N);
    const vSin = new Float32Array(N);
    const obstacle = new Float32Array(N);
    for (let c = 0; c < N; c += 1) {
        uMean[c] = 1 + 0.1 * c;
        vMean[c] = 0.5 - 0.05 * c;
        omegaMean[c] = 0.1 * c;
        uCos[c] = 0.02 * (c + 1);
        uSin[c] = 0.01 * (c + 1);
        vCos[c] = -0.015 * (c + 1);
        vSin[c] = 0.03 * (c + 1);
    }
    obstacle[SOLID] = 1;
    return {
        nx: NX, ny: NY, domain: { ...DEFAULT_DOMAIN },
        u: uMean.slice(), v: vMean.slice(), p: new Float32Array(N),
        omega: omegaMean.slice(), obstacle,
        uMean, vMean, uCos, uSin, vCos, vSin,
        strouhalPredicted: 0.2, explainedPredicted: 0.8,
        harmonicValid, cappedCells: 0,
    };
}

function expectCloseArrays(got: ArrayLike<number>, want: ArrayLike<number>, tol: number): void {
    expect(got.length).toBe(want.length);
    for (let k = 0; k < got.length; k += 1) {
        expect(Math.abs((got[k] as number) - (want[k] as number))).toBeLessThan(tol);
    }
}

describe("reconstructAtPhase identities", () => {
    it("phase 0 equals mean plus cos", () => {
        const field = makeField(true);
        const out = reconstructAtPhase(field, 0);
        const wantU = new Float32Array(N);
        const wantV = new Float32Array(N);
        for (let c = 0; c < N; c += 1) {
            wantU[c] = (field.uMean as Float32Array)[c] + (field.uCos as Float32Array)[c];
            wantV[c] = (field.vMean as Float32Array)[c] + (field.vCos as Float32Array)[c];
        }
        wantU[SOLID] = 0;
        wantV[SOLID] = 0;
        expectCloseArrays(out.u, wantU, TOL);
        expectCloseArrays(out.v, wantV, TOL);
        expect(out.u[SOLID]).toBe(0);
        expect(out.v[SOLID]).toBe(0);
        expect(out.omegaIsMean).toBe(true);
    });

    it("phase pi equals mean minus cos", () => {
        const field = makeField(true);
        const out = reconstructAtPhase(field, Math.PI);
        const wantU = new Float32Array(N);
        const wantV = new Float32Array(N);
        for (let c = 0; c < N; c += 1) {
            wantU[c] = (field.uMean as Float32Array)[c] - (field.uCos as Float32Array)[c];
            wantV[c] = (field.vMean as Float32Array)[c] - (field.vCos as Float32Array)[c];
        }
        wantU[SOLID] = 0;
        wantV[SOLID] = 0;
        expectCloseArrays(out.u, wantU, TOL);
        expectCloseArrays(out.v, wantV, TOL);
    });

    it("phase pi over 2 equals mean plus sin", () => {
        const field = makeField(true);
        const out = reconstructAtPhase(field, Math.PI / 2);
        const wantU = new Float32Array(N);
        const wantV = new Float32Array(N);
        for (let c = 0; c < N; c += 1) {
            wantU[c] = (field.uMean as Float32Array)[c] + (field.uSin as Float32Array)[c];
            wantV[c] = (field.vMean as Float32Array)[c] + (field.vSin as Float32Array)[c];
        }
        wantU[SOLID] = 0;
        wantV[SOLID] = 0;
        expectCloseArrays(out.u, wantU, TOL);
        expectCloseArrays(out.v, wantV, TOL);
    });

    it("writes into caller scratch buffers when provided", () => {
        const field = makeField(true);
        const scratch = { u: new Float32Array(N), v: new Float32Array(N), omega: new Float32Array(N) };
        const out = reconstructAtPhase(field, 0, scratch);
        expect(out.u).toBe(scratch.u);
        expect(out.v).toBe(scratch.v);
        expect(out.omega).toBe(scratch.omega);
        expect(scratch.u[1]).toBeCloseTo((field.uMean as Float32Array)[1] + (field.uCos as Float32Array)[1], 6);
    });

    it("harmonicValid false returns the mean field at every phase", () => {
        const field = makeField(false);
        const phases = [0, 0.7, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 2 * Math.PI, -1.2];
        const wantU = (field.uMean as Float32Array).slice();
        const wantV = (field.vMean as Float32Array).slice();
        wantU[SOLID] = 0;
        wantV[SOLID] = 0;
        for (const phase of phases) {
            const out = reconstructAtPhase(field, phase);
            expectCloseArrays(out.u, wantU, TOL);
            expectCloseArrays(out.v, wantV, TOL);
        }
    });

    it("missing harmonic heads render the mean without throwing", () => {
        const field = makeField(true);
        const slim: FlowField = {
            nx: field.nx, ny: field.ny, domain: { ...field.domain },
            u: field.u.slice(), v: field.v.slice(), p: field.p.slice(),
            omega: field.omega.slice(), obstacle: field.obstacle.slice(),
            uMean: field.uMean?.slice(), vMean: field.vMean?.slice(),
            harmonicValid: true,
        };
        const out = reconstructAtPhase(slim, Math.PI / 2);
        const wantU = (slim.uMean as Float32Array).slice();
        wantU[SOLID] = 0;
        expectCloseArrays(out.u, wantU, TOL);
    });
});

describe("omega reconstruction flag", () => {
    it("passes the mean through and marks it when omega heads are absent", () => {
        const field = makeField(true);
        const out = reconstructAtPhase(field, Math.PI / 2);
        const want = field.omega.slice();
        want[SOLID] = 0;
        expectCloseArrays(out.omega, want, TOL);
        expect(out.omegaIsMean).toBe(true);
    });

    it("reconstructs omega only when both omega heads exist", () => {
        const field = makeField(true);
        const oCos = new Float32Array(N).fill(0.05);
        const oSin = new Float32Array(N).fill(-0.03);
        const withOmega: FlowField = { ...field, omegaCos: oCos, omegaSin: oSin };
        const atZero = reconstructAtPhase(withOmega, 0);
        expect(atZero.omegaIsMean).toBe(false);
        const want = new Float32Array(N);
        for (let c = 0; c < N; c += 1) want[c] = field.omega[c] + 0.05;
        want[SOLID] = 0;
        expectCloseArrays(atZero.omega, want, TOL);
        const atHalf = reconstructAtPhase(withOmega, Math.PI / 2);
        const wantHalf = new Float32Array(N);
        for (let c = 0; c < N; c += 1) wantHalf[c] = field.omega[c] - 0.03;
        wantHalf[SOLID] = 0;
        expectCloseArrays(atHalf.omega, wantHalf, TOL);
    });
});

describe("PhaseClock", () => {
    it("advances the phase from elapsed time and the shedding frequency", () => {
        const clock = new PhaseClock();
        const step = clock.advance(1000, 0.2, 1, 1);
        expect(step.trueHz).toBeCloseTo(0.2, 9);
        expect(step.displayHz).toBeCloseTo(0.2, 9);
        expect(step.slowFactor).toBe(1);
        expect(step.strouhal).toBe(0.2);
        expect(step.phaseRadians).toBeCloseTo(PHASE_TAU * 0.2, 9);
    });

    it("applies the slow factor above 1.25 Hz without altering Strouhal", () => {
        const clock = new PhaseClock();
        const step = clock.advance(1000, 0.2, 1, 10);
        expect(step.trueHz).toBeCloseTo(2, 9);
        expect(step.slowFactor).toBeCloseTo(2 / 1.25, 9);
        expect(step.displayHz).toBeCloseTo(1.25, 9);
        expect(step.strouhal).toBe(0.2);
        expect(step.phaseRadians).toBeCloseTo(Math.PI / 2, 9);
    });

    it("pause and resume continue without a phase jump", () => {
        const clock = new PhaseClock();
        const first = clock.advance(500, 0.2, 1, 1);
        clock.pause();
        expect(clock.isPaused()).toBe(true);
        const frozen = clock.advance(5000, 0.2, 1, 1);
        expect(frozen.phaseRadians).toBe(first.phaseRadians);
        clock.resume();
        expect(clock.isPaused()).toBe(false);
        const second = clock.advance(500, 0.2, 1, 1);
        expect(second.phaseRadians).toBeCloseTo(first.phaseRadians + PHASE_TAU * 0.2 * 0.5, 9);
    });

    it("reset rebaselines the phase", () => {
        const clock = new PhaseClock();
        clock.advance(1000, 0.2, 1, 1);
        clock.reset();
        expect(clock.getPhase()).toBe(0);
    });
});

describe("display frequency helpers", () => {
    it("displayFrequencyHz equals strouhal times U over reference length", () => {
        expect(displayFrequencyHz(0.2, 1, 1)).toBe(0.2);
        expect(displayFrequencyHz(0.18, 2, 0.5)).toBeCloseTo(0.72, 12);
    });

    it("slowFactorForFrequency is 1 at or below the cap", () => {
        expect(slowFactorForFrequency(0.2)).toBe(1);
        expect(slowFactorForFrequency(PHASE_DISPLAY_MAX_HZ)).toBe(1);
        expect(slowFactorForFrequency(2.5)).toBeCloseTo(2, 9);
        expect(cappedDisplayHz(2.5)).toBeCloseTo(PHASE_DISPLAY_MAX_HZ, 9);
    });
});
