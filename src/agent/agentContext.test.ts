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

describe("buildAgentContext naca snapshot (R3)", () => {
    it("carries the live section code plus fractions for relative edits", () => {
        const ctx = buildAgentContext(snapshot());
        expect(ctx.spec.naca).toEqual({ code: "2412", m: 0.02, p: 0.4, t: 0.12 });
    });

    it("nulls the snapshot off section and on missing input", () => {
        const cyl = snapshot({
            spec: { kind: "cylinder", chord: 1, alphaDeg: 0, nPoints: 64, radius: 0.25 },
        });
        expect(buildAgentContext(cyl).spec.naca).toBeNull();
        expect(buildAgentContext(null).spec.naca).toBeNull();
    });
});

describe("buildAgentContext T1 surrogate evidence, caseKey, frameSettled", () => {
    function maximalSurrogate(): Record<string, unknown> {
        return {
            path: "n".repeat(200),
            honestyState: "s".repeat(200),
            weightsVersion: "v".repeat(200),
            runId: "r".repeat(200),
            latencyMs: 12.5,
            inDomain: true,
            domainReason: "d".repeat(500),
            strouhal: 0.21,
            explained: 0.9,
            harmonicValid: false,
            harmonicInvalidReason: "h".repeat(500),
            recircFraction: 0.3,
            tkePeak: 0.05,
            vorticityPeak: 12.5,
            analyticCl: 0.65,
            analyticCpMin: -1.2,
            deltaClVsAnalytic: 0.01,
            deltaCpMinVsAnalytic: -0.02,
        };
    }

    it("nulls non-finite surrogate numbers instead of quoting them", () => {
        const ctx = buildAgentContext(
            snapshot({
                surrogate: {
                    ...maximalSurrogate(),
                    latencyMs: Number.NaN,
                    strouhal: Number.POSITIVE_INFINITY,
                    tkePeak: "hot" as unknown as number,
                    analyticCl: Number.NaN,
                    deltaClVsAnalytic: Number.POSITIVE_INFINITY,
                },
            })
        );
        expect(ctx.surrogate).not.toBeNull();
        expect(ctx.surrogate?.latencyMs).toBeNull();
        expect(ctx.surrogate?.strouhal).toBeNull();
        expect(ctx.surrogate?.tkePeak).toBeNull();
        expect(ctx.surrogate?.analyticCl).toBeNull();
        expect(ctx.surrogate?.deltaClVsAnalytic).toBeNull();
        expect(ctx.surrogate?.recircFraction).toBeCloseTo(0.3, 5);
    });

    it("nulls non-boolean surrogate booleans instead of coercing them", () => {
        const ctx = buildAgentContext(
            snapshot({
                surrogate: {
                    ...maximalSurrogate(),
                    inDomain: "yes" as unknown as boolean,
                    harmonicValid: 1 as unknown as boolean,
                },
            })
        );
        expect(ctx.surrogate?.inDomain).toBeNull();
        expect(ctx.surrogate?.harmonicValid).toBeNull();
        const strict = buildAgentContext(
            snapshot({
                surrogate: { ...maximalSurrogate(), inDomain: false, harmonicValid: true },
            })
        );
        expect(strict.surrogate?.inDomain).toBe(false);
        expect(strict.surrogate?.harmonicValid).toBe(true);
    });

    it("truncates long surrogate labels and keeps JSON under budget with a maximal block", () => {
        const ctx = buildAgentContext(snapshot({ surrogate: maximalSurrogate() }));
        expect(ctx.surrogate).not.toBeNull();
        expect(ctx.surrogate!.path.length).toBeLessThanOrEqual(40);
        expect(ctx.surrogate!.honestyState.length).toBeLessThanOrEqual(32);
        expect(ctx.surrogate!.weightsVersion.length).toBeLessThanOrEqual(40);
        expect(ctx.surrogate!.runId).not.toBeNull();
        expect(ctx.surrogate!.runId!.length).toBeLessThanOrEqual(40);
        expect(ctx.surrogate!.domainReason).not.toBeNull();
        expect(ctx.surrogate!.domainReason!.length).toBeLessThanOrEqual(140);
        expect(ctx.surrogate!.harmonicInvalidReason!.length).toBeLessThanOrEqual(140);
        const json = JSON.stringify(ctx);
        expect(json.length).toBeLessThanOrEqual(3500);
        expect(json).not.toContain("Float32Array");
    });

    it("trims and caps the caseKey at 80 chars, null when blank", () => {
        const long = `  ${"k".repeat(200)}  `;
        const capped = buildAgentContext(snapshot({ caseKey: long }));
        expect(capped.caseKey).not.toBeNull();
        expect(capped.caseKey!.length).toBeLessThanOrEqual(80);
        expect(capped.caseKey).toBe("k".repeat(80));
        expect(buildAgentContext(snapshot({ caseKey: "   " })).caseKey).toBeNull();
        expect(buildAgentContext(snapshot()).caseKey).toBeNull();
    });

    it("treats frameSettled as strict true only", () => {
        expect(buildAgentContext(snapshot({ frameSettled: true })).frameSettled).toBe(true);
        expect(buildAgentContext(snapshot()).frameSettled).toBe(false);
        expect(
            buildAgentContext(snapshot({ frameSettled: 1 as unknown as boolean })).frameSettled
        ).toBe(false);
        expect(
            buildAgentContext(snapshot({ frameSettled: "true" as unknown as boolean })).frameSettled
        ).toBe(false);
    });

    it("nulls out-of-range validityProbability instead of quoting it", () => {
        const high = buildAgentContext(snapshot({ surrogate: { validityProbability: 42 } }));
        expect(high.surrogate?.validityProbability).toBeNull();
        const negative = buildAgentContext(snapshot({ surrogate: { validityProbability: -1 } }));
        expect(negative.surrogate?.validityProbability).toBeNull();
        const aboveOne = buildAgentContext(snapshot({ surrogate: { validityProbability: 1.5 } }));
        expect(aboveOne.surrogate?.validityProbability).toBeNull();
        const nonFinite = buildAgentContext(snapshot({ surrogate: { validityProbability: Number.NaN } }));
        expect(nonFinite.surrogate?.validityProbability).toBeNull();
        const zero = buildAgentContext(snapshot({ surrogate: { validityProbability: 0 } }));
        expect(zero.surrogate?.validityProbability).toBe(0);
        const one = buildAgentContext(snapshot({ surrogate: { validityProbability: 1 } }));
        expect(one.surrogate?.validityProbability).toBe(1);
        const mid = buildAgentContext(snapshot({ surrogate: { validityProbability: 0.9 } }));
        expect(mid.surrogate?.validityProbability).toBeCloseTo(0.9, 5);
    });
});
