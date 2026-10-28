// Phase 2 backend unification tests. Router decisions through the adapter
// mock, stale key guard, failed predict retry, hatch flags, fixture debug
// override, and executor engine narrowing. Pure plus source reads, no live
// calls, no worker threads.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowField, GeometrySpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import { decideFastPath, analyticProvenanceLabel, neuralProvenanceLabel } from "@/flow/solverRouter";
import {
    NeuralV2Adapter,
    neuralRequestKey,
    neuralResultFor,
    isUsableNeuralField,
    createNeuralRequestTracker,
} from "@/flow/neuralV2Adapter";
import { readLbmArmed, readFixtureDebug, isLegacyEngineAuto } from "@/App";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");

const SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 24,
};

function uniformField(nx = 8, ny = 8, u0 = 1, p0 = 0): FlowField {
    const n = nx * ny;
    const u = new Float32Array(n).fill(u0);
    const v = new Float32Array(n).fill(0);
    const p = new Float32Array(n).fill(p0);
    const omega = new Float32Array(n).fill(0);
    const obstacle = new Float32Array(n).fill(0);
    return { nx, ny, domain: { ...DEFAULT_DOMAIN }, u, v, p, omega, obstacle };
}

function mockPredictor(field: FlowField, opts?: { failFirst?: boolean; loaded?: boolean }): {
    predictor: {
        loaded: boolean;
        load: () => Promise<void>;
        predictFrame: () => Promise<FlowField>;
        setGeometry: (g: GeometrySpec) => void;
        setRe: (r: number) => void;
    };
    calls: { predict: number; load: number };
} {
    const calls = { predict: 0, load: 0 };
    let loaded = opts?.loaded ?? true;
    let n = 0;
    const predictor = {
        get loaded() {
            return loaded;
        },
        load: async () => {
            calls.load += 1;
            loaded = true;
        },
        predictFrame: async () => {
            calls.predict += 1;
            n += 1;
            if (opts?.failFirst === true && n === 1) throw new Error("transient ORT blip");
            return field;
        },
        setGeometry: (_g: GeometrySpec) => {},
        setRe: (_r: number) => {},
    };
    return { predictor, calls };
}

describe("neural request key and result math", () => {
    it("keys on spec plus Re and stays stable", () => {
        const a = neuralRequestKey(SPEC, 50000);
        const b = neuralRequestKey(SPEC, 50000);
        const c = neuralRequestKey(SPEC, 80000);
        const d = neuralRequestKey({ ...SPEC, alphaDeg: 8 }, 50000);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).not.toBe(d);
    });

    it("changes the key when center moves", () => {
        const base = neuralRequestKey({ ...SPEC, center: { x: 0, y: 0 } }, 50000);
        const same = neuralRequestKey({ ...SPEC, center: { x: 0, y: 0 } }, 50000);
        const moveX = neuralRequestKey({ ...SPEC, center: { x: 0.5, y: 0 } }, 50000);
        const moveY = neuralRequestKey({ ...SPEC, center: { x: 0, y: 0.25 } }, 50000);
        const dropped = neuralRequestKey(SPEC, 50000);
        expect(base).toBe(same);
        expect(base).not.toBe(moveX);
        expect(base).not.toBe(moveY);
        expect(base).not.toBe(dropped);
    });

    it("changes the key when the custom polygon changes", () => {
        const polyA = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }];
        const polyB = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
        const polyMoved = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.5 }];
        const base = neuralRequestKey({ ...SPEC, polygon: polyA }, 50000);
        expect(base).toBe(neuralRequestKey({ ...SPEC, polygon: [...polyA] }, 50000));
        expect(base).not.toBe(neuralRequestKey(SPEC, 50000));
        expect(base).not.toBe(neuralRequestKey({ ...SPEC, polygon: polyB }, 50000));
        expect(base).not.toBe(neuralRequestKey({ ...SPEC, polygon: polyMoved }, 50000));
    });

    it("changes the key when nPoints changes", () => {
        const base = neuralRequestKey(SPEC, 50000);
        const more = neuralRequestKey({ ...SPEC, nPoints: SPEC.nPoints + 8 }, 50000);
        expect(base).not.toBe(more);
        expect(base).toBe(neuralRequestKey({ ...SPEC, nPoints: SPEC.nPoints }, 50000));
    });

    it("computes Cl near zero on uniform flow and CpMin over fluid cells", () => {
        const field = uniformField(8, 8, 1, 0.5);
        const res = neuralResultFor(field, 1, 12.5);
        expect(res.cl).toBeCloseTo(0, 6);
        expect(res.cpMin).toBeCloseTo(1, 6);
        expect(res.solveMs).toBe(12.5);
    });

    it("gates poisoned fields", () => {
        const good = uniformField();
        expect(isUsableNeuralField(good, 0.1, -0.5)).toBe(true);
        const bad = uniformField();
        bad.u[3] = Number.NaN;
        expect(isUsableNeuralField(bad, 0.1, -0.5)).toBe(false);
        expect(isUsableNeuralField(good, Number.NaN, -0.5)).toBe(false);
    });
});

describe("router decisions via adapter mock", () => {
    it("ready plus in domain routes neural, every other status falls back", () => {
        const inDomain = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 2000, neuralStatus: "ready" });
        expect(inDomain.path).toBe("neural-v2");
        const out = decideFastPath({ body: "naca2412", alphaDeg: 30, reynolds: 1000, neuralStatus: "ready" });
        expect(out.path).toBe("analytic");
        expect(out.reason).toContain("outside the provisional neural envelope");
        for (const s of ["loading", "failed", "unavailable"] as const) {
            const d = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 2000, neuralStatus: s });
            expect(d.path).toBe("analytic");
        }
    });

    it("labels stay honest: predicted versus potential flow", () => {
        expect(neuralProvenanceLabel({ weightsVersion: "v2", latencyMs: 3, cached: false }))
            .toBe("neural-v2 predicted, not validated, (v2, 3.0 ms)");
        expect(analyticProvenanceLabel("neural-v2 weights unavailable, analytic fallback"))
            .toBe("analytic potential flow (neural-v2 weights unavailable, analytic fallback), not validated");
    });

    it("adapter availability fans into the router without live calls", async () => {
        const field = uniformField();
        const { predictor } = mockPredictor(field, { loaded: false });
        const adapter = new NeuralV2Adapter(predictor);
        expect(adapter.availability).toBe("unavailable");
        const status = await adapter.ensureLoaded();
        expect(status).toBe("ready");
        const decision = decideFastPath({
            body: "naca2412",
            alphaDeg: 6,
            reynolds: 2000,
            neuralStatus: status,
        });
        expect(decision.path).toBe("neural-v2");
    });
});

describe("adapter cache, stale guard, retry", () => {
    it("caches the last frame by request key", async () => {
        const field = uniformField();
        const { predictor, calls } = mockPredictor(field);
        const adapter = new NeuralV2Adapter(predictor);
        const first = await adapter.predictFor(SPEC, 50000);
        expect(first.cached).toBe(false);
        expect(calls.predict).toBe(1);
        const second = await adapter.predictFor(SPEC, 50000);
        expect(second.cached).toBe(true);
        expect(calls.predict).toBe(1);
        expect(second.flow).toBe(first.flow);
        const third = await adapter.predictFor(SPEC, 80000);
        expect(third.cached).toBe(false);
        expect(calls.predict).toBe(2);
    });

    it("stale request ids never display: only the latest commits", () => {
        const tracker = createNeuralRequestTracker();
        const first = tracker.next();
        const second = tracker.next();
        expect(tracker.isLatest(first)).toBe(false);
        expect(tracker.isLatest(second)).toBe(true);
        expect(tracker.latest()).toBe(second);
    });

    it("failed predict retries cleanly with no poisoned cache", async () => {
        const field = uniformField();
        const { predictor, calls } = mockPredictor(field, { failFirst: true });
        const adapter = new NeuralV2Adapter(predictor);
        await expect(adapter.predictFor(SPEC, 50000)).rejects.toThrow(/blip/);
        expect(calls.predict).toBe(1);
        const retry = await adapter.predictFor(SPEC, 50000);
        expect(retry.cached).toBe(false);
        expect(calls.predict).toBe(2);
        expect(isUsableNeuralField(retry.flow, retry.cl, retry.cpMin)).toBe(true);
        const cached = await adapter.predictFor(SPEC, 50000);
        expect(cached.cached).toBe(true);
        expect(calls.predict).toBe(2);
    });
});

describe("hatch flags", () => {
    it("arms LBM only on ?engine=lbm", () => {
        expect(readLbmArmed("?engine=lbm")).toBe(true);
        expect(readLbmArmed("?engine=analytic")).toBe(false);
        expect(readLbmArmed("?engine=wasm")).toBe(false);
        expect(readLbmArmed("?wasm=1")).toBe(false);
        expect(readLbmArmed("")).toBe(false);
    });

    it("legacy wasm flags map to auto", () => {
        expect(isLegacyEngineAuto("?engine=wasm")).toBe(true);
        expect(isLegacyEngineAuto("?wasm=1")).toBe(true);
        expect(isLegacyEngineAuto("?engine=lbm")).toBe(false);
        expect(isLegacyEngineAuto("")).toBe(false);
    });

    it("App keeps the lbm hatch and the legacy auto mapping in source", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("readLbmArmed");
        expect(src).toContain("isLegacyEngineAuto");
        expect(src).toContain("?engine=wasm");
        expect(src).toContain("?wasm=1");
        expect(src).toContain("map to auto");
    });
});

describe("fixture debug override", () => {
    it("reads ?fixture=1 only", () => {
        expect(readFixtureDebug("?fixture=1")).toBe(true);
        expect(readFixtureDebug("?fixture=0")).toBe(false);
        expect(readFixtureDebug("")).toBe(false);
    });

    it("App overrides the displayed frame without controls", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("readFixtureDebug");
        expect(src).toContain("fixtureSolved ?? lbmSolved ?? neuralSolved ?? solved.frame");
        expect(src).toContain("fixture debug preview");
        expect(src).not.toContain("onSolveMode");
        expect(src).not.toContain("solveMode={");
    });
});

describe("executor engine narrowing", () => {
    it("App narrows set_engine to analytic or lbm with a pointer copy", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("setLbmArmedAndMirror");
        expect(src).toContain("ENGINE_TOKENS");
        expect(src).toContain("analytic");
        expect(src).toContain('"lbm"');
        expect(src).not.toContain('setMode("surrogate")');
        expect(src).not.toContain("wasm-rust live");
    });
});
