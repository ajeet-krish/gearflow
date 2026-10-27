// Behavioral LBM mode transitions: entry reset fires once with no loop,
// a dismissed entry notice stays dismissed, parametric Re caps under LBM,
// and recover clears the failover latch so a fresh init at Re 200 can go
// live. Drives the real run config helpers plus a real LbmClient over a
// fake worker port, mirroring the App effect bodies. No worker threads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LbmClient, type LbmWorkerPort } from "./lbmClient";
import type { LbmMainMessage } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    LBM_ENTER_NOTICE,
    LBM_ENTER_RE,
    LBM_MAX_RE,
    LBM_PARAM_CAP_NOTICE,
    clampReForEngine,
    lbmEntryTransition,
    lbmRecoveryRe,
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

function baseInit(re: number) {
    return {
        nx: 160,
        ny: 128,
        domain: { ...DEFAULT_DOMAIN },
        geomJson: "{}",
        re,
        uLattice: 0.05,
        lesEnabled: false,
        targetSteps: 8000,
        batchSteps: 512,
    };
}

describe("LBM entry transition", () => {
    it("resets a high Re to 200 once on entry and never loops", () => {
        let seen: string | null = null;
        let reynolds = 50000;
        const applied: number[] = [];
        const notices: Array<string | null> = [];
        // Mirror of the App entry effect body.
        const runEntryEffect = (engineMode: string) => {
            if (engineMode !== "lbm") {
                seen = engineMode;
                notices.push(null);
                return;
            }
            const transition = lbmEntryTransition(engineMode, reynolds, seen);
            seen = "lbm";
            if (transition !== null) {
                applied.push(transition.reynolds);
                reynolds = transition.reynolds;
                notices.push(transition.notice);
            }
        };
        runEntryEffect("lbm");
        expect(applied).toEqual([LBM_ENTER_RE]);
        expect(reynolds).toBe(200);
        expect(notices).toEqual([LBM_ENTER_NOTICE]);
        // Debounced settles and unrelated renders re-run the effect.
        runEntryEffect("lbm");
        runEntryEffect("lbm");
        expect(applied).toHaveLength(1);
        expect(reynolds).toBe(200);
    });

    it("leaves a deliberate low Re alone and stays quiet on re-entry", () => {
        expect(lbmEntryTransition("lbm", 100, null)).toBeNull();
        expect(lbmEntryTransition("lbm", LBM_MAX_RE, null)).toBeNull();
        expect(lbmEntryTransition("lbm", LBM_MAX_RE + 1, null)).toEqual({
            reynolds: LBM_ENTER_RE,
            notice: LBM_ENTER_NOTICE,
        });
        expect(lbmEntryTransition("analytic", 50000, null)).toBeNull();
    });

    it("keeps a dismissed entry notice dismissed while staying in LBM", () => {
        // Entry fired, then the user dismissed the notice.
        let notice: string | null = LBM_ENTER_NOTICE;
        const seen: string | null = "lbm";
        notice = null;
        // The effect re-runs but the seen guard yields no new notice.
        const transition = lbmEntryTransition("lbm", 200, seen);
        if (transition !== null) notice = transition.notice;
        expect(notice).toBeNull();
        // Leaving LBM clears through the non lbm branch of the effect.
        expect(lbmEntryTransition("lbm", 200, "analytic")).toBeNull();
    });
});

describe("LBM parametric Re cap", () => {
    it("caps a high parametric Re to 2000 under LBM and leaves analytic alone", () => {
        expect(clampReForEngine(50000, true)).toEqual({ reynolds: LBM_MAX_RE, capped: true });
        expect(clampReForEngine(2001, true)).toEqual({ reynolds: LBM_MAX_RE, capped: true });
        expect(clampReForEngine(2000, true)).toEqual({ reynolds: 2000, capped: false });
        expect(clampReForEngine(100, true)).toEqual({ reynolds: 100, capped: false });
        expect(clampReForEngine(50000, false)).toEqual({ reynolds: 50000, capped: false });
        expect(clampReForEngine(Number.NaN, true)).toEqual({ reynolds: Number.NaN, capped: false });
        expect(LBM_PARAM_CAP_NOTICE).toContain("2000");
        expect(lbmRecoveryRe).toBe(200);
    });
});

describe("LBM failover latch and recover", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("latches a worker fault once and recover clears it for a fresh init at Re 200", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 10000 });
        let failed: string | null = null;
        let hasSnapshot = false;
        // Mirror of the App failover latch.
        const failover = (message: string) => {
            if (failed !== null) return;
            failed = withLbmTauGuidance(message);
            hasSnapshot = false;
        };
        client.onError = failover;
        client.init(baseInit(800));
        expect(port.sent).toHaveLength(1);
        // The worker port errors, the latch takes the fault.
        port.onerror?.(null);
        expect(failed).not.toBeNull();
        expect(failed).toContain("analytic fallback serving frames");
        expect(hasSnapshot).toBe(false);
        // A second fault while latched changes nothing.
        const first = failed;
        port.onerror?.(null);
        expect(failed).toBe(first);
        client.dispose();
        // Recover mirrors App: clear the latch in step with the Re change.
        failed = null;
        const reynolds = lbmRecoveryRe;
        expect(reynolds).toBe(200);
        // Fresh init at the recovery Re posts cleanly with no latch.
        const fresh = makePort();
        const live = new LbmClient(fresh, { timeoutMs: 10000 });
        live.onError = failover;
        live.init(baseInit(reynolds));
        expect(failed).toBeNull();
        expect(fresh.sent).toHaveLength(1);
        expect(fresh.sent[0]).toMatchObject({ type: "init", re: 200 });
        live.dispose();
    });
});
