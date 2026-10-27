// LbmClient state machine: transitions, generation guard, snapshot
// deduplication, timeout, dispose. Uses a fake worker port, no threads.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LbmClient, type LbmWorkerPort } from "./lbmClient";
import { MAX_BATCH_STEPS, MAX_TARGET_STEPS, type LbmMainMessage } from "./lbmProtocol";
import { DEFAULT_DOMAIN } from "@/contracts/types";

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

function initConfig() {
    return {
        nx: 160, ny: 128, domain: { ...DEFAULT_DOMAIN },
        geomJson: "{}", re: 1000, uLattice: 0.05, lesEnabled: false,
        targetSteps: 8000, batchSteps: 512,
    };
}

function emit(port: LbmWorkerPort, data: unknown): void {
    port.onmessage?.({ data });
}

describe("LbmClient", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("moves idle to running to done on progress then done", () => {
        const port = makePort();
        const states: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.onStatus = (s) => states.push(s);
        client.init(initConfig());
        expect(client.status()).toBe("idle");
        client.run();
        expect(client.status()).toBe("running");
        emit(port, { type: "progress", gen: client.generation(), step: 512, targetSteps: 8000, cd: 1.5, cl: 0.1 });
        emit(port, { type: "done", gen: client.generation(), step: 8000, cd: 1.5, cl: 0.1 });
        expect(client.status()).toBe("done");
        expect(states).toContain("running");
        expect(states).toContain("done");
        client.dispose();
    });

    it("drops stale messages from a cancelled run via the generation guard", () => {
        const port = makePort();
        const seen: number[] = [];
        const client = new LbmClient(port);
        client.onProgress = (p) => seen.push(p.step);
        client.init(initConfig());
        client.run();
        const oldGen = client.generation();
        client.cancel();
        expect(client.status()).toBe("cancelled");
        emit(port, { type: "progress", gen: oldGen, step: 999, targetSteps: 8000, cd: 1, cl: 0 });
        emit(port, { type: "done", gen: oldGen, step: 8000, targetSteps: 8000, cd: 1, cl: 0 } as unknown as Record<string, unknown>);
        expect(seen).toEqual([]);
        expect(client.status()).toBe("cancelled");
        client.dispose();
    });

    it("stale cancelled echo after a fast restart does not cancel the new run", () => {
        const port = makePort();
        const states: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.onStatus = (s) => states.push(s);
        client.init(initConfig());
        client.run();
        const firstGen = client.generation();
        const runMsg = port.sent.filter((m) => m.type === "run");
        expect(runMsg).toHaveLength(1);
        expect(runMsg[0].gen).not.toBe(firstGen - 1);
        client.cancel();
        const cancelGen = client.generation();
        client.run();
        const secondGen = client.generation();
        expect(secondGen).not.toBe(cancelGen);
        expect(client.status()).toBe("running");
        // Late echo from the cancelled run carries the cancel generation.
        emit(port, { type: "cancelled", gen: cancelGen, step: 100 });
        expect(client.status()).toBe("running");
        // Watchdog is still armed for the new run: progress keeps it alive,
        // silence moves it to error rather than leaving it wedged.
        emit(port, { type: "progress", gen: secondGen, step: 512, targetSteps: 8000, cd: 1, cl: 0 });
        expect(client.status()).toBe("running");
        vi.advanceTimersByTime(10001);
        expect(client.status()).toBe("error");
        client.dispose();
    });

    it("deduplicates snapshot requests while one is in flight", () => {
        const port = makePort();
        const client = new LbmClient(port);
        client.init(initConfig());
        client.run();
        client.requestSnapshot();
        client.requestSnapshot();
        client.requestSnapshot();
        const snaps = port.sent.filter((m) => m.type === "snapshot");
        expect(snaps).toHaveLength(1);
        expect(client.hasSnapshotInFlight()).toBe(true);
        emit(port, {
            type: "snapshot", gen: client.generation(), step: 512, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN },
            u: new Float32Array(64), v: new Float32Array(64), p: new Float32Array(64),
            omega: new Float32Array(64), obstacle: new Float32Array(64),
        });
        expect(client.hasSnapshotInFlight()).toBe(false);
        client.requestSnapshot();
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(2);
        client.dispose();
    });

    it("a lost snapshot in done clears the pending flag on a timer", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 5000 });
        client.init(initConfig());
        client.run();
        emit(port, { type: "done", gen: client.generation(), step: 8000, cd: 1, cl: 0 });
        expect(client.status()).toBe("done");
        client.requestSnapshot();
        expect(client.hasSnapshotInFlight()).toBe(true);
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(1);
        // No response arrives: advance timers so the pending flag clears.
        vi.advanceTimersByTime(5001);
        expect(client.hasSnapshotInFlight()).toBe(false);
        expect(client.status()).toBe("done");
        client.requestSnapshot();
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(2);
        client.dispose();
    });

    it("surfaces a timeout error when progress stalls", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.onError = (m) => errors.push(m);
        client.init(initConfig());
        client.run();
        expect(client.status()).toBe("running");
        vi.advanceTimersByTime(10001);
        expect(client.status()).toBe("error");
        expect(errors.length).toBe(1);
        client.dispose();
    });

    it("uses the injected timeout in the watchdog message", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 7000 });
        client.onError = (m) => errors.push(m);
        client.init(initConfig());
        client.run();
        vi.advanceTimersByTime(7001);
        expect(client.status()).toBe("error");
        expect(errors[0]).toContain("7 seconds");
        expect(errors[0]).not.toContain("10 seconds");
        client.dispose();
    });

    it("fails when ready never arrives within the timeout", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 4000 });
        client.onError = (m) => errors.push(m);
        client.init(initConfig());
        expect(client.status()).toBe("idle");
        vi.advanceTimersByTime(4001);
        expect(client.status()).toBe("error");
        expect(errors[0]).toContain("no ready within");
        client.dispose();
    });

    it("a worker error event reaches error and clears the watchdog", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.onError = (m) => errors.push(m);
        client.init(initConfig());
        client.run();
        expect(client.status()).toBe("running");
        port.onerror?.({ type: "error" });
        expect(client.status()).toBe("error");
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain("worker error event");
        // Watchdog was cleared: advancing timers must not fire again.
        errors.length = 0;
        vi.advanceTimersByTime(20000);
        expect(errors).toEqual([]);
        client.dispose();
    });

    it("drops stale messages after a reset via the generation guard", () => {
        const port = makePort();
        const seen: number[] = [];
        const client = new LbmClient(port);
        client.onProgress = (p) => seen.push(p.step);
        client.init(initConfig());
        client.run();
        const oldGen = client.generation();
        client.reset();
        expect(client.status()).toBe("idle");
        emit(port, { type: "progress", gen: oldGen, step: 777, targetSteps: 8000, cd: 1, cl: 0 });
        expect(seen).toEqual([]);
        // Reset always posts a complete config, not a partial one.
        const resetMsg = port.sent.filter((m) => m.type === "reset")[0] as unknown as Record<string, unknown>;
        expect(resetMsg.nx).toBe(160);
        expect(resetMsg.geomJson).toBe("{}");
        expect(resetMsg.re).toBe(1000);
        client.dispose();
    });

    it("an error while a snapshot is pending clears the flag", () => {
        const port = makePort();
        const client = new LbmClient(port);
        client.init(initConfig());
        client.run();
        client.requestSnapshot();
        expect(client.hasSnapshotInFlight()).toBe(true);
        emit(port, { type: "error", gen: client.generation(), message: "boom" });
        expect(client.status()).toBe("error");
        expect(client.hasSnapshotInFlight()).toBe(false);
        client.dispose();
    });

    it("watchdog is cleared after done", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 5000 });
        client.onError = (m) => errors.push(m);
        client.init(initConfig());
        client.run();
        emit(port, { type: "done", gen: client.generation(), step: 8000, cd: 1, cl: 0 });
        expect(client.status()).toBe("done");
        vi.advanceTimersByTime(20000);
        expect(client.status()).toBe("done");
        expect(errors).toEqual([]);
        client.dispose();
    });

    it("reset retains the last init config and sends a complete message", () => {
        const port = makePort();
        const client = new LbmClient(port);
        client.init({ ...initConfig(), re: 2000 });
        client.reset({ re: 500 });
        const resetMsg = port.sent.filter((m) => m.type === "reset")[0] as unknown as Record<string, unknown>;
        expect(resetMsg.re).toBe(500);
        expect(resetMsg.nx).toBe(160);
        expect(resetMsg.geomJson).toBe("{}");
        expect(resetMsg.uLattice).toBe(0.05);
        expect(resetMsg.targetSteps).toBe(8000);
        client.dispose();
    });

    it("dispose latches and ignores later messages on the captured handler", () => {
        const port = makePort();
        const seen: string[] = [];
        const progressed: number[] = [];
        const client = new LbmClient(port);
        client.onStatus = (s) => seen.push(s);
        client.onProgress = (p) => progressed.push(p.step);
        client.init(initConfig());
        client.run();
        const handler = port.onmessage;
        expect(handler).not.toBeNull();
        const genAtDispose = client.generation();
        client.dispose();
        expect(client.status()).toBe("disposed");
        // Invoke the pre dispose handler directly: it must not touch state.
        handler?.({ data: { type: "progress", gen: genAtDispose, step: 999, targetSteps: 8000, cd: 1, cl: 0 } });
        handler?.({ data: { type: "done", gen: genAtDispose, step: 8000, cd: 1, cl: 0 } });
        expect(client.status()).toBe("disposed");
        expect(progressed).toEqual([]);
        // Emit with the post dispose generation: the generation guard now
        // passes, so the disposed state guard must still ignore the message.
        const genAfterDispose = client.generation();
        handler?.({ data: { type: "progress", gen: genAfterDispose, step: 999, targetSteps: 8000, cd: 1, cl: 0 } });
        handler?.({ data: { type: "done", gen: genAfterDispose, step: 8000, cd: 1, cl: 0 } });
        expect(client.status()).toBe("disposed");
        expect(progressed).toEqual([]);
        expect(seen.filter((s) => s === "done")).toEqual([]);
        const after = seen.filter((s) => s === "running" || s === "done");
        expect(after).toEqual(["running"]);
        client.run();
        expect(client.status()).toBe("disposed");
    });

    it("a non-finite snapshot clears the pending flag so the next request posts", () => {
        const port = makePort();
        const seen: number[] = [];
        const client = new LbmClient(port);
        client.onSnapshot = (s) => seen.push(s.step);
        client.init(initConfig());
        client.run();
        client.requestSnapshot();
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(1);
        expect(client.hasSnapshotInFlight()).toBe(true);
        // Wedged worker delivers NaN: validation rejects it, but the pending
        // flag must clear so the next request is actually posted.
        const bad = {
            type: "snapshot", gen: client.generation(), step: 512, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN },
            u: new Float32Array(64), v: new Float32Array(64).fill(NaN), p: new Float32Array(64),
            omega: new Float32Array(64), obstacle: new Float32Array(64),
        };
        emit(port, bad);
        expect(client.hasSnapshotInFlight()).toBe(false);
        expect(seen).toEqual([]);
        client.requestSnapshot();
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(2);
        const good = {
            type: "snapshot", gen: client.generation(), step: 512, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN },
            u: new Float32Array(64), v: new Float32Array(64), p: new Float32Array(64),
            omega: new Float32Array(64), obstacle: new Float32Array(64),
        };
        emit(port, good);
        expect(seen).toEqual([512]);
        client.dispose();
    });

    it("a lost snapshot while running clears the pending flag on a short timer", () => {
        const port = makePort();
        const client = new LbmClient(port, { timeoutMs: 30000 });
        client.init(initConfig());
        client.run();
        client.requestSnapshot();
        expect(client.hasSnapshotInFlight()).toBe(true);
        // No response arrives: advance past the snapshot timeout. Running
        // must survive (the progress watchdog is untouched).
        vi.advanceTimersByTime(3001);
        expect(client.hasSnapshotInFlight()).toBe(false);
        expect(client.status()).toBe("running");
        client.requestSnapshot();
        expect(port.sent.filter((m) => m.type === "snapshot")).toHaveLength(2);
        client.dispose();
    });

    it("run enforces the shared caps at the limit and fails past it", () => {
        const port = makePort();
        const errors: string[] = [];
        const client = new LbmClient(port, { timeoutMs: 10000 });
        client.onError = (m) => errors.push(m);
        client.init({ ...initConfig(), targetSteps: MAX_TARGET_STEPS, batchSteps: MAX_BATCH_STEPS });
        client.run();
        expect(client.status()).toBe("running");
        expect(port.sent.filter((m) => m.type === "run")).toHaveLength(1);
        client.dispose();
        const port2 = makePort();
        const client2 = new LbmClient(port2);
        client2.onError = (m) => errors.push(m);
        client2.init({ ...initConfig(), targetSteps: MAX_TARGET_STEPS + 1, batchSteps: 1 });
        client2.run();
        expect(client2.status()).toBe("error");
        expect(port2.sent.filter((m) => m.type === "run")).toHaveLength(0);
        expect(errors.some((m) => m.includes("MAX_TARGET_STEPS"))).toBe(true);
        client2.dispose();
        const port3 = makePort();
        const client3 = new LbmClient(port3);
        client3.onError = (m) => errors.push(m);
        client3.init({ ...initConfig(), targetSteps: 8000, batchSteps: MAX_BATCH_STEPS + 1 });
        client3.run();
        expect(client3.status()).toBe("error");
        expect(port3.sent.filter((m) => m.type === "run")).toHaveLength(0);
        expect(errors.some((m) => m.includes("MAX_BATCH_STEPS"))).toBe(true);
        client3.dispose();
    });

    it("passes the stats object and new channels through untouched", () => {
        const port = makePort();
        const seen: Array<{ stats: unknown; uMean: unknown; k: unknown }> = [];
        const client = new LbmClient(port);
        client.onSnapshot = (s) => seen.push({ stats: s.stats, uMean: s.uMean, k: s.k });
        client.init(initConfig());
        client.run();
        const stats = {
            samples: 120, startStep: 8000, step: 20000, recircFraction: 0.1,
            cdMean: 1.4, clMean: 0.3, clRms: 0.05, strouhal: null as number | null,
        };
        const uMean = new Float32Array(64).fill(0.5);
        const k = new Float32Array(64).fill(0.01);
        client.requestSnapshot();
        emit(port, {
            type: "snapshot", gen: client.generation(), step: 20000, cd: 1, cl: 0,
            nx: 8, ny: 8, domain: { ...DEFAULT_DOMAIN },
            u: new Float32Array(64), v: new Float32Array(64), p: new Float32Array(64),
            omega: new Float32Array(64), obstacle: new Float32Array(64),
            uMean, k, stats,
        });
        expect(seen).toHaveLength(1);
        expect(seen[0]?.stats).toBe(stats);
        expect(seen[0]?.uMean).toBe(uMean);
        expect(seen[0]?.k).toBe(k);
        client.dispose();
    });

    it("a throwing port moves init, run, cancel, snapshot, and reset to error", () => {
        const throwing = (allow: string[]) => {
            const sent: LbmMainMessage[] = [];
            const port: LbmWorkerPort & { sent: LbmMainMessage[] } = {
                sent,
                postMessage: (msg) => {
                    if (!allow.includes(msg.type)) throw new Error("port is closed");
                    sent.push(msg);
                },
                onmessage: null,
                onerror: null,
            };
            return port;
        };
        // init throws.
        {
            const port = throwing([]);
            const errors: string[] = [];
            const client = new LbmClient(port);
            client.onError = (m) => errors.push(m);
            client.init(initConfig());
            expect(client.status()).toBe("error");
            expect(errors.length).toBe(1);
            client.dispose();
        }
        // run throws.
        {
            const port = throwing(["init"]);
            const errors: string[] = [];
            const client = new LbmClient(port);
            client.onError = (m) => errors.push(m);
            client.init(initConfig());
            client.run();
            expect(client.status()).toBe("error");
            expect(errors.length).toBe(1);
            client.dispose();
        }
        // cancel throws.
        {
            const port = throwing(["init", "run"]);
            const errors: string[] = [];
            const client = new LbmClient(port);
            client.onError = (m) => errors.push(m);
            client.init(initConfig());
            client.run();
            expect(client.status()).toBe("running");
            client.cancel();
            expect(client.status()).toBe("error");
            expect(errors.length).toBe(1);
            client.dispose();
        }
        // snapshot throws.
        {
            const port = throwing(["init", "run"]);
            const errors: string[] = [];
            const client = new LbmClient(port);
            client.onError = (m) => errors.push(m);
            client.init(initConfig());
            client.run();
            client.requestSnapshot();
            expect(client.status()).toBe("error");
            expect(client.hasSnapshotInFlight()).toBe(false);
            expect(errors.length).toBe(1);
            client.dispose();
        }
        // reset throws.
        {
            const port = throwing(["init"]);
            const errors: string[] = [];
            const client = new LbmClient(port);
            client.onError = (m) => errors.push(m);
            client.init(initConfig());
            client.reset();
            expect(client.status()).toBe("error");
            expect(errors.length).toBe(1);
            client.dispose();
        }
    });
});
