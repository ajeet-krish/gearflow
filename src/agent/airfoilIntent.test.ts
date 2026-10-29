// R1 intent tests. Corpus matrix plus never throws, question guards,
// verb gating for bare codes, invalid never emitting a valid code, and
// ambiguous never auto-applying.

import { describe, expect, it } from "vitest";
import { buildAirfoilEnvelope, parseAirfoilIntent } from "./airfoilIntent";
import { validateAgentAction } from "./agentActions";
import corpus from "./fixtures/airfoilCorpus.json";
import { parseNacaLoose } from "./nacaParse";

interface CorpusIntentExpect {
    kind: "apply" | "clarify";
    code?: string | null;
    alphaDeg?: number | null;
    reynolds?: number | null;
    minConfidence?: number;
    candidatesInclude?: string[];
    questionInclude?: string[];
    correctionsInclude?: string[];
    notesInclude?: string[];
}

interface CorpusRow {
    id: string;
    text: string;
    current?: string | null;
    intent?: CorpusIntentExpect | null;
}

const rows = (corpus as unknown as { rows: CorpusRow[] }).rows;

describe("parseAirfoilIntent corpus matrix", () => {
    for (const row of rows) {
        it(`intends ${row.id}`, () => {
            const got = parseAirfoilIntent(row.text, row.current == null ? null : { code: row.current });
            if (row.intent === null || row.intent === undefined) {
                expect(got).toBeNull();
                return;
            }
            expect(got).not.toBeNull();
            expect(got?.kind).toBe(row.intent.kind);
            if (row.intent.kind === "apply" && got?.kind === "apply") {
                if (row.intent.code !== undefined) expect(got.code).toBe(row.intent.code);
                if (row.intent.alphaDeg !== undefined) expect(got.alphaDeg).toBe(row.intent.alphaDeg);
                if (row.intent.reynolds !== undefined) expect(got.reynolds).toBe(row.intent.reynolds);
                if (row.intent.minConfidence !== undefined) expect(got.confidence).toBeGreaterThanOrEqual(row.intent.minConfidence);
                expect(got.confidence).toBeGreaterThan(0);
                expect(got.confidence).toBeLessThanOrEqual(1);
                if (row.intent.notesInclude !== undefined) {
                    const joined = got.notes.join(" ");
                    for (const n of row.intent.notesInclude) expect(joined).toContain(n);
                }
            }
            if (row.intent.kind === "clarify" && got?.kind === "clarify") {
                expect(got.question.length).toBeGreaterThan(0);
                if (row.intent.candidatesInclude !== undefined) {
                    for (const c of row.intent.candidatesInclude) expect(got.candidates).toContain(c);
                }
                if (row.intent.questionInclude !== undefined) {
                    for (const q of row.intent.questionInclude) expect(got.question).toContain(q);
                }
            }
            if (row.intent.correctionsInclude !== undefined && (got?.kind === "apply" || got?.kind === "clarify")) {
                const joined = got.corrections.join(" ").toLowerCase();
                for (const c of row.intent.correctionsInclude) expect(joined).toContain(c.toLowerCase());
            }
        });
    }
});

describe("parseAirfoilIntent safety", () => {
    it("never throws on bad input or bad context", () => {
        const bad: unknown[] = [null, undefined, 42, {}, [], "", "   "];
        for (const v of bad) {
            expect(parseAirfoilIntent(v, null)).toBeNull();
        }
        expect(() => parseAirfoilIntent("make 2412 thicker", { code: 42 as unknown as string })).not.toThrow();
        const out = parseAirfoilIntent("make 2412 thicker", null);
        expect(out === null || out.kind === "apply" || out.kind === "clarify").toBe(true);
    });

    it("invalid never emits a valid code", () => {
        const got = parseAirfoilIntent("NACA 2400", null);
        expect(got === null || got.kind === "clarify" || (got.kind === "apply" && got.code === null)).toBe(true);
        if (got !== null && got.kind === "clarify") {
            expect(got.question.length).toBeGreaterThan(0);
        }
    });

    it("ambiguous never auto-applies", () => {
        for (const text of ["naka 24112", "23012", "compare 2412 and 4412"]) {
            const got = parseAirfoilIntent(text, null);
            const autoApplied = got !== null && got.kind === "apply" && got.code !== null;
            expect(autoApplied).toBe(false);
        }
    });

    it("gates bare codes on action verbs", () => {
        expect(parseAirfoilIntent("0012", null)).toBeNull();
        expect(parseAirfoilIntent("2 4 1 2", null)).toBeNull();
        const shown = parseAirfoilIntent("show me 0012", null);
        expect(shown?.kind).toBe("apply");
        if (shown?.kind === "apply") expect(shown.code).toBe("0012");
        const set = parseAirfoilIntent("set 2412", null);
        expect(set?.kind).toBe("apply");
    });

    it("question guards return null with no apply", () => {
        for (const text of [
            "what is NACA 2412",
            "why does 2412 stall",
            "explain NACA 4412",
            "compare 2412 and 4412",
            "2412 vs 4412",
            "2412 and 4412, which is better",
        ]) {
            expect(parseNacaLoose(text).status === "ok" || parseNacaLoose(text).status === "ambiguous").toBe(true);
            expect(parseAirfoilIntent(text, null)).toBeNull();
        }
    });

    it("carries the unrealistic thickness tutor note", () => {
        const got = parseAirfoilIntent("NACA 2440", null);
        expect(got?.kind).toBe("apply");
        if (got?.kind === "apply") {
            expect(got.code).toBe("2440");
            expect(got.notes.join(" ")).toContain("6 to 18%");
        }
    });

    it("clarifies reshapes with no current section", () => {
        const got = parseAirfoilIntent("more camber", null);
        expect(got?.kind).toBe("clarify");
    });

    it("grounds relative thickness edits on the live custom code", () => {
        const thicker = parseAirfoilIntent("make it thicker", { code: "NACA 2415 custom" });
        expect(thicker?.kind).toBe("apply");
        if (thicker?.kind === "apply") {
            expect(thicker.code).toBe("2417");
        }
        const thinner = parseAirfoilIntent("make it thinner", { code: "2415" });
        expect(thinner?.kind).toBe("apply");
        if (thinner?.kind === "apply") {
            expect(thinner.code).toBe("2413");
        }
    });

    it("grounds relative camber edits on the live custom code", () => {
        const more = parseAirfoilIntent("more camber", { code: "2415" });
        expect(more?.kind).toBe("apply");
        if (more?.kind === "apply") {
            expect(more.code).toBe("3415");
        }
        const less = parseAirfoilIntent("less camber", { code: "2415" });
        expect(less?.kind).toBe("apply");
        if (less?.kind === "apply") {
            expect(less.code).toBe("1415");
        }
    });
});

describe("buildAirfoilEnvelope (R3)", () => {
    const live = { lbmEffective: false, statsReady: false, hasTke: false, hasRecirc: false };

    it("rides canonical codes on set_body with alpha and Re", () => {
        const apply = parseAirfoilIntent("Set up NACA 2412 alpha 6 Re 50000", null);
        expect(apply?.kind).toBe("apply");
        if (apply?.kind !== "apply") throw new Error("expected an apply intent");
        expect(apply.confidence).toBeGreaterThanOrEqual(0.9);
        const env = buildAirfoilEnvelope(apply);
        expect(env.candidates).toEqual([
            { kind: "set_body", body: "naca2412" },
            { kind: "set_alpha", alphaDeg: 6 },
            { kind: "set_reynolds", reynolds: 50000 },
        ]);
        for (const candidate of env.candidates) {
            expect(validateAgentAction(candidate, live).ok).toBe(true);
        }
    });

    it("rides non-canonical codes on one set_spec carrying alpha and Re", () => {
        const apply = parseAirfoilIntent("Set up NACA 6415 alpha 8 Re 200000", null);
        expect(apply?.kind).toBe("apply");
        if (apply?.kind !== "apply") throw new Error("expected an apply intent");
        const env = buildAirfoilEnvelope(apply);
        expect(env.candidates).toHaveLength(1);
        const only = env.candidates[0];
        expect(only.kind).toBe("set_spec");
        expect(validateAgentAction(only, live).ok).toBe(true);
        if (only.kind === "set_spec") {
            expect(only.spec.geometry.naca?.code).toBe("6415");
            expect(only.spec.geometry.alphaDeg).toBe(8);
            expect(only.spec.reynolds).toBe(200000);
        }
    });

    it("resolves relative edits against the live section", () => {
        const apply = parseAirfoilIntent("make it thicker", { code: "2412" });
        expect(apply?.kind).toBe("apply");
        if (apply?.kind !== "apply") throw new Error("expected an apply intent");
        expect(apply.code).toBe("2414");
        const env = buildAirfoilEnvelope(apply, { alphaDeg: 6, reynolds: 50000 });
        expect(env.candidates).toHaveLength(1);
        expect(validateAgentAction(env.candidates[0], live).ok).toBe(true);
    });

    it("never throws on bad input", () => {
        expect(() => buildAirfoilEnvelope(null as never, null)).not.toThrow();
        const fallen = buildAirfoilEnvelope(null as never, null);
        expect(fallen.candidates).toEqual([]);
    });
});
