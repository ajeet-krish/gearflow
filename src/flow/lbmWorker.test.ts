// LbmWorker helpers plus dispatch sequencing with an injected fake solver.
// No real Worker or wasm is constructed; the wasm loader is bypassed by
// swapping the solver factory test hook.

import { afterEach, describe, expect, it } from "vitest";
import {
    __drainQueueForTest,
    __resetWorkerForTest,
    __setSolverFactoryForTest,
    checkGeomJsonLen,
    checkRunLimits,
    clampBatchSteps,
    copyChannel,
    handleMainMessage,
    isCompleteReset,
} from "./lbmWorker";
import { MAX_BATCH_STEPS, MAX_GEOM_JSON_BYTES, MAX_TARGET_STEPS, type LbmInitMessage } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";

function fullReset(gen = 2) {
    return {
        type: "reset" as const,
        gen,
        nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
        geomJson: "{}",
        re: 1000,
        uLattice: 0.05,
        lesEnabled: false,
        targetSteps: 8000,
        batchSteps: 512,
    };
}

describe("lbmWorker helpers", () => {
    it("rejects a re only reset", () => {
        expect(isCompleteReset({ type: "reset", gen: 2, re: 500 })).toBe(false);
        expect(isCompleteReset({ type: "reset", gen: 2, geomJson: "{}", re: 500 })).toBe(false);
    });

    it("accepts a full reset", () => {
        expect(isCompleteReset(fullReset())).toBe(true);
    });

    it("copy helper slices each channel instead of aliasing solver memory", () => {
        const src = new Float32Array([1, 2, 3, 4]);
        const out = copyChannel(src, 4, "u");
        expect(out).not.toBe(src);
        expect(Array.from(out)).toEqual([1, 2, 3, 4]);
        out[0] = 99;
        expect(src[0]).toBe(1);
        expect(out.buffer).not.toBe(src.buffer);
    });

    it("copy helper rejects a bad channel length", () => {
        expect(() => copyChannel(new Float32Array(3), 4, "v")).toThrow();
    });

    it("clamps batches and validates run limits at the caps", () => {
        expect(clampBatchSteps(512)).toBe(512);
        expect(clampBatchSteps(MAX_BATCH_STEPS)).toBe(MAX_BATCH_STEPS);
        expect(clampBatchSteps(MAX_BATCH_STEPS + 5000)).toBe(MAX_BATCH_STEPS);
        expect(checkRunLimits(MAX_TARGET_STEPS, MAX_BATCH_STEPS)).toBeNull();
        expect(checkRunLimits(MAX_TARGET_STEPS + 1, 1)).toContain("targetSteps");
        expect(checkRunLimits(1, MAX_BATCH_STEPS + 1)).toContain("batchSteps");
        expect(checkGeomJsonLen("x".repeat(MAX_GEOM_JSON_BYTES))).toBeNull();
        expect(checkGeomJsonLen("x".repeat(MAX_GEOM_JSON_BYTES + 1))).toContain("MAX_GEOM_JSON_BYTES");
    });
});

describe("lbmWorker dispatch with a fake solver", () => {
    type Posted = { msg: Record<string, unknown> };

    let posted: Posted[];
    let prevSelf: unknown;

    function installSelf(): void {
        posted = [];
        prevSelf = (globalThis as Record<string, unknown>).self;
        (globalThis as Record<string, unknown>).self = {
            postMessage: (msg: unknown) => {
                posted.push({ msg: msg as Record<string, unknown> });
            },
        };
    }

    class FakeSolver {
        step = 0;
        cancelled = false;
        resumeCalls = 0;
        configured: string[] = [];
        poisoned = false;
        configure(geomJson: string): void {
            this.configured.push(geomJson);
        }
        run_steps(n: bigint): { stepsDone: number; step: number; cd: number; cl: number; cancelled: boolean } {
            if (this.cancelled) {
                return { stepsDone: 0, step: this.step, cd: 0, cl: 0, cancelled: true };
            }
            const k = Number(n);
            this.step += k;
            return { stepsDone: k, step: this.step, cd: 0.5, cl: 0.1, cancelled: false };
        }
        cancel(): void {
            this.cancelled = true;
        }
        resume(): void {
            this.resumeCalls += 1;
            if (this.poisoned) throw new Error("lbm: diverged at step 40, reset required");
            this.cancelled = false;
        }
        reset(): void {
            this.step = 0;
            this.cancelled = false;
        }
        cd(): number {
            return 0.5;
        }
        cl(): number {
            return 0.1;
        }
        field(): { nx: number; ny: number; domain: { xMin: number; xMax: number; yMin: number; yMax: number }; u: Float32Array; v: Float32Array; p: Float32Array; omega: Float32Array; obstacle: Float32Array } {
            const n = 16;
            return {
                nx: 4, ny: 4,
                domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
                u: new Float32Array(n), v: new Float32Array(n), p: new Float32Array(n),
                omega: new Float32Array(n), obstacle: new Float32Array(n),
            };
        }
    }

    function initMsg(gen: number, geomJson: string, targetSteps = 10000, batchSteps = 64): LbmInitMessage {
        return {
            type: "init", gen, nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
            geomJson, re: 1000, uLattice: 0.05, lesEnabled: false, targetSteps, batchSteps,
        };
    }

    async function waitFor(cond: () => boolean): Promise<void> {
        const start = Date.now();
        while (!cond()) {
            if (Date.now() - start > 10000) throw new Error("timed out waiting for worker posts");
            await new Promise((r) => setTimeout(r, 5));
        }
    }

    afterEach(() => {
        __setSolverFactoryForTest(null);
        __resetWorkerForTest();
        if (prevSelf === undefined) {
            delete (globalThis as Record<string, unknown>).self;
        } else {
            (globalThis as Record<string, unknown>).self = prevSelf;
        }
    });

    it("run, cancel, run resumes and the second run advances steps", async () => {
        installSelf();
        __resetWorkerForTest();
        const fake = new FakeSolver();
        __setSolverFactoryForTest(async () => fake);
        handleMainMessage(initMsg(1, "geom-A"));
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        expect(posted.filter((p) => p.msg.type === "ready")).toHaveLength(1);
        // Start a long run, let one batch post, then cancel synchronously so
        // the cancel lands mid run deterministically.
        handleMainMessage({ type: "run", gen: 2 });
        await waitFor(() => posted.some((p) => p.msg.type === "progress" && p.msg.gen === 2));
        const cancelStep = (posted.filter((p) => p.msg.type === "progress")[posted.filter((p) => p.msg.type === "progress").length - 1]?.msg.step ?? 0) as number;
        handleMainMessage({ type: "cancel", gen: 3 });
        await waitFor(() => posted.some((p) => p.msg.type === "cancelled" && p.msg.gen === 3));
        expect(fake.cancelled).toBe(true);
        // Second run from cancelled must resume and advance past the cancel
        // point instead of returning zero steps forever.
        handleMainMessage({ type: "run", gen: 4 });
        await waitFor(() => posted.some((p) => p.msg.type === "done" && p.msg.gen === 4));
        expect(fake.resumeCalls).toBe(1);
        const dones = posted.filter((p) => p.msg.type === "done" && p.msg.gen === 4);
        const done = dones[dones.length - 1]?.msg;
        expect(done?.step as number).toBeGreaterThanOrEqual(10000);
        expect(done?.step as number).toBeGreaterThan(cancelStep);
        expect(posted.some((p) => p.msg.type === "error")).toBe(false);
    });

    it("a poisoned state refuses resume with an error, not a silent no-op", async () => {
        installSelf();
        __resetWorkerForTest();
        const fake = new FakeSolver();
        fake.poisoned = true;
        __setSolverFactoryForTest(async () => fake);
        handleMainMessage(initMsg(1, "geom-A", 10000, 64));
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        handleMainMessage({ type: "run", gen: 2 });
        await waitFor(() => posted.some((p) => p.msg.type === "progress" && p.msg.gen === 2));
        handleMainMessage({ type: "cancel", gen: 3 });
        await waitFor(() => posted.some((p) => p.msg.type === "cancelled" && p.msg.gen === 3));
        handleMainMessage({ type: "run", gen: 4 });
        await waitFor(() => posted.some((p) => p.msg.type === "error" && p.msg.gen === 4));
        const err = posted.filter((p) => p.msg.type === "error" && p.msg.gen === 4)[posted.filter((p) => p.msg.type === "error" && p.msg.gen === 4).length - 1]?.msg;
        expect(String(err?.message)).toContain("diverged");
        expect(posted.some((p) => p.msg.type === "done" && p.msg.gen === 4)).toBe(false);
    });

    it("snapshot carries the new channels and stats with copied buffers", async () => {
        installSelf();
        __resetWorkerForTest();
        const n = 16;
        const stats = {
            samples: 120, startStep: 8000, step: 20000, recircFraction: 0.1,
            cdMean: 1.4, clMean: 0.3, clRms: 0.05, strouhal: null as number | null,
        };
        const srcUMean = new Float32Array(n).fill(0.5);
        const fake = new FakeSolver();
        (fake as unknown as { field: () => unknown }).field = () => ({
            nx: 4, ny: 4,
            domain: { xMin: 0, xMax: 1, yMin: 0, yMax: 1 },
            u: new Float32Array(n), v: new Float32Array(n), p: new Float32Array(n),
            omega: new Float32Array(n), obstacle: new Float32Array(n),
            uMean: srcUMean, vMean: new Float32Array(n), k: new Float32Array(n).fill(0.01), recirc: new Float32Array(n),
            stats,
        });
        __setSolverFactoryForTest(async () => fake);
        handleMainMessage(initMsg(1, "geom-A"));
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        handleMainMessage({ type: "snapshot", gen: 1 });
        await waitFor(() => posted.some((p) => p.msg.type === "snapshot"));
        const snap = posted.filter((p) => p.msg.type === "snapshot")[0]?.msg as unknown as Record<string, unknown>;
        expect(snap.uMean).toBeInstanceOf(Float32Array);
        expect((snap.uMean as Float32Array).length).toBe(n);
        expect(snap.uMean).not.toBe(srcUMean);
        expect((snap.uMean as Float32Array).buffer).not.toBe(srcUMean.buffer);
        expect(snap.stats).toBe(stats);
        expect((snap.k as Float32Array).length).toBe(n);
    });

    it("snapshot without the new keys stays valid", async () => {
        installSelf();
        __resetWorkerForTest();
        const fake = new FakeSolver();
        __setSolverFactoryForTest(async () => fake);
        handleMainMessage(initMsg(1, "geom-A"));
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        handleMainMessage({ type: "snapshot", gen: 1 });
        await waitFor(() => posted.some((p) => p.msg.type === "snapshot"));
        const snap = posted.filter((p) => p.msg.type === "snapshot")[0]?.msg as unknown as Record<string, unknown>;
        expect(snap.u).toBeInstanceOf(Float32Array);
        expect("uMean" in snap).toBe(false);
        expect("stats" in snap).toBe(false);
    });

    it("init forwards statsStartStep to configure", async () => {
        installSelf();
        __resetWorkerForTest();
        const seen: unknown[][] = [];
        const fake = new FakeSolver();
        const orig = fake.configure.bind(fake);
        (fake as unknown as { configure: (...args: unknown[]) => void }).configure = (...args: unknown[]) => {
            seen.push(args);
            orig(args[0] as string);
        };
        __setSolverFactoryForTest(async () => fake);
        handleMainMessage({ ...initMsg(1, "geom-A"), statsStartStep: 8000 });
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        expect(seen[0]?.[4]).toBe(8000);
    });

    it("two racing inits configure only the newest and post ready once", async () => {
        installSelf();
        __resetWorkerForTest();
        const resolvers: Array<(s: FakeSolver) => void> = [];
        const fakes: FakeSolver[] = [];
        __setSolverFactoryForTest(() => new Promise((resolve) => {
            const fake = new FakeSolver();
            fakes.push(fake);
            resolvers.push(resolve);
        }));
        // Start the first init and let it reach the loading await, then
        // race a newer init in while it is still pending.
        handleMainMessage(initMsg(1, "geom-A"));
        await waitFor(() => resolvers.length === 1);
        handleMainMessage(initMsg(2, "geom-B"));
        // Resolve the stale load: it must abandon after its await, before
        // configure. The queued task then loads and configures the newest.
        resolvers[0]?.(fakes[0] as FakeSolver);
        await waitFor(() => resolvers.length === 2);
        resolvers[1]?.(fakes[1] as FakeSolver);
        await __drainQueueForTest();
        await waitFor(() => posted.some((p) => p.msg.type === "ready"));
        const readies = posted.filter((p) => p.msg.type === "ready");
        expect(readies).toHaveLength(1);
        expect(readies[0]?.msg.gen).toBe(2);
        expect(fakes[0]?.configured).toEqual([]);
        expect(fakes[1]?.configured).toEqual(["geom-B"]);
    });
});
