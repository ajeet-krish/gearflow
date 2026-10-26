// Unit tests for tier thresholds with known boundary values.

import { describe, it, expect } from "vitest";
import { TIER_TABLE, evaluateTier, isBlocking } from "./tiers";

describe("evaluateTier", () => {
    it("PASS tier reports pass, warn, fail across the bands", () => {
        expect(evaluateTier("PASS", 0.03, 0.05, 0.1)).toBe("pass");
        expect(evaluateTier("PASS", 0.05, 0.05, 0.1)).toBe("pass");
        expect(evaluateTier("PASS", 0.08, 0.05, 0.1)).toBe("warn");
        expect(evaluateTier("PASS", 0.2, 0.05, 0.1)).toBe("fail");
    });

    it("WARN tier never passes, it stays warn inside the band", () => {
        expect(evaluateTier("WARN", 0.0, 0.05, 0.2)).toBe("warn");
        expect(evaluateTier("WARN", 0.15, 0.05, 0.2)).toBe("warn");
        expect(evaluateTier("WARN", 0.5, 0.05, 0.2)).toBe("fail");
    });

    it("INFO tier always reports info", () => {
        expect(evaluateTier("INFO", 0.0, 0.05, 0.1)).toBe("info");
        expect(evaluateTier("INFO", 99.0, 0.05, 0.1)).toBe("info");
    });

    it("defaults the review band to twice the pass tolerance", () => {
        expect(evaluateTier("PASS", 0.09, 0.05)).toBe("warn");
        expect(evaluateTier("PASS", 0.11, 0.05)).toBe("fail");
    });

    it("rejects bad inputs", () => {
        expect(() => evaluateTier("PASS", Number.NaN, 0.05)).toThrow();
        expect(() => evaluateTier("PASS", -1, 0.05)).toThrow();
    });
});

describe("isBlocking", () => {
    it("only PASS tier failures block the demo", () => {
        expect(isBlocking("PASS", "fail")).toBe(true);
        expect(isBlocking("PASS", "warn")).toBe(false);
        expect(isBlocking("PASS", "pass")).toBe(false);
        expect(isBlocking("WARN", "fail")).toBe(false);
        expect(isBlocking("INFO", "info")).toBe(false);
    });
});

describe("TIER_TABLE", () => {
    it("pins the architecture thresholds", () => {
        expect(TIER_TABLE.clAbsolute.passTol).toBe(0.05);
        expect(TIER_TABLE.cpStagnation.passTol).toBe(0.05);
        expect(TIER_TABLE.cpShoulder.passTol).toBe(0.05);
        expect(TIER_TABLE.alphaZero.passTol).toBe(0.25);
        expect(TIER_TABLE.clSlopeRelative.passTol).toBe(0.05);
    });
});
