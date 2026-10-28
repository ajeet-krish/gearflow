// Phase reconstruction for v3 neural frames. Renders one phase of a phase
// averaged Karman street from the decoded mean plus harmonic amplitudes:
// u = meanU + uCos cos(phase) + uSin sin(phase), same for v, zero on solid
// cells. Vorticity is reconstructed only when the field carries both
// omegaCos and omegaSin; otherwise the mean vorticity passes through and
// the result is marked as a mean quantity. When harmonicValid is not true
// the buffers equal the mean field at every phase. PhaseClock advances an
// animation phase from elapsed milliseconds and a physical shedding
// frequency, caps the applied display rate at 1.25 cycles per second with a
// deterministic slow factor, and never alters the reported Strouhal.

import type { FlowField } from "@/contracts/types";

export const PHASE_DISPLAY_MAX_HZ = 1.25;
export const PHASE_TAU = Math.PI * 2;

function fail(cause: string): never {
    throw new Error(`phase-reconstruction: ${cause}`);
}

/** Output buffers of one reconstructed phase plus the vorticity flag. */
export interface PhaseBuffers {
    u: Float32Array;
    v: Float32Array;
    omega: Float32Array;
    /** True when omega carries the mean field (no omega harmonic heads). */
    omegaIsMean: boolean;
}

/** Optional caller owned scratch buffers for reconstructAtPhase. */
export interface PhaseScratch {
    u: Float32Array;
    v: Float32Array;
    omega: Float32Array;
}

function requireField(field: FlowField): number {
    if (!field || typeof field !== "object") fail("field is required");
    const n = field.nx * field.ny;
    if (!Number.isInteger(n) || n <= 0) fail("field grid must be positive");
    const chans: ReadonlyArray<{ name: string; data: ArrayLike<number> | undefined }> = [
        { name: "u", data: field.u as ArrayLike<number> },
        { name: "v", data: field.v as ArrayLike<number> },
        { name: "omega", data: field.omega as ArrayLike<number> },
        { name: "obstacle", data: field.obstacle as ArrayLike<number> },
    ];
    for (const ch of chans) {
        if (!ch.data || ch.data.length !== n) fail(`field.${ch.name} length must match nx * ny`);
    }
    return n;
}

function meanOrBase(primary: Float32Array | undefined, base: Float32Array, n: number, name: string): Float32Array {
    if (primary !== undefined && primary !== null) {
        if (primary.length !== n) fail(`field.${name} length must match nx * ny`);
        return primary;
    }
    return base;
}

/**
 * Reconstruct one phase. Writes u and v from the mean plus harmonic
 * amplitudes, zeroes solid cells, and either reconstructs omega from its
 * harmonic heads or passes the mean through with omegaIsMean true. A field
 * with harmonicValid false (or missing harmonic heads) renders the mean at
 * every phase. Returns the buffers (fresh when out is omitted).
 */
export function reconstructAtPhase(
    field: FlowField,
    phaseRadians: number,
    out?: PhaseScratch,
): PhaseBuffers {
    const n = requireField(field);
    if (!Number.isFinite(phaseRadians)) fail(`phase must be finite, got ${String(phaseRadians)}`);
    const uMean = meanOrBase(field.uMean, field.u, n, "uMean");
    const vMean = meanOrBase(field.vMean, field.v, n, "vMean");
    const oMean = field.omega;
    const valid = field.harmonicValid === true;
    const hasU = field.uCos !== undefined && field.uSin !== undefined &&
        field.uCos.length === n && field.uSin.length === n;
    const hasV = field.vCos !== undefined && field.vSin !== undefined &&
        field.vCos.length === n && field.vSin.length === n;
    const useHarm = valid && hasU && hasV;
    const hasOmega = field.omegaCos !== undefined && field.omegaSin !== undefined &&
        field.omegaCos.length === n && field.omegaSin.length === n;
    const useOmegaHarm = valid && hasOmega;
    const cosP = useHarm ? Math.cos(phaseRadians) : 0;
    const sinP = useHarm ? Math.sin(phaseRadians) : 0;
    const cosO = useOmegaHarm ? Math.cos(phaseRadians) : 0;
    const sinO = useOmegaHarm ? Math.sin(phaseRadians) : 0;
    let u: Float32Array;
    let v: Float32Array;
    let omega: Float32Array;
    if (out !== undefined && out !== null) {
        if (out.u.length !== n || out.v.length !== n || out.omega.length !== n) {
            fail("scratch buffers must match nx * ny");
        }
        u = out.u;
        v = out.v;
        omega = out.omega;
    } else {
        u = new Float32Array(n);
        v = new Float32Array(n);
        omega = new Float32Array(n);
    }
    const uCos = useHarm ? (field.uCos as Float32Array) : null;
    const uSin = useHarm ? (field.uSin as Float32Array) : null;
    const vCos = useHarm ? (field.vCos as Float32Array) : null;
    const vSin = useHarm ? (field.vSin as Float32Array) : null;
    const oCos = useOmegaHarm ? (field.omegaCos as Float32Array) : null;
    const oSin = useOmegaHarm ? (field.omegaSin as Float32Array) : null;
    for (let c = 0; c < n; c += 1) {
        if (field.obstacle[c] > 0.5) {
            u[c] = 0;
            v[c] = 0;
            omega[c] = 0;
            continue;
        }
        if (useHarm) {
            u[c] = uMean[c] +
                (uCos as Float32Array)[c] * cosP + (uSin as Float32Array)[c] * sinP;
            v[c] = vMean[c] +
                (vCos as Float32Array)[c] * cosP + (vSin as Float32Array)[c] * sinP;
        } else {
            u[c] = uMean[c];
            v[c] = vMean[c];
        }
        if (useOmegaHarm) {
            omega[c] = oMean[c] + (oCos as Float32Array)[c] * cosO + (oSin as Float32Array)[c] * sinO;
        } else {
            omega[c] = oMean[c];
        }
    }
    return { u, v, omega, omegaIsMean: !useOmegaHarm };
}

/**
 * Physical shedding frequency in cycles per second: Strouhal times
 * freestream speed over the reference length. Never capped and never
 * alters the reported Strouhal; the clock applies the display cap.
 */
export function displayFrequencyHz(strouhal: number, U: number, referenceLength: number): number {
    if (!Number.isFinite(strouhal)) fail(`strouhal must be finite, got ${String(strouhal)}`);
    if (!Number.isFinite(U) || !(U > 0)) fail(`U must be a positive finite number, got ${String(U)}`);
    if (!Number.isFinite(referenceLength) || !(referenceLength > 0)) {
        fail(`referenceLength must be a positive finite number, got ${String(referenceLength)}`);
    }
    return (strouhal * U) / referenceLength;
}

/** Deterministic slow factor for a true frequency: 1 below the display cap, true over cap above it. */
export function slowFactorForFrequency(trueHz: number): number {
    if (!Number.isFinite(trueHz) || trueHz < 0) fail(`trueHz must be a finite non-negative number, got ${String(trueHz)}`);
    if (trueHz <= PHASE_DISPLAY_MAX_HZ) return 1;
    return trueHz / PHASE_DISPLAY_MAX_HZ;
}

/** Applied display rate in cycles per second after the slow factor. */
export function cappedDisplayHz(trueHz: number): number {
    return trueHz / slowFactorForFrequency(trueHz);
}

/** One clock step: the phase plus the applied display rate and slow factor. */
export interface PhaseAdvance {
    phaseRadians: number;
    slowFactor: number;
    displayHz: number;
    trueHz: number;
    strouhal: number;
}

/**
 * Animation clock for the phase averaged street. Advance takes elapsed
 * milliseconds plus the case shedding parameters and returns the phase and
 * the applied slow factor. Pause freezes the phase (steps while paused are
 * ignored) and resume continues from the same phase, so neither introduces a
 * jump. The reported Strouhal always equals the input Strouhal.
 */
export class PhaseClock {
    private phase: number = 0;
    private pausedFlag: boolean = false;

    getPhase(): number {
        return this.phase;
    }

    isPaused(): boolean {
        return this.pausedFlag;
    }

    pause(): void {
        this.pausedFlag = true;
    }

    resume(): void {
        this.pausedFlag = false;
    }

    reset(phaseRadians: number = 0): void {
        if (!Number.isFinite(phaseRadians)) fail(`reset phase must be finite, got ${String(phaseRadians)}`);
        this.phase = ((phaseRadians % PHASE_TAU) + PHASE_TAU) % PHASE_TAU;
    }

    advance(elapsedMs: number, strouhal: number, referenceLength: number, speed: number): PhaseAdvance {
        if (!Number.isFinite(elapsedMs) || elapsedMs < 0) fail(`elapsedMs must be a finite non-negative number, got ${String(elapsedMs)}`);
        if (!Number.isFinite(strouhal)) fail(`strouhal must be finite, got ${String(strouhal)}`);
        if (!Number.isFinite(referenceLength) || !(referenceLength > 0)) {
            fail(`referenceLength must be a positive finite number, got ${String(referenceLength)}`);
        }
        if (!Number.isFinite(speed) || !(speed > 0)) fail(`speed must be a positive finite number, got ${String(speed)}`);
        const trueHz = (strouhal * speed) / referenceLength;
        const slowFactor = slowFactorForFrequency(trueHz);
        const displayHz = trueHz / slowFactor;
        if (!this.pausedFlag && elapsedMs > 0) {
            this.phase = (this.phase + PHASE_TAU * displayHz * (elapsedMs / 1000)) % PHASE_TAU;
        }
        return { phaseRadians: this.phase, slowFactor, displayHz, trueHz, strouhal };
    }
}
