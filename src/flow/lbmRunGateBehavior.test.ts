// LBM Run gate plus death step behavior: hard block never starts the
// worker, warnings still start it, and a pre progress failover in a fresh
// run names no stale step. Drives the real preflightLbm plus a real
// LbmClient over a fake worker port, mirroring the App run handler,
// failover latch, and fresh run reset bodies. No live calls, no threads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LbmClient, type LbmWorkerPort } from "./lbmClient";
import type { LbmMainMessage } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import { preflightLbm, withLbmTauGuidance } from "./lbmRunConfig";

type RunLevel = "info" | "warn" | "block";

interface RunEntry {
    step: number;
    message: string;
    level: RunLevel;
}

interface Progress {
    step: number;
    targetSteps: number;
    cd: number;
    cl: number;
}

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

function baseInit() {
    return {
        nx: 320,
        ny: 256,
        domain: { ...DEFAULT_DOMAIN },
        geomJson: "{}",
        re: 200,
        uLattice: 0.05,
        lesEnabled: false,
        targetSteps: 8000,
        batchSteps: 512,
    };
}

// Mirror of App appendRunLog: append only, capped at 200 rows.
function appendCapped(log: RunEntry[], entry: RunEntry): RunEntry[] {
    return [...log.slice(-199), entry];
}

// Mirror of the App onLbmRun handler body around App.tsx 990 to 1013.
// Returns the notice the UI would show, plus the updated log.
function runGate(opts: {
    spec: Parameters<typeof preflightLbm>[0];
    nx: number;
    ny: number;
    uLattice: number;
    re: number;
    progressStep: number;
    log: RunEntry[];
    client: LbmClient;
}): { notice: string | null; log: RunEntry[] } {
    const gate = preflightLbm(
        opts.spec,
        { nx: opts.nx, ny: opts.ny, domain: { ...DEFAULT_DOMAIN } },
        opts.uLattice,
        opts.re
    );
    let notice: string | null = null;
    let log = opts.log;
    if (!gate.ok) {
        const reason = gate.blockReasons.join(" ");
        notice = reason;
        log = appendCapped(log, {
            step: opts.progressStep,
            message: `Run blocked: ${reason}`,
            level: "block",
        });
        return { notice, log };
    }
    if (gate.warnings.length > 0) {
        const note = gate.warnings.join(" ");
        notice = note;
        log = appendCapped(log, { step: opts.progressStep, message: note, level: "warn" });
    }
    opts.client.run();
    return { notice, log };
}

// Mirror of the App lbmFailover latch around App.tsx 612 to 641.
function failoverLatch(state: {
    failed: string | null;
    progressRef: Progress;
    targetStepsRef: number;
    message: string;
}): { failed: string; step: number; targetSteps: number } {
    if (state.failed !== null) {
        return {
            failed: state.failed,
            step: state.progressRef.step,
            targetSteps: state.progressRef.targetSteps,
        };
    }
    const last = state.progressRef;
    const target = last.targetSteps > 0 ? last.targetSteps : state.targetStepsRef;
    const stepped = /at step \d+/.test(state.message)
        ? state.message
        : last.step > 0
            ? `${state.message} Diverged at step ${last.step} of ${target}.`
            : state.message;
    return {
        failed: withLbmTauGuidance(stepped),
        step: last.step,
        targetSteps: target,
    };
}

// Mirror of the App fresh run reset around App.tsx 643 to 652.
function freshRunReset(progressRef: Progress): Progress {
    return { step: 0, targetSteps: 0, cd: NaN, cl: NaN };
}

describe("LBM Run gate behavior", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("hard block never calls run while a notice plus one capped entry post", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.init(baseInit());
        const runsBefore = port.sent.filter((m) => m.type === "run").length;
        const out = runGate({
            spec: {
                kind: "cylinder",
                chord: 1,
                alphaDeg: 0,
                nPoints: 64,
                radius: 0.25,
                center: { x: 0.5, y: 0 },
            },
            nx: 320,
            ny: 256,
            uLattice: 0.05,
            re: 50000,
            progressStep: 0,
            log: [],
            client,
        });
        expect(out.notice).not.toBeNull();
        expect(out.notice as string).toContain("tau");
        expect(port.sent.filter((m) => m.type === "run")).toHaveLength(runsBefore);
        expect(out.log).toHaveLength(1);
        expect(out.log[0]?.level).toBe("block");
        expect(out.log[0]?.step).toBe(0);
        expect(out.log[0]?.message).toContain("Run blocked:");
        client.dispose();
    });

    it("hard block keeps the 200 row cap, dropping the oldest row", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.init(baseInit());
        const full: RunEntry[] = [];
        for (const n of Array.from({ length: 200 }, (_, i) => i)) {
            full.push({ step: n, message: `row ${n}`, level: "info" });
        }
        const out = runGate({
            spec: {
                kind: "cylinder",
                chord: 1,
                alphaDeg: 0,
                nPoints: 64,
                radius: 0.25,
                center: { x: 0.5, y: 0 },
            },
            nx: 320,
            ny: 256,
            uLattice: 0.05,
            re: 50000,
            progressStep: 42,
            log: full,
            client,
        });
        expect(port.sent.filter((m) => m.type === "run")).toHaveLength(0);
        expect(out.log).toHaveLength(200);
        expect(out.log[out.log.length - 1]?.level).toBe("block");
        expect(out.log[out.log.length - 1]?.step).toBe(42);
        expect(out.log[0]?.message).toBe("row 1");
        client.dispose();
    });

    it("warnings still call run with a warn notice plus warn log entry", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.init(baseInit());
        const out = runGate({
            spec: {
                kind: "cylinder",
                chord: 1,
                alphaDeg: 0,
                nPoints: 120,
                radius: 0.15,
                center: { x: 0.5, y: 0 },
            },
            nx: 320,
            ny: 256,
            uLattice: 0.05,
            re: 200,
            progressStep: 0,
            log: [],
            client,
        });
        expect(out.notice).not.toBeNull();
        expect(port.sent.filter((m) => m.type === "run")).toHaveLength(1);
        expect(out.log).toHaveLength(1);
        expect(out.log[0]?.level).toBe("warn");
        expect(out.log[0]?.message).toBe(out.notice as string);
        client.dispose();
    });

    it("a pre progress failover in a fresh run shows no stale step", () => {
        // Prior run diverged late, then a fresh run reset the progress ref
        // before any progress arrived, mirroring the App init effect.
        const stale: Progress = { step: 576, targetSteps: 40000, cd: 1.2, cl: 0.1 };
        void stale;
        let progressRef: Progress = { step: 576, targetSteps: 40000, cd: 1.2, cl: 0.1 };
        progressRef = freshRunReset(progressRef);
        expect(progressRef.step).toBe(0);
        const out = failoverLatch({
            failed: null,
            progressRef,
            targetStepsRef: 8000,
            message: "LBM worker error event, analytic fallback serving frames.",
        });
        expect(out.failed).toContain("analytic fallback serving frames");
        expect(out.failed).not.toContain("576");
        expect(out.failed).not.toMatch(/at step \d+/);
        expect(out.step).toBe(0);
    });

    it("failover still threads the death step once progress has landed", () => {
        const out = failoverLatch({
            failed: null,
            progressRef: { step: 576, targetSteps: 40000, cd: 1.2, cl: 0.1 },
            targetStepsRef: 40000,
            message: "LBM diverged, analytic fallback serving frames.",
        });
        expect(out.failed).toContain("Diverged at step 576 of 40000.");
        expect(out.step).toBe(576);
        expect(out.targetSteps).toBe(40000);
    });
});
