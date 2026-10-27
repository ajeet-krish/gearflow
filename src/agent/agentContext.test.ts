// Phase B2 agent context tests: finite guards, null Cl, token bound.

import { describe, expect, it } from "vitest";
import { buildAgentContext, type AppSnapshot } from "./agentContext";

function snapshot(over: Partial<AppSnapshot> = {}): AppSnapshot {
    return {
        spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
        reynolds: 50000,
        regime: "laminar, attached",
        bodyLabel: "NACA 2412",
        backend: "analytic live 128",
        engine: "analytic",
        gridLabel: "128x128",
        cl: 0.6543,
        cpMin: -1.2345,
        lbmStatus: "idle",
        lbmHasSnapshot: false,
        lbmStatsReady: false,
        lbmStats: null,
        variable: "speed",
        effectiveVariable: "speed",
        hasTke: false,
        hasRecirc: false,
        validation: { pass: 9, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic-potential, computed locally at 128",
        offline: false,
        ...over,
    };
}

describe("buildAgentContext", () => {
    it("passes finite Cl and CpMin through rounded", () => {
        const ctx = buildAgentContext(snapshot());
        expect(ctx.cl).toBeCloseTo(0.6543, 4);
        expect(ctx.cpMin).toBeCloseTo(-1.2345, 4);
        expect(ctx.spec.alphaDeg).toBe(6);
        expect(ctx.reynolds).toBe(50000);
    });

    it("nulls Cl and CpMin when non finite and adds an honesty line", () => {
        const ctx = buildAgentContext(snapshot({ cl: Number.NaN, cpMin: Number.POSITIVE_INFINITY }));
        expect(ctx.cl).toBeNull();
        expect(ctx.cpMin).toBeNull();
        expect(ctx.honesty.length).toBeGreaterThan(0);
        expect(ctx.honesty.join(" ")).toContain("not finite");
    });

    it("guards non finite reynolds and alpha without throwing", () => {
        const bad = snapshot({ reynolds: Number.NaN });
        bad.spec = { ...bad.spec, alphaDeg: Number.POSITIVE_INFINITY };
        const ctx = buildAgentContext(bad);
        expect(ctx.reynolds).toBeNull();
        expect(ctx.alphaDeg).toBeNull();
        expect(ctx.spec.alphaDeg).toBeNull();
    });

    it("carries no typed arrays and stays under the token budget", () => {
        const ctx = buildAgentContext(
            snapshot({
                lbmStatsReady: true,
                lbmStats: { samples: 40, startStep: 8000, step: 12000, recircFraction: 0.2, cdMean: 0.05, clMean: 0.6, clRms: 0.02, strouhal: null },
                provenanceLabel: "x".repeat(500),
            })
        );
        const json = JSON.stringify(ctx);
        expect(json).not.toContain("Float32Array");
        expect(json.length).toBeLessThan(3600);
        expect(ctx.provenanceLabel.length).toBeLessThanOrEqual(120);
    });

    it("flags LBM pending and field fallback honestly", () => {
        const ctx = buildAgentContext(
            snapshot({ backend: "lbm pending", variable: "k", effectiveVariable: "speed" })
        );
        expect(ctx.honesty.join(" ").toLowerCase()).toContain("pending");
        expect(ctx.honesty.join(" ")).toContain("speed");
    });
});

describe("buildAgentContext B2 minors", () => {
    it("reports step 12000 honestly with no silent cap", () => {
        const ctx = buildAgentContext(
            snapshot({
                lbmStatsReady: true,
                lbmStats: { samples: 40, startStep: 8000, step: 12000, recircFraction: 0.2, cdMean: 0.05, clMean: 0.6, clRms: 0.02, strouhal: null },
            })
        );
        expect(ctx.lbm.stats).not.toBeNull();
        expect(ctx.lbm.stats?.step).toBe(12000);
        expect(ctx.lbm.stats?.samples).toBe(40);
    });

    it("never throws on null snapshot, null spec, or missing validation", () => {
        expect(() => buildAgentContext(null)).not.toThrow();
        expect(() => buildAgentContext(undefined)).not.toThrow();
        const fallen = buildAgentContext(null);
        expect(fallen.spec.kind).toBe("unknown");
        expect(fallen.validation).toEqual({ pass: 0, warn: 0, fail: 0, info: 0 });

        const noSpec = snapshot();
        (noSpec as unknown as { spec: null }).spec = null;
        expect(() => buildAgentContext(noSpec)).not.toThrow();
        expect(buildAgentContext(noSpec).spec.kind).toBe("unknown");

        const noVal = snapshot() as unknown as Record<string, unknown>;
        delete noVal.validation;
        expect(() => buildAgentContext(noVal as unknown as AppSnapshot)).not.toThrow();
        expect(buildAgentContext(noVal as unknown as AppSnapshot).validation).toEqual({ pass: 0, warn: 0, fail: 0, info: 0 });
    });

    it("carries the additive lbmEffective flag, defaulting to false", () => {
        expect(buildAgentContext(snapshot()).lbm.effective).toBe(false);
        expect(buildAgentContext(snapshot({ lbmEffective: true })).lbm.effective).toBe(true);
    });

    it("flags an out of band alpha with an honest unvalidated line", () => {
        const inBand = buildAgentContext(snapshot());
        expect(inBand.honesty.join(" ")).not.toContain("unvalidated");
        const high = buildAgentContext(snapshot({ spec: { ...snapshot().spec, alphaDeg: 45 } }));
        expect(high.honesty.join(" ")).toContain("Alpha 45.0 deg is outside the characterized band");
        expect(high.honesty.join(" ")).toContain("unvalidated");
        const low = buildAgentContext(snapshot({ spec: { ...snapshot().spec, alphaDeg: -90 } }));
        expect(low.honesty.join(" ")).toContain("Alpha -90.0 deg is outside the characterized band");
    });
});
