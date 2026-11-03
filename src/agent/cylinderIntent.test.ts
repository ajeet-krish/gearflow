// Cylinder radius intent tests. Pure, zero network. Covers radius
// phrasing, diameter halving, envelope clamps, Re coupling, question and
// negation guards, and the validated set_spec envelope.

import { describe, expect, it } from "vitest";
import { buildCylinderEnvelope, parseCylinderIntent } from "./cylinderIntent";
import { validateAgentAction, type AgentValidationContext } from "./agentActions";

const CTX: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, agentFirst: false };

describe("parseCylinderIntent", () => {
    it("parses an explicit radius with Re", () => {
        const out = parseCylinderIntent("show me a cylinder with radius 0.35 at Re 1000", null);
        expect(out?.kind).toBe("apply");
        expect(out?.radius).toBeCloseTo(0.35, 6);
        expect(out?.reynolds).toBe(1000);
        expect(out?.confidence ?? 0).toBeGreaterThanOrEqual(0.9);
    });

    it("halves diameter phrasing into radius", () => {
        const out = parseCylinderIntent("set up a cylinder with diameter 0.5", null);
        expect(out?.radius).toBeCloseTo(0.25, 6);
        expect(out?.notes.join(" ")).toContain("halves");
    });

    it("clamps out of envelope radii with a note", () => {
        const out = parseCylinderIntent("show a cylinder with radius 5", null);
        expect(out?.radius).toBe(1);
        expect(out?.notes.join(" ")).toContain("clamped");
    });

    it("returns null with no size, on questions, and on negation", () => {
        expect(parseCylinderIntent("show me a cylinder", null)).toBeNull();
        expect(parseCylinderIntent("what is a cylinder", null)).toBeNull();
        expect(parseCylinderIntent("do not show a cylinder", null)).toBeNull();
    });

    it("builds a validated set_spec envelope carrying radius plus Re", () => {
        const apply = parseCylinderIntent("show me a cylinder with radius 0.3 at Re 2000", null);
        expect(apply).not.toBeNull();
        const built = buildCylinderEnvelope(apply!, null);
        expect(built.candidates).toHaveLength(1);
        const checked = validateAgentAction(built.candidates[0], CTX);
        expect(checked.ok).toBe(true);
        expect(JSON.stringify(built.candidates[0])).toContain("0.3");
        expect(built.reply).toContain("radius 0.3");
        expect(built.reply).toContain("Re");
    });
});
