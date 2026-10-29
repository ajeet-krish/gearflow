// Phase T1 tutor prompt tests: version pin plus the honesty and plain
// language clauses the Explain preset depends on. Pure, zero network.

import { describe, expect, it } from "vitest";
import { buildTutorMessages, TUTOR_MAX_WORDS, TUTOR_PROMPT_VERSION } from "./tutorPrompt";
import { buildTutorTable } from "./tutorTable";

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
        expect(TUTOR_PROMPT_VERSION).toBe("tutor-v1");
        expect(system).toContain("tutor-v1");
        expect(system).toContain("GearFlow flow tutor");
        expect(system).toContain("one idea per reply");
        expect(system).toContain("grade 8 to 10");
        expect(system).toContain("same sentence");
        expect(system).toContain("vorticity");
        expect(system).toContain("suction");
        expect(system).toContain("separation");
    });

    it("pins the honesty clauses and the structure plus fence rules", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "suction-peak",
            suggestion: { primary: "cp", secondary: "speed" },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain("never invent numbers");
        expect(system).toContain("predicted, not validated");
        expect(system).toContain("potential flow estimate");
        expect(system).toContain("may be called solved");
        expect(system).toContain("instantaneous snapshot");
        expect(system).toContain("pending");
        expect(system).toContain("What changed");
        expect(system).toContain("Try next");
        expect(system).toContain(`${TUTOR_MAX_WORDS} words`);
        expect(system).toContain("at most one set_field");
        expect(system).toContain('"cp"');
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
        expect(messages.length).toBe(3);
    });

    it("never throws on empty input", () => {
        expect(() => buildTutorMessages({ after: null, rows: [], concept: "general", suggestion: null })).not.toThrow();
    });

    it("cleans a malformed suggestion through the FieldMode allowlist", () => {
        const messages = buildTutorMessages({
            after: null,
            rows: rows(),
            concept: "suction-peak",
            suggestion: { primary: "exploit'; DROP TABLE" as never, secondary: "k'; DELETE" as never },
            history: [],
        });
        const system = messages[0].content;
        expect(system).toContain('for the suggested primary field (speed)');
        expect(system).toContain('{"kind":"set_field","field":"speed"}');
        expect(system).not.toContain("DROP TABLE");
        expect(system).not.toContain("DELETE");
        const user = messages[messages.length - 1].content;
        expect(user).toContain("Suggested field: speed (secondary: none)");
    });
});
