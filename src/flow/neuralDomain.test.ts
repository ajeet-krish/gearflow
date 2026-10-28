// neuralDomain tests: provisional envelope shape, boundary classification,
// and the provisional flag. No network, pure logic only.

import { describe, expect, it } from "vitest";
import { classifyNeuralDomain, PROVISIONAL_NEURAL_ENVELOPE } from "@/flow/neuralDomain";

describe("provisional neural envelope", () => {
    it("covers the six named bodies and excludes custom", () => {
        expect([...PROVISIONAL_NEURAL_ENVELOPE.kinds].sort()).toEqual(
            ["block", "cylinder", "naca0012", "naca2412", "naca4412", "orifice"].sort(),
        );
        expect(PROVISIONAL_NEURAL_ENVELOPE.customAllowed).toBe(false);
        expect(PROVISIONAL_NEURAL_ENVELOPE.kinds).not.toContain("custom");
    });

    it("spans alpha -4 to 12 deg and Re 20 to 2000 with no run yet", () => {
        expect(PROVISIONAL_NEURAL_ENVELOPE.alphaMin).toBe(-4);
        expect(PROVISIONAL_NEURAL_ENVELOPE.alphaMax).toBe(12);
        expect(PROVISIONAL_NEURAL_ENVELOPE.reMin).toBe(20);
        expect(PROVISIONAL_NEURAL_ENVELOPE.reMax).toBe(2000);
        expect(PROVISIONAL_NEURAL_ENVELOPE.runId).toBeNull();
    });

    it("is marked provisional with an honesty note", () => {
        expect(PROVISIONAL_NEURAL_ENVELOPE.provisional).toBe(true);
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.length).toBeGreaterThan(0);
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("provisional");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("planned coverage");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("no weights");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note).toContain("Re 500");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("unvalidated");
    });
});

describe("classifyNeuralDomain", () => {
    it("accepts interior cases on every covered body", () => {
        for (const kind of PROVISIONAL_NEURAL_ENVELOPE.kinds) {
            const verdict = classifyNeuralDomain(kind, 6, 1000);
            expect(verdict.inDomain).toBe(true);
            expect(verdict.reason).toBeNull();
            expect(verdict.provisional).toBe(true);
        }
    });

    it("accepts the exact alpha and Re boundaries", () => {
        expect(classifyNeuralDomain("naca2412", -4, 20).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca2412", 12, 2000).inDomain).toBe(true);
        expect(classifyNeuralDomain("orifice", 0, 1000).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca4412", 6, 2000).inDomain).toBe(true);
    });

    it("rejects just outside each boundary with the honest range", () => {
        const lowAlpha = classifyNeuralDomain("naca2412", -4.5, 1000);
        expect(lowAlpha.inDomain).toBe(false);
        expect(lowAlpha.reason).toContain("-4");
        const highAlpha = classifyNeuralDomain("naca2412", 12.5, 1000);
        expect(highAlpha.inDomain).toBe(false);
        expect(highAlpha.reason).toContain("12");
        const lowRe = classifyNeuralDomain("naca2412", 6, 19);
        expect(lowRe.inDomain).toBe(false);
        expect(lowRe.reason).toContain("20");
        const highRe = classifyNeuralDomain("naca2412", 6, 2001);
        expect(highRe.inDomain).toBe(false);
        expect(highRe.reason).toContain("2000");
    });

    it("rejects custom and unknown bodies", () => {
        for (const kind of ["custom", "duct", "plate", "unknown"]) {
            const verdict = classifyNeuralDomain(kind, 0, 1000);
            expect(verdict.inDomain).toBe(false);
            expect(verdict.reason).toContain(kind);
        }
    });

    it("keeps duct out of domain as an unknown body while naca4412 stays in", () => {
        const duct = classifyNeuralDomain("duct", 0, 1000);
        expect(duct.inDomain).toBe(false);
        expect(duct.reason ?? "").toContain("duct");
        expect(classifyNeuralDomain("naca4412", -4, 20).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca4412", 12, 2000).inDomain).toBe(true);
    });

    it("rejects non-finite alpha and Re", () => {
        expect(classifyNeuralDomain("cylinder", Number.NaN, 1000).inDomain).toBe(false);
        expect(classifyNeuralDomain("cylinder", 0, Number.POSITIVE_INFINITY).inDomain).toBe(false);
    });

    it("keeps the provisional flag on failures too", () => {
        const verdict = classifyNeuralDomain("custom", 45, 5);
        expect(verdict.inDomain).toBe(false);
        expect(verdict.provisional).toBe(true);
        expect(verdict.reason).not.toBeNull();
    });

    it("rejects a custom kind listed in kinds when customAllowed is false", () => {
        const envelope = { ...PROVISIONAL_NEURAL_ENVELOPE, kinds: [...PROVISIONAL_NEURAL_ENVELOPE.kinds, "custom" as const] };
        const verdict = classifyNeuralDomain("custom", 0, 1000, envelope);
        expect(verdict.inDomain).toBe(false);
        expect(verdict.reason ?? "").toContain("customAllowed");
    });

    it("accepts a listed custom kind only when customAllowed is true", () => {
        const envelope = {
            ...PROVISIONAL_NEURAL_ENVELOPE,
            kinds: [...PROVISIONAL_NEURAL_ENVELOPE.kinds, "custom" as const],
            customAllowed: true as const,
        };
        const verdict = classifyNeuralDomain("custom", 0, 1000, envelope);
        expect(verdict.inDomain).toBe(true);
        expect(verdict.reason).toBeNull();
    });
});
