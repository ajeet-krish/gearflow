// Phase T1 tutor policy tests: one concept per trigger plus the field
// pair for every concept. Pure, zero network.

import { describe, expect, it } from "vitest";
import { detectConcept, fieldForConcept, localTutorReply, type TutorConcept } from "./tutorPolicy";

describe("detectConcept", () => {
    const cases: Array<{ name: string; input: Record<string, unknown>; want: TutorConcept }> = [
        { name: "stall on regime", input: { regime: "stall, separated", alphaDeg: 6 }, want: "stall-separation" },
        { name: "stall on high alpha", input: { regime: "laminar", alphaDeg: 14 }, want: "stall-separation" },
        { name: "shedding on strouhal", input: { regime: "laminar", strouhal: 0.2 }, want: "karman-shedding" },
        { name: "shedding on words", input: { regime: "karman shedding street" }, want: "karman-shedding" },
        { name: "turbulent on recirc", input: { regime: "laminar", recircFraction: 0.3 }, want: "turbulent-wake" },
        { name: "turbulent on tke", input: { regime: "laminar", tkePeak: 0.05 }, want: "turbulent-wake" },
        { name: "stagnation on block body", input: { regime: "laminar", bodyLabel: "block" }, want: "stagnation" },
        { name: "stagnation on words", input: { regime: "stagnation at the nose" }, want: "stagnation" },
        { name: "suction on deep cp", input: { regime: "laminar", cpMin: -3.1 }, want: "suction-peak" },
        { name: "attached on regime", input: { regime: "laminar, attached", alphaDeg: 6 }, want: "attached-lift" },
        { name: "general fallback", input: {}, want: "general" },
        { name: "general on null", input: {}, want: "general" },
    ];
    for (const c of cases) {
        it(`detects ${c.name}`, () => {
            expect(detectConcept(c.input)).toBe(c.want);
        });
    }

    it("returns general instead of throwing on null", () => {
        expect(detectConcept(null)).toBe("general");
        expect(detectConcept(undefined)).toBe("general");
    });
});

describe("fieldForConcept", () => {
    it("maps stall to omega with cp second", () => {
        expect(fieldForConcept("stall-separation")).toEqual({ primary: "omega", secondary: "cp" });
    });

    it("maps shedding to omega with speed second", () => {
        expect(fieldForConcept("karman-shedding")).toEqual({ primary: "omega", secondary: "speed" });
    });

    it("maps suction to cp with speed second", () => {
        expect(fieldForConcept("suction-peak")).toEqual({ primary: "cp", secondary: "speed" });
    });

    it("maps turbulence to k when ready else recirc else omega", () => {
        expect(fieldForConcept("turbulent-wake", { tkeReady: true })).toEqual({ primary: "k", secondary: "omega" });
        expect(fieldForConcept("turbulent-wake", { recircReady: true })).toEqual({ primary: "recirc", secondary: "omega" });
        expect(fieldForConcept("turbulent-wake")).toEqual({ primary: "omega", secondary: "speed" });
    });

    it("maps stagnation to cp with speed second", () => {
        expect(fieldForConcept("stagnation")).toEqual({ primary: "cp", secondary: "speed" });
    });

    it("keeps the current field with the cp chip for attached and general", () => {
        expect(fieldForConcept("attached-lift", { current: "omega" })).toEqual({ primary: "omega", secondary: "cp" });
        expect(fieldForConcept("general", { current: "u" })).toEqual({ primary: "u", secondary: "cp" });
        expect(fieldForConcept("general")).toEqual({ primary: "speed", secondary: "cp" });
    });
});

describe("localTutorReply", () => {
    it("keeps the explanation plus table plus try next plus caveat shape", () => {
        const reply = localTutorReply(
            {
                caseKey: "a",
                bodyLabel: "NACA 2412",
                alpha: 6,
                reynolds: 50000,
                cl: 0.654,
                cpMin: -1.234,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
            {
                caseKey: "b",
                bodyLabel: "NACA 2412",
                alpha: 7,
                reynolds: 50000,
                cl: 0.721,
                cpMin: -1.4,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
        );
        expect(reply).toContain("Before vs after");
        expect(reply).toContain("Try next:");
        expect(reply).toContain("Caveat:");
        expect(reply).toContain("0.721");
        expect(reply).toContain("potential flow estimate");
    });

    it("never throws on null snapshots", () => {
        expect(() => localTutorReply(null, null)).not.toThrow();
        expect(localTutorReply(null, null)).toContain("Caveat:");
    });

    it("reaches suction-peak from a deep CpMin with a neutral regime", () => {
        const reply = localTutorReply(
            {
                caseKey: "a",
                bodyLabel: "NACA 2412",
                alpha: 6,
                reynolds: 50000,
                cl: 0.654,
                cpMin: -2.5,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
            {
                caseKey: "b",
                bodyLabel: "NACA 2412",
                alpha: 6,
                reynolds: 50000,
                cl: 0.7,
                cpMin: -2.4,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
        );
        expect(reply).toContain("Suction");
        expect(reply).toContain("suction peak on the cp view");
    });
});
