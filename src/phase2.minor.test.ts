// Phase 2 Minor behavioral pins: stale neural commit plus App executor narrowing.
// Deferred predictors resolve out of order against the real tracker and the
// real adapter with zero network. Older requests resolving after newer ones
// never commit. Executor narrowing accepts analytic and lbm at App level and
// rejects wasm and surrogate with the pointer copy intact.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowField, GeometrySpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    NeuralV2Adapter,
    neuralRequestKey,
    isUsableNeuralField,
    createNeuralRequestTracker,
} from "@/flow/neuralV2Adapter";
import {
    ENGINE_TOKENS,
    parseAgentEnvelope,
    validateAgentAction,
} from "@/agent/agentActions";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "App.tsx");

const SPEC_A: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 24,
};

const SPEC_B: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 8,
    nPoints: 24,
};

function uniformField(p0: number, nx = 8, ny = 8): FlowField {
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n).fill(0),
        p: new Float32Array(n).fill(p0),
        omega: new Float32Array(n).fill(0),
        obstacle: new Float32Array(n).fill(0),
    };
}

function deferred<T>(): {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
} {
    let settleResolve: (value: T) => void = () => {};
    let settleReject: (reason: unknown) => void = () => {};
    const promise = new Promise<T>((res, rej) => {
        settleResolve = res;
        settleReject = rej;
    });
    return { promise, resolve: settleResolve, reject: settleReject };
}

function fence(payload: unknown): string {
    return `minor probe\n\`\`\`action-json\n${JSON.stringify(payload)}\n\`\`\``;
}

// Faithful copy of the App neural commit guard: latest tracker id plus
// current request key plus usable field gate. Returns true on commit.
function tryAppCommit(
    tracker: ReturnType<typeof createNeuralRequestTracker>,
    committed: { current: unknown },
    res: { key: string; flow: FlowField; cl: number; cpMin: number },
    requestId: number,
    currentKey: string,
): boolean {
    if (!tracker.isLatest(requestId)) return false;
    if (res.key !== currentKey) return false;
    if (!isUsableNeuralField(res.flow, res.cl, res.cpMin)) return false;
    committed.current = res;
    return true;
}

// Faithful copy of the App executor set_engine branch: analytic maps off,
// lbm maps on, every other token stays rejected with no state change.
function applySetEngineAppLevel(
    engine: string,
    hooks: { toAnalytic: () => void; toLbm: () => void },
): string {
    if (engine === "analytic") {
        hooks.toAnalytic();
        return "applied analytic";
    }
    if (engine === "lbm") {
        hooks.toLbm();
        return "applied lbm";
    }
    return "rejected";
}

describe("stale neural commit with deferred out of order resolution", () => {
    it("older resolving after newer never overwrites the newer commit", async () => {
        const fieldA = uniformField(0.5);
        const fieldB = uniformField(1.5);
        const gateA = deferred<FlowField>();
        const gateB = deferred<FlowField>();
        let calls = 0;
        const predictor = {
            get loaded() {
                return true;
            },
            load: async () => {},
            predictFrame: async () => {
                calls += 1;
                if (calls === 1) return gateA.promise;
                return gateB.promise;
            },
            setGeometry: (_g: GeometrySpec) => {},
            setRe: (_r: number) => {},
        };
        const adapter = new NeuralV2Adapter(predictor);
        const tracker = createNeuralRequestTracker();
        const committed: { current: unknown } = { current: null };

        const requestA = tracker.next();
        const pendingA = adapter.predictFor(SPEC_A, 50000);
        const requestB = tracker.next();
        const pendingB = adapter.predictFor(SPEC_B, 50000);

        expect(tracker.isLatest(requestA)).toBe(false);
        expect(tracker.isLatest(requestB)).toBe(true);

        gateB.resolve(fieldB);
        const resB = await pendingB;
        expect(resB.key).toBe(neuralRequestKey(SPEC_B, 50000));
        const currentKey = neuralRequestKey(SPEC_B, 50000);
        expect(tryAppCommit(tracker, committed, resB, requestB, currentKey)).toBe(true);
        expect(committed.current).toBe(resB);

        gateA.resolve(fieldA);
        const resA = await pendingA;
        expect(resA.key).toBe(neuralRequestKey(SPEC_A, 50000));
        expect(tryAppCommit(tracker, committed, resA, requestA, currentKey)).toBe(false);
        expect(committed.current).toBe(resB);
        expect(calls).toBe(2);
    });

    it("stale resolving first never commits while the newer session stays pending", async () => {
        const fieldA = uniformField(0.5);
        const fieldB = uniformField(1.5);
        const gateA = deferred<FlowField>();
        const gateB = deferred<FlowField>();
        let calls = 0;
        const predictor = {
            get loaded() {
                return true;
            },
            load: async () => {},
            predictFrame: async () => {
                calls += 1;
                if (calls === 1) return gateA.promise;
                return gateB.promise;
            },
            setGeometry: (_g: GeometrySpec) => {},
            setRe: (_r: number) => {},
        };
        const adapter = new NeuralV2Adapter(predictor);
        const tracker = createNeuralRequestTracker();
        const committed: { current: unknown } = { current: null };

        const requestA = tracker.next();
        const pendingA = adapter.predictFor(SPEC_A, 50000);
        const requestB = tracker.next();
        const pendingB = adapter.predictFor(SPEC_B, 50000);
        const currentKey = neuralRequestKey(SPEC_B, 50000);

        gateA.resolve(fieldA);
        const resA = await pendingA;
        expect(tryAppCommit(tracker, committed, resA, requestA, currentKey)).toBe(false);
        expect(committed.current).toBe(null);

        gateB.resolve(fieldB);
        const resB = await pendingB;
        expect(tryAppCommit(tracker, committed, resB, requestB, currentKey)).toBe(true);
        expect(committed.current).toBe(resB);
    });

    it("key mismatch drops the older frame even when the payload itself is usable", async () => {
        const fieldA = uniformField(0.5);
        const predictor = {
            get loaded() {
                return true;
            },
            load: async () => {},
            predictFrame: async () => fieldA,
            setGeometry: (_g: GeometrySpec) => {},
            setRe: (_r: number) => {},
        };
        const adapter = new NeuralV2Adapter(predictor);
        const tracker = createNeuralRequestTracker();
        const committed: { current: unknown } = { current: null };

        const requestA = tracker.next();
        tracker.next();
        const resA = await adapter.predictFor(SPEC_A, 50000);
        expect(isUsableNeuralField(resA.flow, resA.cl, resA.cpMin)).toBe(true);
        const currentKey = neuralRequestKey(SPEC_B, 50000);
        expect(resA.key).not.toBe(currentKey);
        expect(tryAppCommit(tracker, committed, resA, requestA, currentKey)).toBe(false);
        expect(committed.current).toBe(null);
    });
});

describe("App executor set_engine narrowing across all four tokens", () => {
    it("envelope validator accepts all four engine tokens", () => {
        const live = { lbmEffective: true, statsReady: true, hasTke: true, hasRecirc: true };
        for (const token of ["analytic", "lbm", "wasm", "surrogate"]) {
            const checked = validateAgentAction({ kind: "set_engine", engine: token }, live);
            expect(checked.ok).toBe(true);
            expect(checked.action).toEqual({ kind: "set_engine", engine: token });
            const parsed = parseAgentEnvelope(fence({ kind: "set_engine", engine: token }), live);
            expect(parsed.actions).toEqual([{ kind: "set_engine", engine: token }]);
            expect(parsed.rejections).toEqual([]);
        }
        expect(ENGINE_TOKENS).toEqual(["analytic", "wasm", "lbm", "surrogate"]);
    });

    it("App level executor applies analytic and lbm and rejects wasm plus surrogate", () => {
        for (const token of ["analytic", "lbm", "wasm", "surrogate"]) {
            let analyticCalls = 0;
            let lbmCalls = 0;
            const hooks = {
                toAnalytic: () => {
                    analyticCalls += 1;
                },
                toLbm: () => {
                    lbmCalls += 1;
                },
            };
            const outcome = applySetEngineAppLevel(token, hooks);
            if (token === "analytic") {
                expect(outcome).toContain("applied");
                expect(analyticCalls).toBe(1);
                expect(lbmCalls).toBe(0);
            } else if (token === "lbm") {
                expect(outcome).toContain("applied");
                expect(analyticCalls).toBe(0);
                expect(lbmCalls).toBe(1);
            } else {
                expect(outcome).toContain("rejected");
                expect(analyticCalls).toBe(0);
                expect(lbmCalls).toBe(0);
            }
        }
    });

    it("App source keeps the narrowing branch with the ENGINE_TOKENS pointer copy", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("Narrowed: set_engine accepts analytic or lbm only");
        expect(src).toContain("ENGINE_TOKENS");
        expect(src).toContain('if (action.engine === "analytic")');
        expect(src).toContain("setLbmArmedAndMirror(false)");
        expect(src).toContain("setLbmArmedAndMirror(true)");
        expect(src).not.toContain('setMode("surrogate")');
        expect(src).not.toContain("wasm-rust live");
    });
});
