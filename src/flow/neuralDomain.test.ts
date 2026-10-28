// neuralDomain tests: provisional envelope shape, per body boundary
// classification, and the provisional flag. No network, pure logic only.

import { describe, expect, it } from "vitest";
import { classifyNeuralDomain, PROVISIONAL_NEURAL_ENVELOPE } from "@/flow/neuralDomain";

describe("provisional neural envelope", () => {
    it("covers the five measured bodies and excludes orifice, duct, and custom", () => {
        expect([...PROVISIONAL_NEURAL_ENVELOPE.kinds].sort()).toEqual(
            ["block", "cylinder", "naca0012", "naca2412", "naca4412"].sort(),
        );
        expect(PROVISIONAL_NEURAL_ENVELOPE.customAllowed).toBe(false);
        expect(PROVISIONAL_NEURAL_ENVELOPE.kinds).not.toContain("custom");
        expect(PROVISIONAL_NEURAL_ENVELOPE.kinds).not.toContain("orifice");
        expect(PROVISIONAL_NEURAL_ENVELOPE.kinds).not.toContain("duct");
    });

    it("spans alpha -4 to 8 deg and flat Re 20 to 1200 as the union with no run yet", () => {
        expect(PROVISIONAL_NEURAL_ENVELOPE.alphaMin).toBe(-4);
        expect(PROVISIONAL_NEURAL_ENVELOPE.alphaMax).toBe(8);
        expect(PROVISIONAL_NEURAL_ENVELOPE.reMin).toBe(20);
        expect(PROVISIONAL_NEURAL_ENVELOPE.reMax).toBe(1200);
        expect(PROVISIONAL_NEURAL_ENVELOPE.runId).toBeNull();
    });

    it("lists per body Re ranges from measured solver reality", () => {
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.cylinder).toEqual({ min: 20, max: 700 });
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.block).toEqual({ min: 20, max: 400 });
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.naca0012).toEqual({ min: 100, max: 1200 });
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.naca2412).toEqual({ min: 100, max: 1200 });
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.naca4412).toEqual({ min: 100, max: 1200 });
        expect(PROVISIONAL_NEURAL_ENVELOPE.reByKind.custom).toBeUndefined();
    });

    it("is marked provisional with an honesty note", () => {
        expect(PROVISIONAL_NEURAL_ENVELOPE.provisional).toBe(true);
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.length).toBeGreaterThan(0);
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("provisional");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("planned coverage");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("no weights");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note).toContain("Re 500");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("modeled");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("not solved");
        expect(PROVISIONAL_NEURAL_ENVELOPE.note.toLowerCase()).toContain("unvalidated");
    });
});

describe("classifyNeuralDomain", () => {
    it("accepts interior cases on every covered body", () => {
        const interior: Array<[string, number, number]> = [
            ["naca0012", 6, 1000],
            ["naca2412", 6, 1000],
            ["naca4412", 6, 1000],
            ["cylinder", 0, 100],
            ["block", 0, 100],
        ];
        for (const [kind, alpha, re] of interior) {
            const verdict = classifyNeuralDomain(kind, alpha, re);
            expect(verdict.inDomain).toBe(true);
            expect(verdict.reason).toBeNull();
            expect(verdict.provisional).toBe(true);
        }
    });

    it("accepts the exact per kind boundaries", () => {
        expect(classifyNeuralDomain("cylinder", 0, 20).inDomain).toBe(true);
        expect(classifyNeuralDomain("cylinder", 0, 700).inDomain).toBe(true);
        expect(classifyNeuralDomain("block", 0, 20).inDomain).toBe(true);
        expect(classifyNeuralDomain("block", 0, 400).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca2412", -4, 100).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca2412", 8, 1200).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca4412", 6, 1200).inDomain).toBe(true);
    });

    it("rejects cylinder 900 and block 500 while airfoil 1200 stays in", () => {
        expect(classifyNeuralDomain("cylinder", 0, 900).inDomain).toBe(false);
        expect(classifyNeuralDomain("block", 0, 500).inDomain).toBe(false);
        expect(classifyNeuralDomain("naca2412", 6, 1200).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca4412", 8, 1200).inDomain).toBe(true);
    });

    it("rejects airfoil alpha 12 as outside the 8 deg bound", () => {
        const verdict = classifyNeuralDomain("naca2412", 12, 1000);
        expect(verdict.inDomain).toBe(false);
        expect(verdict.reason ?? "").toContain("8");
    });

    it("rejects just outside each boundary with the honest range", () => {
        const lowAlpha = classifyNeuralDomain("naca2412", -4.5, 1000);
        expect(lowAlpha.inDomain).toBe(false);
        expect(lowAlpha.reason).toContain("-4");
        const highAlpha = classifyNeuralDomain("naca2412", 8.5, 1000);
        expect(highAlpha.inDomain).toBe(false);
        expect(highAlpha.reason).toContain("8");
        const lowRe = classifyNeuralDomain("cylinder", 0, 19);
        expect(lowRe.inDomain).toBe(false);
        expect(lowRe.reason).toContain("20");
        const highRe = classifyNeuralDomain("cylinder", 0, 701);
        expect(highRe.inDomain).toBe(false);
        expect(highRe.reason).toContain("700");
    });

    it("names the violated bound and the nearest valid Re", () => {
        const cyl = classifyNeuralDomain("cylinder", 0, 900);
        expect(cyl.inDomain).toBe(false);
        expect(cyl.reason ?? "").toContain("700");
        expect(cyl.reason ?? "").toContain("nearest cylinder Re 700");
        const block = classifyNeuralDomain("block", 0, 500);
        expect(block.inDomain).toBe(false);
        expect(block.reason ?? "").toContain("400");
        expect(block.reason ?? "").toContain("nearest block Re 400");
        const low = classifyNeuralDomain("cylinder", 0, 19);
        expect(low.reason ?? "").toContain("nearest cylinder Re 20");
    });

    it("rejects custom, orifice, duct, and unknown bodies", () => {
        for (const kind of ["custom", "orifice", "duct", "plate", "unknown"]) {
            const verdict = classifyNeuralDomain(kind, 0, 1000);
            expect(verdict.inDomain).toBe(false);
            expect(verdict.reason).toContain(kind);
        }
    });

    it("keeps duct out of domain as an unknown body while naca4412 stays in", () => {
        const duct = classifyNeuralDomain("duct", 0, 1000);
        expect(duct.inDomain).toBe(false);
        expect(duct.reason ?? "").toContain("duct");
        expect(classifyNeuralDomain("naca4412", -4, 100).inDomain).toBe(true);
        expect(classifyNeuralDomain("naca4412", 8, 1200).inDomain).toBe(true);
    });

    it("rejects non-finite alpha and Re", () => {
        expect(classifyNeuralDomain("cylinder", Number.NaN, 100).inDomain).toBe(false);
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
        const verdict = classifyNeuralDomain("custom", 0, 100, envelope);
        expect(verdict.inDomain).toBe(false);
        expect(verdict.reason ?? "").toContain("customAllowed");
    });

    it("accepts a listed custom kind only when customAllowed is true", () => {
        const envelope = {
            ...PROVISIONAL_NEURAL_ENVELOPE,
            kinds: [...PROVISIONAL_NEURAL_ENVELOPE.kinds, "custom" as const],
            customAllowed: true as const,
        };
        const verdict = classifyNeuralDomain("custom", 0, 100, envelope);
        expect(verdict.inDomain).toBe(true);
        expect(verdict.reason).toBeNull();
    });
});
