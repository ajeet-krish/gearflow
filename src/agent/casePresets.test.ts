// casePresets tests: atomic expansion of the three presets plus honest
// rejection reasons and the provisional domain precheck. No network,
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

    it("carries a null domain note because Re 100 sits inside the envelope", () => {
        const result = expandCasePreset({ preset: "shedding" });
        expect(result.domainNote).toBeNull();
    });
});

describe("expandCasePreset high_pressure", () => {
    it("defaults to orifice at alpha 0 Re 1000 cp field", () => {
        const result = expandCasePreset({ preset: "high_pressure" });
        expect(result.ok).toBe(true);
        expect(result.actions).toEqual([
            { kind: "set_body", body: "orifice" },
            { kind: "set_alpha", alphaDeg: 0 },
            { kind: "set_reynolds", reynolds: 1000 },
            { kind: "set_field", field: "cp" },
        ]);
        expect(result.domainNote).toBeNull();
    });

    it("accepts block when requested", () => {
        const result = expandCasePreset({ preset: "high_pressure", body: "block" });
        expect(result.ok).toBe(true);
        expect(result.actions[0]).toEqual({ kind: "set_body", body: "block" });
    });

    it("rejects other bodies atomically with the allowed list", () => {
        const result = expandCasePreset({ preset: "high_pressure", body: "cylinder" });
        expect(result.ok).toBe(false);
        expect(result.actions).toEqual([]);
        expect(result.reason).toContain("orifice");
        expect(result.reason).toContain("block");
    });
});

describe("expandCasePreset airfoil", () => {
    it("defaults to 2412 at alpha 6 Re 2000 speed field", () => {
        const result = expandCasePreset({ preset: "airfoil" });
        expect(result.ok).toBe(true);
        expect(result.actions).toEqual([
            { kind: "set_body", body: "naca2412" },
            { kind: "set_alpha", alphaDeg: 6 },
            { kind: "set_reynolds", reynolds: 2000 },
            { kind: "set_field", field: "speed" },
        ]);
        expect(result.domainNote).toBeNull();
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
