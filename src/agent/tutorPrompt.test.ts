// Phase T1 tutor prompt tests: version pin plus physics-only plain
// language clauses the Explain preset depends on. Pure, zero network.

import { describe, expect, it } from "vitest";
import { buildTutorMessages, physicsViewFor, TUTOR_MAX_WORDS, TUTOR_PROMPT_VERSION } from "./tutorPrompt";
import { buildTutorTable } from "./tutorTable";
import { buildAgentContext } from "./agentContext";

function rows() {
    return buildTutorTable(
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
}

describe("buildTutorMessages", () => {
    it("pins the tutor version and the simple language clauses", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "attached-lift",
            suggestion: { primary: "speed", secondary: "cp" },
            history: [],
        });
        expect(messages.length).toBeGreaterThanOrEqual(2);
        const system = messages[0].content;
        expect(TUTOR_PROMPT_VERSION).toBe("tutor-v4");
        expect(system).toContain("tutor-v4");
        expect(system).toContain("GearFlow flow tutor");
        expect(system).toContain("one idea per reply");
        expect(system).toContain("grade 8 to 10");
        expect(system).toContain("same sentence");
        expect(system).not.toContain("vorticity");
        expect(system).toContain("suction");
        expect(system).toContain("separation");
        // Live Modal port only: reasoning stays in reasoning_content and
        // never leaks into the final content.
        expect(system).toContain("reasoning_content");
        expect(system).toContain("Never put reasoning");
    });

    it("pins the physics-only clauses and the structure plus no-fence rule", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "suction-peak",
            suggestion: { primary: "cp", secondary: "speed" },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain("never invent numbers");
        expect(system).toContain("pending");
        expect(system).toContain("What changed");
        expect(system).toContain("Try next");
        expect(system).toContain(`${TUTOR_MAX_WORDS} words`);
        expect(system).toContain("no action fence");
        expect(system).toContain("lift coefficient (Cl)");
        expect(system).toContain("pressure coefficient (Cp)");
        expect(system).toContain("angle of attack (alpha)");
        expect(system).toContain("Reynolds number (Re)");
        expect(system).toContain("potential flow picture omits separation and stall");
        // No Misconception section: the chat path no longer detects or
        // teaches misconceptions, Try next stays physics-only.
        expect(system).not.toContain("Misconception");
        expect(system).not.toContain("No misconception spotted");
        expect(system).not.toContain("predicted, not validated");
        expect(system).not.toContain("may be called solved");
        expect(system).not.toContain("What to look at");
        expect(system).not.toContain("vorticity");
        expect(system).not.toContain("omega");
        expect(system).not.toContain("LBM");
        expect(system).not.toContain("Strouhal");
    });

    it("pins the orifice no-angle rule with gap-first copy", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "stagnation",
            suggestion: { primary: "speed", secondary: "cp" },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain("orifice");
        expect(system).toContain("has no angle");
        expect(system).toContain("gap opening");
    });

    it("pins the never-promise-a-run and rejection rules", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "attached-lift",
            suggestion: { primary: "speed", secondary: "cp" },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain("Never promise a future run or sweep the agent did not take");
        expect(system).toContain("teach no table for the unapplied case");
        expect(system).toContain("naming the bound");
        expect(system).toContain("nearest valid alternative");
    });

    it("carries the table numbers and the concept into the user message", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "attached-lift",
            suggestion: { primary: "speed", secondary: "cp" },
            history: [{ role: "user", text: "hello" }],
        });
        const user = messages[messages.length - 1];
        expect(user.role).toBe("user");
        expect(user.content).toContain("attached-lift");
        expect(user.content).toContain("0.721");
        expect(user.content).toContain("Before vs after");
        expect(user.content).not.toContain("Misconception under test");
        expect(messages.length).toBe(3);
    });

    it("never throws on empty input", () => {
        expect(() => buildTutorMessages({ after: null, rows: [], concept: "general", suggestion: null })).not.toThrow();
    });

    it("ignores a malformed suggestion without solver or field copy", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "suction-peak",
            suggestion: { primary: "exploit'; DROP TABLE" as never, secondary: "k'; DELETE" as never },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain("no action fence");
        expect(system).not.toContain("DROP TABLE");
        expect(system).not.toContain("DELETE");
        const user = messages[messages.length - 1].content;
        expect(user).not.toContain("Suggested field");
    });

    it("projects live context to physics-only keys with no banned tokens", () => {
        const after = buildAgentContext({
            spec: { kind: "naca4", naca: { code: "2412", m: 0.02, p: 0.4, t: 0.12 }, chord: 1, alphaDeg: 6, nPoints: 120 },
            reynolds: 50000,
            regime: "laminar, attached",
            bodyLabel: "NACA 2412",
            backend: "lbm pending",
            engine: "lbm",
            gridLabel: "128x128",
            cl: 0.654,
            cpMin: -1.234,
            lbmStatus: "running",
            lbmHasSnapshot: true,
            lbmEffective: true,
            lbmStatsReady: true,
            lbmStats: { samples: 8, startStep: 0, step: 8, recircFraction: 0.05, cdMean: 0.02, clMean: 0.65, clRms: 0.01, strouhal: 0.21 },
            variable: "omega",
            effectiveVariable: "omega",
            hasTke: true,
            hasRecirc: true,
            validation: { pass: 1, warn: 0, fail: 0, info: 0 },
            provenanceLabel: "lbm live",
            offline: false,
            neuralAvailable: true,
            neuralEnvelopeSummary: "provisional neural envelope with weights",
            displayedPath: "lbm",
            surrogate: { path: "surrogate", weightsVersion: "v1", strouhal: 0.21, vorticityPeak: 4.2 } as never,
        } as never);
        const view = physicsViewFor(after);
        expect(Object.keys(view).sort()).toEqual(["alphaDeg", "body", "cl", "cpMin", "regime", "reynolds"].sort());
        const messages = buildTutorMessages({ after, rows: rows(), concept: "attached-lift", suggestion: { primary: "speed", secondary: "cp" }, history: [] });
        const full = messages.map((m) => m.content).join("\n");
        const lowered = full.toLowerCase();
        for (const token of ["run_lbm", "cancel_lbm", "set_field", "set_engine", "strouhal", "neural", "weights", "vorticity", "\"lbm\"", "\"field\"", "\"engine\"", "\"surrogate\""]) {
            expect(lowered).not.toContain(token);
        }
        expect(lowered).toContain("naca 2412");
    });
});
