// Protocol validator: well formed messages pass, malformed ones fail.

import { describe, expect, it } from "vitest";
import { isLbmMainMessage, isLbmWorkerMessage, isValidLbmStats, MAX_BATCH_STEPS, MAX_ERROR_MESSAGE_LEN, MAX_GEOM_JSON_BYTES, MAX_TARGET_STEPS } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function channels(nx: number, ny: number): Record<string, Float32Array> {
    const n = nx * ny;
    return {
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n),
        p: new Float32Array(n),
        omega: new Float32Array(n),
        obstacle: new Float32Array(n),
    };
}

function validStats(): Record<string, unknown> {
    return {
        samples: 120,
        startStep: 8000,
        step: 20000,
        recircFraction: 0.12,
        cdMean: 1.42,
        clMean: 0.31,
        clRms: 0.05,
        strouhal: 0.21,
    };
}

function fullChannels(nx: number, ny: number): Record<string, Float32Array> {
    const n = nx * ny;
    return {
        ...channels(nx, ny),
        uMean: new Float32Array(n).fill(0.5),
        vMean: new Float32Array(n),
        k: new Float32Array(n).fill(0.01),
        recirc: new Float32Array(n),
    };
}

describe("lbm protocol", () => {
    it("accepts well formed main messages", () => {
        expect(isLbmMainMessage({
            type: "init", gen: 0, nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            geomJson: "{}", re: 1000, uLattice: 0.05, lesEnabled: false,
            targetSteps: 8000, batchSteps: 512,
        })).toBe(true);
        expect(isLbmMainMessage({ type: "run", gen: 1 })).toBe(true);
        expect(isLbmMainMessage({ type: "cancel", gen: 1 })).toBe(true);
        expect(isLbmMainMessage({ type: "reset", gen: 2, re: 500 })).toBe(true);
        expect(isLbmMainMessage({ type: "snapshot", gen: 1 })).toBe(true);
        expect(isLbmMainMessage({ type: "dispose", gen: 3 })).toBe(true);
    });
    it("rejects malformed main messages", () => {
        expect(isLbmMainMessage(null)).toBe(false);
        expect(isLbmMainMessage({ type: "run" })).toBe(false);
        expect(isLbmMainMessage({ type: "init", gen: 0, nx: 1, ny: 128 })).toBe(false);
        expect(isLbmMainMessage({ type: "bogus", gen: 0 })).toBe(false);
        expect(isLbmMainMessage({ type: "reset", gen: 0, nx: 9999 })).toBe(false);
    });
    it("accepts well formed worker messages", () => {
        expect(isLbmWorkerMessage({ type: "ready", gen: 0 })).toBe(true);
        expect(isLbmWorkerMessage({ type: "progress", gen: 0, step: 512, targetSteps: 8000, cd: 1.5, cl: 0.1 })).toBe(true);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 512, cd: 1.5, cl: 0.1,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...channels(8, 8),
        })).toBe(true);
        expect(isLbmWorkerMessage({ type: "done", gen: 0, step: 8000, cd: 1.5, cl: 0.1 })).toBe(true);
        expect(isLbmWorkerMessage({ type: "cancelled", gen: 0, step: 100 })).toBe(true);
        expect(isLbmWorkerMessage({ type: "error", gen: 0, message: "boom" })).toBe(true);
    });
    it("rejects malformed worker messages", () => {
        expect(isLbmWorkerMessage(undefined)).toBe(false);
        expect(isLbmWorkerMessage({ type: "progress", gen: 0, step: -1, targetSteps: 0, cd: NaN, cl: 0 })).toBe(false);
        expect(isLbmWorkerMessage({ type: "error", gen: 0, message: "" })).toBe(false);
        expect(isLbmWorkerMessage({ type: "done", gen: -1, step: 1, cd: 1, cl: 1 })).toBe(false);
    });
    it("rejects a snapshot with a wrong channel length", () => {
        const bad = { ...channels(8, 8), u: new Float32Array(10) };
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...bad,
        })).toBe(false);
    });
    it("rejects a snapshot with a non-finite value", () => {
        const ch = channels(8, 8);
        ch.v[3] = Infinity;
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...ch,
        })).toBe(false);
        const ch2 = channels(8, 8);
        ch2.p[5] = NaN;
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...ch2,
        })).toBe(false);
    });
    it("accepts run limits at the cap and rejects cap plus one", () => {
        const base = {
            type: "init" as const, gen: 0, nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            geomJson: "{}", re: 1000, uLattice: 0.05, lesEnabled: false,
        };
        expect(isLbmMainMessage({ ...base, targetSteps: MAX_TARGET_STEPS, batchSteps: MAX_BATCH_STEPS })).toBe(true);
        expect(isLbmMainMessage({ ...base, targetSteps: MAX_TARGET_STEPS + 1, batchSteps: 1 })).toBe(false);
        expect(isLbmMainMessage({ ...base, targetSteps: 1, batchSteps: MAX_BATCH_STEPS + 1 })).toBe(false);
        expect(isLbmMainMessage({ type: "reset", gen: 1, targetSteps: MAX_TARGET_STEPS })).toBe(true);
        expect(isLbmMainMessage({ type: "reset", gen: 1, targetSteps: MAX_TARGET_STEPS + 1 })).toBe(false);
        expect(isLbmMainMessage({ type: "reset", gen: 1, batchSteps: MAX_BATCH_STEPS })).toBe(true);
        expect(isLbmMainMessage({ type: "reset", gen: 1, batchSteps: MAX_BATCH_STEPS + 1 })).toBe(false);
    });
    it("caps the geometry payload at MAX_GEOM_JSON_BYTES", () => {
        const base = {
            type: "init" as const, gen: 0, nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            re: 1000, uLattice: 0.05, lesEnabled: false, targetSteps: 8000, batchSteps: 512,
        };
        expect(isLbmMainMessage({ ...base, geomJson: "x".repeat(MAX_GEOM_JSON_BYTES) })).toBe(true);
        expect(isLbmMainMessage({ ...base, geomJson: "x".repeat(MAX_GEOM_JSON_BYTES + 1) })).toBe(false);
        expect(isLbmMainMessage({ type: "reset", gen: 1, geomJson: "x".repeat(MAX_GEOM_JSON_BYTES + 1) })).toBe(false);
    });
    it("caps snapshots at 512 per axis in addition to the cell cap", () => {
        const ch = channels(8, 8);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 512, ny: 512, domain: { ...DEFAULT_DOMAIN },
            u: new Float32Array(512 * 512), v: new Float32Array(512 * 512),
            p: new Float32Array(512 * 512), omega: new Float32Array(512 * 512),
            obstacle: new Float32Array(512 * 512),
        })).toBe(true);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 513, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...ch,
        })).toBe(false);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 513, domain: { ...DEFAULT_DOMAIN }, ...ch,
        })).toBe(false);
    });
    it("caps error messages at 1024 characters", () => {
        expect(isLbmWorkerMessage({ type: "error", gen: 0, message: "x".repeat(MAX_ERROR_MESSAGE_LEN) })).toBe(true);
        expect(isLbmWorkerMessage({ type: "error", gen: 0, message: "x".repeat(MAX_ERROR_MESSAGE_LEN + 1) })).toBe(false);
    });
    it("accepts a snapshot without the new channels and one with all of them", () => {
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 512, cd: 1.5, cl: 0.1,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...channels(8, 8),
        })).toBe(true);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 20000, cd: 1.5, cl: 0.1,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...fullChannels(8, 8), stats: validStats(),
        })).toBe(true);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 20000, cd: 1.5, cl: 0.1,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...channels(8, 8), stats: validStats(),
        })).toBe(true);
    });
    it("rejects a snapshot channel of the wrong length", () => {
        const bad = { ...fullChannels(8, 8), k: new Float32Array(10) };
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...bad, stats: validStats(),
        })).toBe(false);
    });
    it("rejects a snapshot with a non-finite new channel sample", () => {
        const bad = fullChannels(8, 8);
        bad.uMean[3] = Infinity;
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...bad, stats: validStats(),
        })).toBe(false);
        const bad2 = fullChannels(8, 8);
        bad2.k[5] = NaN;
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...bad2, stats: validStats(),
        })).toBe(false);
    });
    it("rejects a malformed stats object and accepts strouhal null", () => {
        expect(isValidLbmStats(validStats())).toBe(true);
        expect(isValidLbmStats({ ...validStats(), strouhal: null })).toBe(true);
        expect(isValidLbmStats({ ...validStats(), strouhal: NaN })).toBe(false);
        expect(isValidLbmStats({ ...validStats(), samples: -1 })).toBe(false);
        expect(isValidLbmStats({ ...validStats(), cdMean: Infinity })).toBe(false);
        const missing = validStats();
        delete missing.clRms;
        expect(isValidLbmStats(missing)).toBe(false);
        expect(isValidLbmStats({ ...validStats(), extra: 1 })).toBe(false);
        expect(isValidLbmStats("stats")).toBe(false);
        expect(isValidLbmStats(null)).toBe(false);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...channels(8, 8), stats: { ...validStats(), cdMean: NaN },
        })).toBe(false);
        expect(isLbmWorkerMessage({
            type: "snapshot", gen: 0, step: 1, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN }, ...channels(8, 8), stats: { ...validStats(), strouhal: null },
        })).toBe(true);
    });
    it("accepts an init with statsStartStep and rejects an out of range one", () => {
        const base = {
            type: "init" as const, gen: 0, nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            geomJson: "{}", re: 1000, uLattice: 0.05, lesEnabled: false,
            targetSteps: 40000, batchSteps: 512,
        };
        expect(isLbmMainMessage({ ...base })).toBe(true);
        expect(isLbmMainMessage({ ...base, statsStartStep: 8000 })).toBe(true);
        expect(isLbmMainMessage({ ...base, statsStartStep: -1 })).toBe(false);
        expect(isLbmMainMessage({ ...base, statsStartStep: MAX_TARGET_STEPS + 1 })).toBe(false);
        expect(isLbmMainMessage({ type: "reset", gen: 1, statsStartStep: 8000 })).toBe(true);
        expect(isLbmMainMessage({ type: "reset", gen: 1, statsStartStep: -1 })).toBe(false);
    });
});
