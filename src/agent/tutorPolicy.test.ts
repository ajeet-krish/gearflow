// Phase T1 tutor policy tests: one concept per trigger plus physics-only
// copy for every concept. Pure, zero network.

import { describe, expect, it } from "vitest";
import { detectConcept, fieldForConcept, localTutorReply, type TutorConcept } from "./tutorPolicy";

describe("detectConcept", () => {
    const cases: Array<{ name: string; input: Record<string, unknown>; want: TutorConcept }> = [
        { name: "stall on regime", input: { regime: "stall, separated", alphaDeg: 6 }, want: "stall-separation" },
        { name: "stall on high alpha", input: { regime: "laminar", alphaDeg: 14 }, want: "stall-separation" },
        { name: "shedding on words", input: { regime: "karman shedding street" }, want: "karman-shedding" },
        { name: "turbulent on recirc", input: { regime: "laminar", recircFraction: 0.3 }, want: "turbulent-wake" },
        { name: "turbulent on tke", input: { regime: "laminar", tkePeak: 0.05 }, want: "turbulent-wake" },
        { name: "stagnation on block body", input: { regime: "laminar", bodyLabel: "block" }, want: "stagnation" },
        { name: "stagnation on words", input: { regime: "stagnation at the nose" }, want: "stagnation" },
        { name: "suction on deep cp", input: { regime: "laminar", cpMin: -3.1 }, want: "suction-peak" },
        { name: "attached on regime", input: { regime: "laminar, attached", alphaDeg: 6 }, want: "attached-lift" },
        { name: "general fallback", input: {}, want: "general" },
        { name: "general on null", input: {}, want: "general" },
        { name: "strouhal alone stays general", input: { regime: "laminar", strouhal: 0.2 }, want: "general" },
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
    it("stays neutral physics-only for every concept, never omega", () => {
        expect(fieldForConcept("stall-separation")).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("karman-shedding")).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("suction-peak")).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("turbulent-wake", { tkeReady: true })).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("turbulent-wake", { recircReady: true })).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("turbulent-wake")).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("stagnation")).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("attached-lift", { current: "omega" })).toEqual({ primary: "speed", secondary: "cp" });
        expect(fieldForConcept("general", { current: "u" })).toEqual({ primary: "speed", secondary: "cp" });
    });
});

describe("localTutorReply", () => {
    it("keeps the physics-only explanation plus table plus try next shape", () => {
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
        expect(reply).toContain("0.721");
        expect(reply).toContain("lift coefficient (Cl)");
        expect(reply).not.toContain("Caveat:");
        expect(reply).not.toContain("Suggested view");
        expect(reply).not.toContain("omega");
        expect(reply).not.toContain("LBM");
        expect(reply).not.toContain("Press Run");
    });

    it("never throws on null snapshots", () => {
        expect(() => localTutorReply(null, null)).not.toThrow();
        expect(localTutorReply(null, null)).toContain("Try next:");
    });

    it("keeps fresh attached and general frames physics-only with no field views", () => {
        const attached = localTutorReply(
            {
                caseKey: "naca4|a6|Re50000|analytic|fspeed",
                bodyLabel: "NACA 2412",
                alpha: 6,
                reynolds: 50000,
                cl: 0.654,
                cpMin: -1.2,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
            {
                caseKey: "naca4|a6|Re50000|analytic|fspeed",
                bodyLabel: "NACA 2412",
                alpha: 6,
                reynolds: 50000,
                cl: 0.654,
                cpMin: -1.2,
                regime: "laminar, attached",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
        );
        expect(attached).not.toContain("Suggested view");
        expect(attached).not.toMatch(/omega/);
    });

    it("reaches suction-peak from a deep CpMin with physics-only try next", () => {
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
        expect(reply).toContain("angle of attack (alpha) by 1 deg");
    });

    it("keeps stall and turbulence experiments physics-only with no run or field copy", () => {
        const stall = localTutorReply(
            {
                caseKey: "a",
                bodyLabel: "NACA 2412",
                alpha: 14,
                reynolds: 50000,
                cl: 0.9,
                cpMin: -1.2,
                regime: "stall, separated",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
            {
                caseKey: "b",
                bodyLabel: "NACA 2412",
                alpha: 14,
                reynolds: 50000,
                cl: 0.9,
                cpMin: -1.2,
                regime: "stall, separated",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
        );
        expect(stall).toContain("Try next:");
        expect(stall).toContain("potential flow picture omits separation and stall");
        expect(stall).not.toContain("Press Run");
        expect(stall).not.toContain("LBM");
        expect(stall).not.toContain("omega");
        const wake = localTutorReply(
            {
                caseKey: "a",
                bodyLabel: "cylinder",
                alpha: 0,
                reynolds: 700,
                cl: 0.1,
                cpMin: -1.2,
                regime: "turbulent wake",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
            {
                caseKey: "b",
                bodyLabel: "cylinder",
                alpha: 0,
                reynolds: 700,
                cl: 0.1,
                cpMin: -1.2,
                regime: "turbulent wake",
                pathLabel: "analytic potential flow, not validated",
                strouhal: null,
            },
        );
        expect(wake).toContain("Try next:");
        expect(wake).not.toContain("Press Run");
        expect(wake).not.toContain("LBM");
        expect(wake).not.toContain("omega");
    });
});
