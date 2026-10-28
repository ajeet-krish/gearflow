// App neural display contracts. Behavioral pins for the two review Majors:
// pending or failed predict without a keyed frame never reports neural
// live, provenance follows the selected frame, and a failed request
// retries exactly once. Pure helpers plus the real adapter, no workers.

import { describe, expect, it } from "vitest";
import type { FlowField, GeometrySpec } from "@/contracts/types";
import { DEFAULT_DOMAIN } from "@/contracts/types";
import {
    analyticProvenanceLabel,
    neuralProvenanceLabel,
} from "@/flow/solverRouter";
import {
    NeuralV2Adapter,
    neuralRequestKey,
    isUsableNeuralField,
} from "@/flow/neuralV2Adapter";
import {
    selectBackendName,
    selectProvenanceLabel,
    shouldRetryNeuralPredict,
} from "@/App";

const SPEC: GeometrySpec = {
    kind: "naca4",
    naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 },
    chord: 1,
    alphaDeg: 6,
    nPoints: 24,
};

const ANALYTIC_LABEL = analyticProvenanceLabel("neural-v2 weights ready");
const NEURAL_LABEL = neuralProvenanceLabel({ weightsVersion: "v2", latencyMs: 3, cached: false });

function uniformField(nx = 8, ny = 8): FlowField {
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

function baseBackend(over: Partial<Parameters<typeof selectBackendName>[0]> = {}) {
    return {
        isFixture: false,
        lbmFailedActive: false,
        lbmEffective: false,
        lbmHasSnapshot: false,
        solveError: null as string | null,
        isNeuralPending: false,
        isNeuralActive: false,
        solveGridNx: 256,
        ...over,
    };
}

describe("pending predict shows analytic provenance, never neural live", () => {
    it("backend reports loading while the analytic frame displays", () => {
        const backend = selectBackendName(baseBackend({ isNeuralPending: true }));
        expect(backend).toBe("neural-v2 loading");
        expect(backend).not.toBe("neural-v2 live");
    });

    it("provenance stays on the analytic label while pending", () => {
        const label = selectProvenanceLabel({
            isFixture: false,
            fixtureLabel: null,
            lbmEffective: false,
            lbmLabel: null,
            solveError: null,
            isHeldAnalyticFrame: false,
            frameGeometryLabel: "naca4 a6",
            frameGridLabel: "256x256",
            frameLabel: ANALYTIC_LABEL,
        });
        expect(label).toBe(ANALYTIC_LABEL);
        expect(label).not.toContain("neural-v2 predicted");
    });

    it("ready router with no keyed frame stays analytic live, not neural live", () => {
        const backend = selectBackendName(baseBackend({}));
        expect(backend).toBe("analytic live 256");
        expect(backend).not.toBe("neural-v2 live");
    });
});

describe("failed predict retries once then stays analytic with a failed note", () => {
    it("retry policy allows exactly one retry per key", () => {
        const key = neuralRequestKey(SPEC, 50000);
        expect(shouldRetryNeuralPredict(null, key)).toBe(true);
        expect(shouldRetryNeuralPredict(key, key)).toBe(false);
        const other = neuralRequestKey(SPEC, 80000);
        expect(shouldRetryNeuralPredict(key, other)).toBe(true);
    });

    it("transient failure retries cleanly and the retried frame is usable", async () => {
        let n = 0;
        let calls = 0;
        const field = uniformField();
        const predictor = {
            get loaded() {
                return true;
            },
            load: async () => {},
            predictFrame: async () => {
                calls += 1;
                n += 1;
                if (n === 1) throw new Error("transient ORT blip");
                return field;
            },
            setGeometry: (_g: GeometrySpec) => {},
            setRe: (_r: number) => {},
        };
        const adapter = new NeuralV2Adapter(predictor);
        const key = neuralRequestKey(SPEC, 50000);
        let retried: string | null = null;
        await expect(adapter.predictFor(SPEC, 50000)).rejects.toThrow(/blip/);
        expect(calls).toBe(1);
        expect(shouldRetryNeuralPredict(retried, key)).toBe(true);
        retried = key;
        const retry = await adapter.predictFor(SPEC, 50000);
        expect(retry.cached).toBe(false);
        expect(calls).toBe(2);
        expect(isUsableNeuralField(retry.flow, retry.cl, retry.cpMin)).toBe(true);
        expect(shouldRetryNeuralPredict(retried, key)).toBe(false);
    });

    it("persistent failure stays analytic live with no third attempt", async () => {
        let calls = 0;
        const predictor = {
            get loaded() {
                return true;
            },
            load: async () => {},
            predictFrame: async () => {
                calls += 1;
                throw new Error("persistent ORT fault");
            },
            setGeometry: (_g: GeometrySpec) => {},
            setRe: (_r: number) => {},
        };
        const adapter = new NeuralV2Adapter(predictor);
        const key = neuralRequestKey(SPEC, 50000);
        let retried: string | null = null;
        await expect(adapter.predictFor(SPEC, 50000)).rejects.toThrow(/persistent/);
        expect(shouldRetryNeuralPredict(retried, key)).toBe(true);
        retried = key;
        await expect(adapter.predictFor(SPEC, 50000)).rejects.toThrow(/persistent/);
        expect(calls).toBe(2);
        expect(shouldRetryNeuralPredict(retried, key)).toBe(false);
        const backend = selectBackendName(baseBackend({}));
        expect(backend).toBe("analytic live 256");
        const label = selectProvenanceLabel({
            isFixture: false,
            fixtureLabel: null,
            lbmEffective: false,
            lbmLabel: null,
            solveError: null,
            isHeldAnalyticFrame: false,
            frameGeometryLabel: "naca4 a6",
            frameGridLabel: "256x256",
            frameLabel: ANALYTIC_LABEL,
        });
        expect(label).toBe(ANALYTIC_LABEL);
    });
});

describe("solve error wording follows the selected frame", () => {
    it("a displayed neural frame never carries solve error wording", () => {
        const label = selectProvenanceLabel({
            isFixture: false,
            fixtureLabel: null,
            lbmEffective: false,
            lbmLabel: null,
            solveError: "analytic solve produced a non-finite field",
            isHeldAnalyticFrame: false,
            frameGeometryLabel: "naca4 a6",
            frameGridLabel: "128x128",
            frameLabel: NEURAL_LABEL,
        });
        expect(label).toBe(NEURAL_LABEL);
        expect(label).not.toContain("solve error");
    });

    it("a held analytic frame carries the solve error wording", () => {
        const label = selectProvenanceLabel({
            isFixture: false,
            fixtureLabel: null,
            lbmEffective: false,
            lbmLabel: null,
            solveError: "analytic solve produced a non-finite field",
            isHeldAnalyticFrame: true,
            frameGeometryLabel: "naca4 a6",
            frameGridLabel: "256x256",
            frameLabel: ANALYTIC_LABEL,
        });
        expect(label).toContain("solve error, showing last good");
        expect(label).toContain("naca4 a6");
        expect(label).toContain("256x256");
    });

    it("neural live backend requires a keyed frame, held analytic wins otherwise", () => {
        expect(selectBackendName(baseBackend({ isNeuralActive: true }))).toBe("neural-v2 live");
        expect(
            selectBackendName(baseBackend({ isNeuralActive: false, solveError: "boom" }))
        ).toBe("analytic held");
        expect(
            selectBackendName(baseBackend({ isNeuralActive: true, solveError: "boom" }))
        ).toBe("analytic held");
    });
});
