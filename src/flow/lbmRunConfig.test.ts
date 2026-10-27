// Configurable LBM run state: defaults, clamps, LES selection, entry
// reset rule, and tau guidance. Uses a fake worker port, no live calls
// and no worker threads. Mirrors the lbmClient.test.ts port pattern.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LbmClient, type LbmWorkerPort } from "./lbmClient";
import { MAX_TARGET_STEPS, type LbmMainMessage } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    LBM_DEFAULT_TARGET_STEPS,
    LBM_DEFAULT_U_LATTICE,
    LBM_ENTER_NOTICE,
    LBM_ENTER_RE,
    LBM_MAX_RE,
    LBM_MAX_U_LATTICE,
    LBM_MIN_TARGET_STEPS,
    LBM_MIN_U_LATTICE,
    LBM_TAU_GUIDANCE,
    clampLbmTargetSteps,
    clampLbmULattice,
    isLbmTauFailover,
    lbmLesEnabled,
    lbmRecoveryRe,
    shouldResetReOnLbmEnter,
    withLbmTauGuidance,
} from "./lbmRunConfig";

function makePort(): LbmWorkerPort & { sent: LbmMainMessage[] } {
    const sent: LbmMainMessage[] = [];
    const port: LbmWorkerPort & { sent: LbmMainMessage[] } = {
        sent,
        postMessage: (msg) => {
            sent.push(msg);
        },
        onmessage: null,
        onerror: null,
    };
    return port;
}

describe("lbmRunConfig", () => {
    it("ships stable defaults inside the allowed ranges", () => {
        expect(LBM_DEFAULT_U_LATTICE).toBe(0.05);
        expect(LBM_MIN_U_LATTICE).toBe(0.02);
        expect(LBM_MAX_U_LATTICE).toBe(0.12);
        expect(LBM_DEFAULT_TARGET_STEPS).toBe(40000);
        expect(LBM_MIN_TARGET_STEPS).toBe(1000);
        expect(LBM_DEFAULT_TARGET_STEPS).toBeLessThanOrEqual(MAX_TARGET_STEPS);
    });

    it("clamps the lattice velocity into 0.02 to 0.12", () => {
        expect(clampLbmULattice(0.05)).toBe(0.05);
        expect(clampLbmULattice(0.001)).toBe(0.02);
        expect(clampLbmULattice(0.5)).toBe(0.12);
        expect(clampLbmULattice(Number.NaN)).toBe(LBM_DEFAULT_U_LATTICE);
    });

    it("clamps target steps into 1000 to MAX_TARGET_STEPS", () => {
        expect(clampLbmTargetSteps(40000)).toBe(40000);
        expect(clampLbmTargetSteps(10)).toBe(1000);
        expect(clampLbmTargetSteps(999999999)).toBe(MAX_TARGET_STEPS);
        expect(clampLbmTargetSteps(Number.NaN)).toBe(LBM_DEFAULT_TARGET_STEPS);
    });

    it("derives LES from Re in Auto and from the manual toggle otherwise", () => {
        expect(lbmLesEnabled(true, false, 50000)).toBe(true);
        expect(lbmLesEnabled(true, true, 100)).toBe(false);
        expect(lbmLesEnabled(false, true, 100)).toBe(true);
        expect(lbmLesEnabled(false, false, 50000)).toBe(false);
    });

    it("resets on LBM entry only above Re 2000, so Re 100 survives", () => {
        expect(shouldResetReOnLbmEnter(50000)).toBe(true);
        expect(shouldResetReOnLbmEnter(2001)).toBe(true);
        expect(shouldResetReOnLbmEnter(2000)).toBe(false);
        expect(shouldResetReOnLbmEnter(100)).toBe(false);
        expect(LBM_MAX_RE).toBe(2000);
        expect(LBM_ENTER_RE).toBe(200);
        expect(lbmRecoveryRe).toBe(200);
        expect(LBM_ENTER_NOTICE).toContain("Re set to 200");
    });

    it("appends measured guidance only to tau or floor failovers", () => {
        const tau = withLbmTauGuidance("LBM tau hit the floor, solve halted.");
        expect(tau).toContain(LBM_TAU_GUIDANCE);
        expect(tau).toContain("Re 480");
        expect(isLbmTauFailover("LBM tau hit the floor, solve halted.")).toBe(true);
        expect(isLbmTauFailover(null)).toBe(false);
        const plain = "LBM worker stalled, analytic fallback serving frames.";
        expect(withLbmTauGuidance(plain)).toBe(plain);
        expect(isLbmTauFailover(plain)).toBe(false);
        expect(withLbmTauGuidance(tau)).toBe(tau);
    });
});

describe("LbmClient run config passthrough", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("carries uLattice, targetSteps, and lesEnabled through init", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.init({
            nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            geomJson: "{}", re: 200, uLattice: 0.07, lesEnabled: true,
            targetSteps: 12000, batchSteps: 512, statsStartStep: 8000,
        });
        expect(port.sent).toHaveLength(1);
        const posted = port.sent[0] as unknown as Record<string, unknown>;
        expect(posted.type).toBe("init");
        expect(posted.uLattice).toBe(0.07);
        expect(posted.targetSteps).toBe(12000);
        expect(posted.lesEnabled).toBe(true);
        expect(posted.statsStartStep).toBe(8000);
        client.dispose();
    });
});
