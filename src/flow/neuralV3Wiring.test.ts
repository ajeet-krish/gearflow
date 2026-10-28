// Phase C7 v3 street wiring tests. Adapter input parity with v2,
// availability and failure paths, router v3 then v2 then analytic order,
// street loop gating, pause and resume phase stability on a fake clock,
// the four honesty labels, and App wiring source pins. No network, no
// workers, no live solves.

import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowField, GeometrySpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    decideFastPath,
    analyticProvenanceLabel,
    frameHonestyLabel,
    honestyStateForFrame,
    lbmSolvedLabel,
    neuralPhaseAveragedLabel,
    neuralSteadyLabel,
    analyticFallbackLabel,
} from "@/flow/solverRouter";
import {
    NeuralV2Adapter,
    neuralRequestKey,
    isUsableNeuralField,
    createNeuralRequestTracker,
} from "@/flow/neuralV2Adapter";
import {
    NeuralV3Adapter,
    neuralV3RequestKey,
    harmonicStateForV3Field,
    NEURAL_V3_ADAPTER_VERSION,
} from "@/flow/neuralV3Adapter";
import {
    StreetLoop,
    shouldAnimateStreet,
    type StreetLoopFeeds,
} from "@/flow/streetLoop";
import { PhaseClock, PHASE_TAU } from "@/flow/phaseReconstruction";
import { selectBackendName } from "@/App";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "../App.tsx");
const streetPath = resolve(here, "streetLoop.ts");
const simPath = resolve(here, "../ui/SimulationSection.tsx");

const SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 24,
};

function baseField(nx = 8, ny = 8): FlowField {
    const n = nx * ny;
    return {
        nx,
        ny,
        domain: { ...DEFAULT_DOMAIN },
        u: new Float32Array(n).fill(1),
        v: new Float32Array(n).fill(0),
        p: new Float32Array(n).fill(0),
        omega: new Float32Array(n).fill(0),
        obstacle: new Float32Array(n).fill(0),
    };
}

function streetField(opts?: { valid?: boolean; reason?: string | null }): FlowField {
    const field = baseField();
    const n = field.nx * field.ny;
    const valid = opts?.valid ?? true;
    return {
        ...field,
        uMean: field.u.slice(),
        vMean: field.v.slice(),
        uCos: new Float32Array(n).fill(0.05),
        uSin: new Float32Array(n).fill(0.02),
        vCos: new Float32Array(n).fill(-0.01),
        vSin: new Float32Array(n).fill(0.03),
        strouhalPredicted: 0.2,
        explainedPredicted: 0.8,
        harmonicValid: valid,
        harmonicInvalidReason: valid ? null : (opts?.reason ?? "validity probability 0.1190 below 0.5"),
        validityProbability: valid ? 0.9 : 0.119,
        cappedCells: 0,
    };
}

function mockV3Predictor(field: FlowField, opts?: { failFirst?: boolean; loaded?: boolean }): {
    predictor: {
        loaded: boolean;
        load: () => Promise<void>;
        predictFrame: () => Promise<FlowField>;
        setGeometry: (g: GeometrySpec) => void;
        setRe: (r: number) => void;
    };
    staged: { geom: GeometrySpec | null; re: number | null };
    calls: { predict: number; load: number };
} {
    const staged = { geom: null as GeometrySpec | null, re: null as number | null };
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
        setGeometry: (g: GeometrySpec) => {
            staged.geom = g;
        },
        setRe: (r: number) => {
            staged.re = r;
        },
    };
    return { predictor, staged, calls };
}

function fakeFeeds(): {
    feeds: StreetLoopFeeds;
    fire: (dtMs: number) => void;
    setHidden: (h: boolean) => void;
    pendingCount: () => number;
} {
    let nextId = 1;
    const pending = new Map<number, (now: number) => void>();
    let now = 1000;
    let hidden = false;
    return {
        feeds: {
            requestFrame: (cb) => {
                const id = nextId;
                nextId += 1;
                pending.set(id, cb);
                return id;
            },
            cancelFrame: (id) => {
                pending.delete(id);
            },
            nowMs: () => now,
            isHidden: () => hidden,
        },
        fire: (dt: number) => {
            now += dt;
            const cbs = [...pending.entries()];
            pending.clear();
            for (const [, cb] of cbs) cb(now);
        },
        setHidden: (h: boolean) => {
            hidden = h;
        },
        pendingCount: () => pending.size,
    };
}

describe("adapter input construction parity with v2", () => {
    it("shares one request key for one case", () => {
        expect(neuralV3RequestKey(SPEC, 1000)).toBe(neuralRequestKey(SPEC, 1000));
        expect(neuralV3RequestKey(SPEC, 2000)).toBe(neuralRequestKey(SPEC, 2000));
        expect(neuralV3RequestKey({ ...SPEC, alphaDeg: 8 }, 1000)).toBe(
            neuralRequestKey({ ...SPEC, alphaDeg: 8 }, 1000),
        );
        expect(neuralV3RequestKey(SPEC, 1000)).not.toBe(neuralV3RequestKey(SPEC, 2000));
    });

    it("stages the same geometry plus Re before one inference", async () => {
        const field = streetField();
        const v2 = mockV3Predictor(field);
        const v3 = mockV3Predictor(field);
        const v2Adapter = new NeuralV2Adapter(v2.predictor);
        const v3Adapter = new NeuralV3Adapter(v3.predictor);
        await v2Adapter.predictFor(SPEC, 1000);
        await v3Adapter.predictFor(SPEC, 1000);
        expect(v3.staged.geom).toEqual(v2.staged.geom);
        expect(v3.staged.re).toBe(v2.staged.re);
        expect(v3.staged.re).toBe(1000);
        expect(v3.calls.predict).toBe(1);
    });

    it("computes the same Cl and CpMin result math as v2", async () => {
        const field = streetField();
        const { predictor } = mockV3Predictor(field);
        const adapter = new NeuralV3Adapter(predictor);
        const res = await adapter.predictFor(SPEC, 1000);
        expect(res.cl).toBeCloseTo(0, 4);
        expect(Number.isFinite(res.cpMin)).toBe(true);
        expect(isUsableNeuralField(res.flow, res.cl, res.cpMin)).toBe(true);
    });
});

describe("v3 adapter availability and failure paths", () => {
    it("ensureLoaded maps loaded true to ready without fetching", async () => {
        const { predictor, calls } = mockV3Predictor(streetField(), { loaded: true });
        const adapter = new NeuralV3Adapter(predictor);
        const status = await adapter.ensureLoaded();
        expect(status).toBe("ready");
        expect(adapter.availability).toBe("ready");
        expect(calls.load).toBe(0);
    });

    it("ensureLoaded maps a load throw to failed", async () => {
        const predictor = {
            get loaded() {
                return false;
            },
            load: async () => {
                throw new Error("bundle missing");
            },
            predictFrame: async () => streetField(),
        };
        const adapter = new NeuralV3Adapter(predictor);
        const status = await adapter.ensureLoaded();
        expect(status).toBe("failed");
        expect(adapter.availability).toBe("failed");
    });

    it("exposes harmonic validity plus the reason and the aux scalars", async () => {
        const { predictor } = mockV3Predictor(streetField({ valid: true }));
        const adapter = new NeuralV3Adapter(predictor);
        const res = await adapter.predictFor(SPEC, 1000);
        expect(res.harmonicValid).toBe(true);
        expect(res.harmonicInvalidReason).toBeNull();
        expect(res.strouhal).toBeCloseTo(0.2, 9);
        expect(res.explained).toBeCloseTo(0.8, 9);
        expect(res.cached).toBe(false);
        expect(adapter.version).toBe(NEURAL_V3_ADAPTER_VERSION);
    });

    it("carries the failing gate reason when the street cannot be shown", async () => {
        const reason = "explained 0.1000 below 0.35";
        const { predictor } = mockV3Predictor(streetField({ valid: false, reason }));
        const adapter = new NeuralV3Adapter(predictor);
        const res = await adapter.predictFor(SPEC, 1000);
        expect(res.harmonicValid).toBe(false);
        expect(res.harmonicInvalidReason).toBe(reason);
        expect(adapter.lastHarmonicState()).toEqual({ valid: false, reason });
    });

    it("caches by key and never poisons the cache on failure", async () => {
        const field = streetField();
        const { predictor, calls } = mockV3Predictor(field, { failFirst: true });
        const adapter = new NeuralV3Adapter(predictor);
        await expect(adapter.predictFor(SPEC, 1000)).rejects.toThrow(/blip/);
        expect(calls.predict).toBe(1);
        expect(adapter.lastHarmonicState()).toBeNull();
        const retry = await adapter.predictFor(SPEC, 1000);
        expect(retry.cached).toBe(false);
        expect(retry.harmonicValid).toBe(true);
        const cached = await adapter.predictFor(SPEC, 1000);
        expect(cached.cached).toBe(true);
        expect(calls.predict).toBe(2);
    });

    it("rejects poisoned frames through the same usable gate", async () => {
        const bad = streetField();
        bad.u[3] = Number.NaN;
        const { predictor } = mockV3Predictor(bad);
        const adapter = new NeuralV3Adapter(predictor);
        await expect(adapter.predictFor(SPEC, 1000)).rejects.toThrow();
    });

    it("harmonic helper defaults a missing reason to no valid shedding", () => {
        const field = streetField({ valid: false });
        const bare: FlowField = { ...field, harmonicInvalidReason: null };
        expect(harmonicStateForV3Field(bare)).toEqual({ valid: false, reason: "no valid shedding" });
        expect(harmonicStateForV3Field(streetField({ valid: true }))).toEqual({ valid: true, reason: null });
    });

    it("latest only commit keeps stale keys off screen", () => {
        const tracker = createNeuralRequestTracker();
        const first = tracker.next();
        const second = tracker.next();
        expect(tracker.isLatest(first)).toBe(false);
        expect(tracker.isLatest(second)).toBe(true);
    });
});

describe("router prefers v3 then v2 then analytic", () => {
    it("routes both ready plus in domain to neural-v3", () => {
        const decision = decideFastPath({
            body: "cylinder",
            alphaDeg: 0,
            reynolds: 100,
            neuralStatus: "ready",
            neuralV3Status: "ready",
        });
        expect(decision.path).toBe("neural-v3");
        expect(decision.inDomain).toBe(true);
        expect(decision.reason).toContain("neural-v3 weights ready");
    });

    it("falls back to v2 when v3 is still loading but v2 is ready", () => {
        const decision = decideFastPath({
            body: "cylinder",
            alphaDeg: 0,
            reynolds: 100,
            neuralStatus: "ready",
            neuralV3Status: "loading",
        });
        expect(decision.path).toBe("neural-v2");
    });

    it("falls back to v2 when v3 failed but v2 is ready", () => {
        const decision = decideFastPath({
            body: "cylinder",
            alphaDeg: 0,
            reynolds: 100,
            neuralStatus: "ready",
            neuralV3Status: "failed",
        });
        expect(decision.path).toBe("neural-v2");
    });

    it("serves analytic when neither bundle is ready", () => {
        const pending: Array<"loading" | "failed" | "unavailable"> = ["loading", "failed", "unavailable"];
        for (const v3 of pending) {
            for (const v2 of pending) {
                const decision = decideFastPath({
                    body: "cylinder",
                    alphaDeg: 0,
                    reynolds: 100,
                    neuralStatus: v2,
                    neuralV3Status: v3,
                });
                expect(decision.path).toBe("analytic");
                expect(decision.reason).toContain("analytic fallback");
            }
        }
    });

    it("respects the envelope for v3 exactly as v2: out of domain serves analytic", () => {
        const v3 = decideFastPath({
            body: "naca2412",
            alphaDeg: 6,
            reynolds: 50000,
            neuralStatus: "ready",
            neuralV3Status: "ready",
        });
        expect(v3.path).toBe("analytic");
        expect(v3.reason).toContain("outside the provisional neural envelope");
        const legacy = decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "ready" });
        expect(legacy.path).toBe("analytic");
        expect(legacy.reason).toBe(v3.reason);
    });

    it("keeps legacy behaviour byte for byte without a v3 status", () => {
        expect(
            decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 1200, neuralStatus: "ready" }).path,
        ).toBe("neural-v2");
        expect(
            decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "loading" }).reason,
        ).toBe("neural-v2 weights still loading, analytic fallback");
        expect(
            decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "failed" }).reason,
        ).toBe("neural-v2 weights failed to load, analytic fallback");
        expect(
            decideFastPath({ body: "naca2412", alphaDeg: 6, reynolds: 50000, neuralStatus: "unavailable" }).reason,
        ).toBe("neural-v2 weights unavailable, analytic fallback");
    });
});

describe("street loop starts only when harmonicValid", () => {
    const validGate = {
        path: "neural-v3" as const,
        harmonicValid: true,
        lbmEffective: false,
        isFixture: false,
        solveError: null,
        strouhal: 0.2,
    };

    it("starts for a served valid v3 street", () => {
        expect(shouldAnimateStreet(validGate)).toBe(true);
    });

    it("never starts for a steady v3 frame", () => {
        expect(shouldAnimateStreet({ ...validGate, harmonicValid: false })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, strouhal: null })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, strouhal: 0 })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, strouhal: Number.NaN })).toBe(false);
    });

    it("never starts for LBM, fixture, held analytic, v2, or analytic paths", () => {
        expect(shouldAnimateStreet({ ...validGate, lbmEffective: true })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, isFixture: true })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, solveError: "boom" })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, path: "neural-v2" })).toBe(false);
        expect(shouldAnimateStreet({ ...validGate, path: "analytic" })).toBe(false);
    });
});

describe("phase does not jump on pause or resume", () => {
    it("freezes while paused and continues from the same phase", () => {
        const clock = new PhaseClock();
        const first = clock.advance(500, 0.2, 1, 1);
        clock.pause();
        const frozen = clock.advance(5000, 0.2, 1, 1);
        expect(frozen.phaseRadians).toBe(first.phaseRadians);
        clock.resume();
        const second = clock.advance(500, 0.2, 1, 1);
        expect(second.phaseRadians).toBeCloseTo(first.phaseRadians + PHASE_TAU * 0.2 * 0.5, 9);
    });

    it("the loop skips hidden frames without consuming phase", () => {
        const fake = fakeFeeds();
        const seen: number[] = [];
        const loop = new StreetLoop({
            strouhal: 0.2,
            referenceLength: 1,
            speed: 1,
            feeds: fake.feeds,
            onFrame: (phase) => {
                seen.push(phase);
            },
        });
        loop.start(0);
        expect(loop.isRunning()).toBe(true);
        fake.fire(500);
        expect(seen.length).toBe(1);
        const live = seen[0];
        fake.setHidden(true);
        fake.fire(5000);
        expect(seen.length).toBe(1);
        expect(loop.getPhase()).toBe(live);
        fake.setHidden(false);
        fake.fire(500);
        expect(seen.length).toBe(2);
        expect(seen[1]).toBeCloseTo(live + PHASE_TAU * 0.2 * 0.5, 9);
        loop.stop();
        expect(loop.isRunning()).toBe(false);
        expect(fake.pendingCount()).toBe(0);
    });

    it("pause and resume on the loop never jump the phase", () => {
        const fake = fakeFeeds();
        const seen: number[] = [];
        const loop = new StreetLoop({
            strouhal: 0.2,
            referenceLength: 1,
            speed: 1,
            feeds: fake.feeds,
            onFrame: (phase) => {
                seen.push(phase);
            },
        });
        loop.start(0);
        fake.fire(500);
        const before = loop.getPhase();
        loop.pause();
        fake.fire(5000);
        expect(loop.getPhase()).toBe(before);
        loop.resume();
        fake.fire(500);
        expect(loop.getPhase()).toBeCloseTo(before + PHASE_TAU * 0.2 * 0.5, 9);
        expect(seen[seen.length - 1]).toBe(loop.getPhase());
        loop.stop();
        loop.stop();
        expect(fake.pendingCount()).toBe(0);
    });

    it("rejects non positive loop inputs", () => {
        expect(() => new StreetLoop({ strouhal: 0, referenceLength: 1, feeds: fakeFeeds().feeds })).toThrow();
        expect(() => new StreetLoop({ strouhal: 0.2, referenceLength: 0, feeds: fakeFeeds().feeds })).toThrow();
    });
});

describe("labels are correct for each of the four states", () => {
    it("maps sources to the four honesty states", () => {
        expect(honestyStateForFrame({ source: "lbm" })).toBe("solved");
        expect(honestyStateForFrame({ source: "neural", harmonicValid: true })).toBe("phase-averaged-modeled");
        expect(honestyStateForFrame({ source: "neural", harmonicValid: false })).toBe("steady-predicted");
        expect(honestyStateForFrame({ source: "neural" })).toBe("steady-predicted");
        expect(honestyStateForFrame({ source: "analytic" })).toBe("analytic-fallback");
    });

    it("solved names the instantaneous snapshot and never reads averaged", () => {
        const label = lbmSolvedLabel();
        expect(label.toLowerCase()).toContain("solved");
        expect(label).toContain("instantaneous snapshot");
        expect(frameHonestyLabel("solved")).toContain("solved");
    });

    it("phase averaged is modeled and never solved", () => {
        const label = neuralPhaseAveragedLabel({ strouhal: 0.2, explained: 0.8, weightsVersion: "v3" });
        expect(label).toContain("phase averaged");
        expect(label.toLowerCase()).toContain("modeled");
        expect(label.toLowerCase()).not.toContain("solved");
        expect(label).toContain("St 0.20");
        expect(frameHonestyLabel("phase-averaged-modeled").toLowerCase()).not.toContain("solved");
    });

    it("steady predicted carries the failing gate reason", () => {
        const reason = "validity probability 0.1190 below 0.5";
        const label = neuralSteadyLabel(reason, "v3");
        expect(label).toContain("steady predicted");
        expect(label).toContain(reason);
        expect(label.toLowerCase()).not.toContain("solved");
        expect(frameHonestyLabel("steady-predicted", reason)).toContain(reason);
    });

    it("analytic fallback names the potential preview", () => {
        const label = analyticFallbackLabel("neural-v3 weights unavailable, analytic fallback");
        expect(label).toContain("analytic fallback");
        expect(label).toContain("potential");
        expect(label).toContain("preview");
        expect(frameHonestyLabel("analytic-fallback", "neural-v3 weights unavailable")).toContain("potential");
    });

    it("legacy path labels keep their honest wording", () => {
        expect(analyticProvenanceLabel("neural-v2 weights unavailable, analytic fallback")).toContain("not validated");
    });
});

describe("backend names for the v3 street", () => {
    const base = {
        isFixture: false,
        lbmFailedActive: false,
        lbmEffective: false,
        lbmHasSnapshot: false,
        solveError: null as string | null,
        isNeuralPending: false,
        isNeuralActive: false,
        solveGridNx: 128,
    };

    it("names the v3 street first and keeps v2 wording otherwise", () => {
        expect(selectBackendName({ ...base, isNeuralV3Pending: true })).toBe("neural-v3 loading");
        expect(selectBackendName({ ...base, isNeuralV3Active: true })).toBe("neural-v3 live");
        expect(selectBackendName({ ...base, isNeuralPending: true })).toBe("neural-v2 loading");
        expect(selectBackendName({ ...base, isNeuralActive: true })).toBe("neural-v2 live");
        expect(selectBackendName(base)).toBe("analytic live 128");
    });
});

describe("App wiring source pins", () => {
    it("tries the v3 bundle first with a single street loop", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("NeuralV3Adapter");
        expect(src).toContain("SurrogateV3Provider");
        expect(src).toContain("neural-v3");
        expect(src).toContain("new StreetLoop");
        expect(src).toContain("shouldAnimateStreet");
        expect(src).toContain("reconstructAtPhase");
        expect(src).toContain("setStreetTick");
        expect(src).toContain("streetDisplay");
        expect(src).toContain("neuralPhaseAveragedLabel");
        expect(src).toContain("neuralSteadyLabel");
        expect(src).toContain("harmonicValid");
        expect(src).toContain("harmonicInvalidReason");
    });

    it("keeps the v2 fallback exactly as today", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("NeuralV2Adapter");
        expect(src).toContain("neural-v2");
        expect(src).toContain("neuralProvenanceLabel");
        expect(src).toContain("fixtureSolved ?? lbmSolved ?? neuralV3Solved ?? neuralSolved ?? solved.frame");
    });

    it("shows the mean arrays while the street is paused via the mean toggle", async () => {
        const src = await readFile(appPath, "utf8");
        expect(src).toContain("if (prefs.meanFields) return null;");
    });

    it("uses fake clock feeds in the street loop with visibility and cancel", async () => {
        const src = await readFile(streetPath, "utf8");
        expect(src).toContain("requestAnimationFrame");
        expect(src).toContain("cancelAnimationFrame");
        expect(src).toContain("isHidden");
        expect(src).toContain("shouldAnimateStreet");
    });

    it("names the neural-v3 path in the instrument rack", async () => {
        const src = await readFile(simPath, "utf8");
        expect(src).toContain("neural-v3 phase averaged, modeled");
    });
});
