// casePresets tests: atomic expansion of the presets plus honest
// rejection reasons and the backend domain note. No network,
// no DOM, pure logic only.

import { describe, expect, it } from "vitest";
import { expandCasePreset } from "@/agent/casePresets";

describe("expandCasePreset shedding", () => {
    it("sits inside the envelope at cylinder alpha 0 Re 100 speed field", () => {
        const result = expandCasePreset({ preset: "shedding" });
        expect(result.ok).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.actions).toEqual([
            { kind: "set_body", body: "cylinder" },
            { kind: "set_alpha", alphaDeg: 0 },
            { kind: "set_reynolds", reynolds: 100 },
            { kind: "set_field", field: "speed" },
        ]);
    });

    it("carries a backend note naming LBM and solved", () => {
        const result = expandCasePreset({ preset: "shedding" });
        expect(result.domainNote).not.toBeNull();
        expect(result.domainNote ?? "").toContain("LBM");
        expect(result.domainNote ?? "").toContain("solved");
    });
});

describe("expandCasePreset high_pressure", () => {
    it("returns ok false with an honest divergence reason and no actions", () => {
        const result = expandCasePreset({ preset: "high_pressure" });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason ?? "").toContain("diverges at every tested gap and Re");
        expect(result.reason ?? "").toContain("Re 700");
        expect(result.domainNote).toBeNull();
    });

    it("offers the high Re cylinder wake as the nearest alternative", () => {
        const result = expandCasePreset({ preset: "high_pressure" });
        expect(result.ok).toBe(false);
        expect(result.reason ?? "").toContain("setup_high_re_wake");
        expect(result.reason ?? "").toContain("cylinder");
    });

    it("fails for block too, never returning partial actions", () => {
        const result = expandCasePreset({ preset: "high_pressure", body: "block" });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason ?? "").toContain("diverges");
    });
});

describe("expandCasePreset high_re_wake", () => {
    it("expands to a validated cylinder Re 700 speed field", () => {
        const result = expandCasePreset({ preset: "high_re_wake" });
        expect(result.ok).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.actions).toEqual([
            { kind: "set_body", body: "cylinder" },
            { kind: "set_alpha", alphaDeg: 0 },
            { kind: "set_reynolds", reynolds: 700 },
            { kind: "set_field", field: "speed" },
        ]);
    });

    it("carries a backend note naming LBM and modeled coarse LES", () => {
        const result = expandCasePreset({ preset: "high_re_wake" });
        expect(result.domainNote ?? "").toContain("LBM");
        expect(result.domainNote ?? "").toContain("modeled");
        expect(result.domainNote ?? "").toContain("700");
    });
});

describe("expandCasePreset airfoil", () => {
    it("defaults to 2412 at alpha 6 Re 1200 speed field", () => {
        const result = expandCasePreset({ preset: "airfoil" });
        expect(result.ok).toBe(true);
        expect(result.actions).toEqual([
            { kind: "set_body", body: "naca2412" },
            { kind: "set_alpha", alphaDeg: 6 },
            { kind: "set_reynolds", reynolds: 1200 },
            { kind: "set_field", field: "speed" },
        ]);
        expect(result.domainNote ?? "").toContain("LBM");
        expect(result.domainNote ?? "").toContain("modeled");
    });

    it("honors a named NACA body and a given alpha", () => {
        const result = expandCasePreset({ preset: "airfoil", body: "naca4412", alphaDeg: 2 });
        expect(result.ok).toBe(true);
        expect(result.actions[0]).toEqual({ kind: "set_body", body: "naca4412" });
        expect(result.actions[1]).toEqual({ kind: "set_alpha", alphaDeg: 2 });
    });

    it("rejects a bluff body for the airfoil preset with no partial actions", () => {
        const result = expandCasePreset({ preset: "airfoil", body: "cylinder" });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason).toContain("naca2412");
    });

    it("rejects an out of bounds alpha atomically", () => {
        const result = expandCasePreset({ preset: "airfoil", alphaDeg: 200 });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason).toContain("200");
    });

    it("rejects a non-finite alpha atomically", () => {
        const result = expandCasePreset({ preset: "airfoil", alphaDeg: Number.NaN });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason).toContain("finite");
    });

    it("rejects an unknown preset id", () => {
        const result = expandCasePreset({ preset: "stall" as never });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason).toContain("unknown case preset");
    });
});
