// Typed protocol between the main thread LbmClient and the LBM worker.
// Both sides share these types plus a small runtime validator so a bad
// payload never reaches the solver. Snapshot channels are Float32Array so
// the worker can transfer the buffers with zero copy.

import type { Domain } from "@/contracts/types";

/** Largest accepted run length. Mirrors the solver's bounded batches. */
export const MAX_TARGET_STEPS = 2000000;
/** Largest accepted per message batch. The worker clamps to this. */
export const MAX_BATCH_STEPS = 2048;
/** Largest accepted geometry JSON payload in bytes. Mirrors
 * MAX_GEOM_JSON_BYTES in the Rust WASM surface, which checks before parse. */
export const MAX_GEOM_JSON_BYTES = 65536;
/** Largest accepted worker error message in characters. */
export const MAX_ERROR_MESSAGE_LEN = 1024;

export interface LbmInitMessage {
    type: "init";
    gen: number;
    nx: number;
    ny: number;
    domain: Domain;
    geomJson: string;
    re: number;
    uLattice: number;
    lesEnabled: boolean;
    targetSteps: number;
    batchSteps: number;
}

export interface LbmRunMessage {
    type: "run";
    gen: number;
}

export interface LbmCancelMessage {
    type: "cancel";
    gen: number;
}

export interface LbmResetMessage {
    type: "reset";
    gen: number;
    nx?: number;
    ny?: number;
    domain?: Domain;
    geomJson?: string;
    re?: number;
    uLattice?: number;
    lesEnabled?: boolean;
    targetSteps?: number;
    batchSteps?: number;
}

export interface LbmSnapshotRequestMessage {
    type: "snapshot";
    gen: number;
}

export interface LbmDisposeMessage {
    type: "dispose";
    gen: number;
}

export type LbmMainMessage =
    | LbmInitMessage
    | LbmRunMessage
    | LbmCancelMessage
    | LbmResetMessage
    | LbmSnapshotRequestMessage
    | LbmDisposeMessage;

export interface LbmReadyMessage {
    type: "ready";
    gen: number;
}

export interface LbmProgressMessage {
    type: "progress";
    gen: number;
    step: number;
    targetSteps: number;
    cd: number;
    cl: number;
}

export interface LbmSnapshotMessage {
    type: "snapshot";
    gen: number;
    step: number;
    cd: number;
    cl: number;
    nx: number;
    ny: number;
    domain: Domain;
    u: Float32Array;
    v: Float32Array;
    p: Float32Array;
    omega: Float32Array;
    obstacle: Float32Array;
}

export interface LbmDoneMessage {
    type: "done";
    gen: number;
    step: number;
    cd: number;
    cl: number;
}

export interface LbmCancelledMessage {
    type: "cancelled";
    gen: number;
    step: number;
}

export interface LbmErrorMessage {
    type: "error";
    gen: number;
    message: string;
}

export type LbmWorkerMessage =
    | LbmReadyMessage
    | LbmProgressMessage
    | LbmSnapshotMessage
    | LbmDoneMessage
    | LbmCancelledMessage
    | LbmErrorMessage;

function isFiniteNumber(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
}

function isValidTargetSteps(x: unknown): boolean {
    return Number.isInteger(x) && (x as number) > 0 && (x as number) <= MAX_TARGET_STEPS;
}

function isValidBatchSteps(x: unknown): boolean {
    return Number.isInteger(x) && (x as number) > 0 && (x as number) <= MAX_BATCH_STEPS;
}

function isValidGeomJson(x: unknown): x is string {
    return typeof x === "string" && x.length > 0 && x.length <= MAX_GEOM_JSON_BYTES;
}

function isValidDomain(d: unknown): d is Domain {
    if (typeof d !== "object" || d === null) return false;
    const r = d as Record<string, unknown>;
    for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) {
        if (!isFiniteNumber(r[k])) return false;
    }
    return (r.xMax as number) > (r.xMin as number) && (r.yMax as number) > (r.yMin as number);
}

function isValidChannel(x: unknown, n: number): x is Float32Array {
    if (!(x instanceof Float32Array)) return false;
    if (x.length !== n) return false;
    for (let i = 0; i < x.length; i++) {
        if (!Number.isFinite(x[i])) return false;
    }
    return true;
}

/** True for any well formed main to worker message. Never throws. */
export function isLbmMainMessage(msg: unknown): msg is LbmMainMessage {
    if (typeof msg !== "object" || msg === null) return false;
    const r = msg as Record<string, unknown>;
    if (!Number.isInteger(r.gen) || (r.gen as number) < 0) return false;
    switch (r.type) {
        case "init": {
            if (!Number.isInteger(r.nx) || (r.nx as number) < 4 || (r.nx as number) > 512) return false;
            if (!Number.isInteger(r.ny) || (r.ny as number) < 4 || (r.ny as number) > 512) return false;
            if (!isValidDomain(r.domain)) return false;
            if (!isValidGeomJson(r.geomJson)) return false;
            if (!isFiniteNumber(r.re) || (r.re as number) <= 0) return false;
            if (!isFiniteNumber(r.uLattice) || (r.uLattice as number) <= 0) return false;
            if (typeof r.lesEnabled !== "boolean") return false;
            if (!isValidTargetSteps(r.targetSteps)) return false;
            if (!isValidBatchSteps(r.batchSteps)) return false;
            return true;
        }
        case "run":
        case "cancel":
        case "snapshot":
        case "dispose":
            return true;
        case "reset": {
            if (r.nx !== undefined && (!Number.isInteger(r.nx) || (r.nx as number) < 4 || (r.nx as number) > 512)) return false;
            if (r.ny !== undefined && (!Number.isInteger(r.ny) || (r.ny as number) < 4 || (r.ny as number) > 512)) return false;
            if (r.domain !== undefined && !isValidDomain(r.domain)) return false;
            if (r.geomJson !== undefined && !isValidGeomJson(r.geomJson)) return false;
            if (r.re !== undefined && (!isFiniteNumber(r.re) || (r.re as number) <= 0)) return false;
            if (r.uLattice !== undefined && (!isFiniteNumber(r.uLattice) || (r.uLattice as number) <= 0)) return false;
            if (r.lesEnabled !== undefined && typeof r.lesEnabled !== "boolean") return false;
            if (r.targetSteps !== undefined && !isValidTargetSteps(r.targetSteps)) return false;
            if (r.batchSteps !== undefined && !isValidBatchSteps(r.batchSteps)) return false;
            return true;
        }
        default:
            return false;
    }
}

/** True for any well formed worker to main message. Never throws. */
export function isLbmWorkerMessage(msg: unknown): msg is LbmWorkerMessage {
    if (typeof msg !== "object" || msg === null) return false;
    const r = msg as Record<string, unknown>;
    if (!Number.isInteger(r.gen) || (r.gen as number) < 0) return false;
    switch (r.type) {
        case "ready":
            return true;
        case "progress": {
            if (!Number.isInteger(r.step) || (r.step as number) < 0) return false;
            if (!Number.isInteger(r.targetSteps) || (r.targetSteps as number) <= 0) return false;
            if (!isFiniteNumber(r.cd) || !isFiniteNumber(r.cl)) return false;
            return true;
        }
        case "snapshot": {
            if (!Number.isInteger(r.step) || (r.step as number) < 0) return false;
            if (!isFiniteNumber(r.cd) || !isFiniteNumber(r.cl)) return false;
            if (!Number.isInteger(r.nx) || (r.nx as number) < 4 || (r.nx as number) > 512) return false;
            if (!Number.isInteger(r.ny) || (r.ny as number) < 4 || (r.ny as number) > 512) return false;
            if (!isValidDomain(r.domain)) return false;
            const n = (r.nx as number) * (r.ny as number);
            if (n > 262144) return false;
            for (const k of ["u", "v", "p", "omega", "obstacle"] as const) {
                if (!isValidChannel(r[k], n)) return false;
            }
            return true;
        }
        case "done": {
            if (!Number.isInteger(r.step) || (r.step as number) < 0) return false;
            if (!isFiniteNumber(r.cd) || !isFiniteNumber(r.cl)) return false;
            return true;
        }
        case "cancelled": {
            if (!Number.isInteger(r.step) || (r.step as number) < 0) return false;
            return true;
        }
        case "error": {
            if (typeof r.message !== "string" || (r.message as string).length === 0) return false;
            if ((r.message as string).length > MAX_ERROR_MESSAGE_LEN) return false;
            return true;
        }
        default:
            return false;
    }
}
