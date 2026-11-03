// P4 curriculum tests: static lessons plus end to end prompts. Pure, offline.

import { describe, expect, it } from "vitest";
import { CURRICULUM_CHIPS } from "./curriculum";
import { localReply } from "./localAssistant";
import type { AgentContext } from "./agentContext";

const FIELD_TOKENS = ["speed", "cp", "omega", "u", "v", "k", "recirc"];

function makeCtx(): AgentContext {
    return {
        spec: { kind: "naca4", alphaDeg: 6, reynolds: 50000, naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 } },
        reynolds: 50000,
        regime: "attached laminar",
        bodyLabel: "NACA 2412",
        alphaDeg: 6,
        backend: "analytic",
        engine: "analytic",
        gridLabel: "grid 128",
        cl: 0.6,
        cpMin: -1.2,
        lbm: { status: "idle", hasSnapshot: false, effective: false, statsReady: false, stats: null },
        field: { variable: "speed", effective: "speed", hasTke: false, hasRecirc: false },
        validation: { pass: 1, warn: 0, fail: 0, info: 0 },
        provenanceLabel: "analytic",
        offline: true,
        honesty: [],
        neural: {
            available: false,
            envelope: "provisional neural envelope",
            path: "analytic",
        },
    };
}

describe("CURRICULUM_CHIPS", () => {
    it("carries the three static lessons with concept plus field", () => {
        const ids = CURRICULUM_CHIPS.map((c) => c.id);
        expect(ids).toEqual(["airfoil-lesson", "stall-demo", "re-effect"]);
        for (const chip of CURRICULUM_CHIPS) {
            expect(chip.label.length).toBeGreaterThan(0);
            expect(chip.prompt.length).toBeGreaterThan(0);
            expect(chip.concept.length).toBeGreaterThan(0);
            expect(FIELD_TOKENS).toContain(chip.suggestedField);
        }
    });
    it("every chip prompt runs end to end via localAssistant with no throw", () => {
        for (const chip of CURRICULUM_CHIPS) {
            let reply = "";
            expect(() => {
                reply = localReply(chip.prompt, makeCtx()).reply;
            }).not.toThrow();
            expect(reply.length).toBeGreaterThan(0);
            expect(reply.toLowerCase()).toContain("local");
        }
    });
});
