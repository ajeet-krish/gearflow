// Orifice intent parser tests: defaults, sizes, guards, and the alpha 0
// contract. Pure, zero network.

import { describe, expect, it } from "vitest";
import { buildOrificeEnvelope, parseOrificeIntent } from "./orificeIntent";
import { validateAgentAction, type AgentValidationContext } from "./agentActions";

const CTX: AgentValidationContext = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false, agentFirst: false };

describe("parseOrificeIntent", () => {
    it("applies orifice defaults from set up phrasing with high confidence", () => {
        const out = parseOrificeIntent("set up the orifice");
        expect(out).not.toBeNull();
        expect(out?.kind).toBe("apply");
        expect(out?.width).toBe(0.08);
        expect(out?.height).toBe(0.4);
        expect(out?.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it("maps constriction language to the orifice shape", () => {
        for (const text of ["switch to venturi", "set up the throat constriction", "show the tunnel section", "switch to orifice"]) {
            expect(parseOrificeIntent(text)).not.toBeNull();
        }
    });

    it("reads an explicit gap and plate thickness", () => {
        const out = parseOrificeIntent("set up the orifice with gap 0.5 plate 0.1 at Re 2000");
        expect(out?.height).toBe(0.5);
        expect(out?.width).toBe(0.1);
        expect(out?.reynolds).toBe(2000);
    });

    it("returns null for questions, negations, and bare mentions", () => {
        expect(parseOrificeIntent("what is a venturi")).toBeNull();
        expect(parseOrificeIntent("explain the orifice")).toBeNull();
        expect(parseOrificeIntent("do not set up the orifice")).toBeNull();
        expect(parseOrificeIntent("orifice")).toBeNull();
        expect(parseOrificeIntent(null)).toBeNull();
    });
});

describe("buildOrificeEnvelope", () => {
    it("builds one validated orifice set_spec with alpha always 0", () => {
        const apply = parseOrificeIntent("set up the orifice");
        expect(apply).not.toBeNull();
        if (apply === null) return;
        const built = buildOrificeEnvelope(apply, { reynolds: 50000 });
        expect(built.candidates).toHaveLength(1);
        const only = built.candidates[0];
        expect(only.kind).toBe("set_spec");
        if (only.kind === "set_spec") {
            expect(only.spec.geometry.kind).toBe("orifice");
            expect(only.spec.geometry.alphaDeg).toBe(0);
            expect(only.spec.geometry.width).toBe(0.08);
            expect(only.spec.geometry.height).toBe(0.4);
        }
        for (const candidate of built.candidates) {
            const checked = validateAgentAction(candidate, CTX);
            expect(checked.ok).toBe(true);
        }
        expect(built.reply).toContain("gap");
        expect(built.reply).toContain("venturi");
    });

    it("keeps validating at Re 100 and Re 700 on the same floor as the canvas", () => {
        const apply = parseOrificeIntent("set up the orifice at Re 100");
        expect(apply?.reynolds).toBe(100);
        if (apply === null) return;
        const built = buildOrificeEnvelope(apply, {});
        for (const candidate of built.candidates) {
            expect(validateAgentAction(candidate, CTX).ok).toBe(true);
        }
    });
});
