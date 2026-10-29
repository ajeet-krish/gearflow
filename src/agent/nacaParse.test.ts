// R1 parser tests. Corpus matrix plus never throws, invalid never emits
// a valid code, and ambiguous never auto-applies (no m/p/t on the result).

import { describe, expect, it } from "vitest";
import corpus from "./fixtures/airfoilCorpus.json";
import { isSchemaValidCode, nearestValidCode, parseNacaLoose } from "./nacaParse";

interface CorpusParseExpect {
    status: "ok" | "ambiguous" | "invalid" | "none";
    code?: string;
    realistic?: boolean;
    explicit?: boolean;
    candidatesInclude?: string[];
    nearest?: string;
    correctionsInclude?: string[];
}

interface CorpusRow {
    id: string;
    text: string;
    parse: CorpusParseExpect;
}

const rows = (corpus as unknown as { rows: CorpusRow[] }).rows;

describe("parseNacaLoose corpus matrix", () => {
    for (const row of rows) {
        it(`parses ${row.id}`, () => {
            const got = parseNacaLoose(row.text);
            expect(got.status).toBe(row.parse.status);
            if (row.parse.code !== undefined && got.status === "ok") {
                expect(got.code).toBe(row.parse.code);
            }
            if (row.parse.realistic !== undefined && got.status === "ok") {
                expect(got.realistic).toBe(row.parse.realistic);
            }
            if (row.parse.explicit !== undefined && (got.status === "ok" || got.status === "ambiguous" || got.status === "invalid")) {
                expect(got.explicit).toBe(row.parse.explicit);
            }
            if (row.parse.candidatesInclude !== undefined && got.status === "ambiguous") {
                for (const c of row.parse.candidatesInclude) {
                    expect(got.candidates).toContain(c);
                }
            }
            if (row.parse.nearest !== undefined && got.status === "invalid") {
                expect(got.nearest).toBe(row.parse.nearest);
            }
            if (row.parse.correctionsInclude !== undefined) {
                const joined = got.corrections.join(" ").toLowerCase();
                for (const c of row.parse.correctionsInclude) {
                    expect(joined).toContain(c.toLowerCase());
                }
            }
        });
    }
});

describe("parseNacaLoose safety", () => {
    it("never throws on bad input", () => {
        const bad: unknown[] = [null, undefined, 42, {}, [], "", "   ", "naca", "naca 12", "hello world", "Re200k", "8deg", "\u{1F3A8}"];
        for (const v of bad) {
            const got = parseNacaLoose(v);
            expect(["ok", "ambiguous", "invalid", "none"]).toContain(got.status);
        }
    });

    it("invalid never emits a valid code", () => {
        for (const row of rows.filter((r) => r.parse.status === "invalid")) {
            const got = parseNacaLoose(row.text);
            expect(got.status).toBe("invalid");
            expect("m" in got).toBe(false);
            expect("p" in got).toBe(false);
            expect("t" in got).toBe(false);
            if (got.status === "invalid" && got.nearest !== null) {
                expect(isSchemaValidCode(got.nearest).ok).toBe(true);
            }
        }
        const zero = parseNacaLoose("NACA 2400");
        expect(zero.status).toBe("invalid");
    });

    it("ambiguous never auto-applies", () => {
        for (const row of rows.filter((r) => r.parse.status === "ambiguous")) {
            const got = parseNacaLoose(row.text);
            expect(got.status).toBe("ambiguous");
            expect("code" in got).toBe(false);
            if (got.status === "ambiguous") {
                expect(got.candidates.length).toBeGreaterThan(0);
                expect(got.question.length).toBeGreaterThan(0);
            }
        }
        const five = parseNacaLoose("naka 24112");
        expect(five.status).toBe("ambiguous");
        if (five.status === "ambiguous") {
            expect(five.kind).toBe("five-digit");
            expect(five.candidates).toContain("2412");
        }
    });

    it("five digit always clarifies, even for duplicate digit typos", () => {
        for (const text of ["24112", "23012", "naca 24412", "airfoil 44112"]) {
            const got = parseNacaLoose(text);
            expect(got.status).toBe("ambiguous");
        }
    });
});

describe("isSchemaValidCode", () => {
    it("accepts the widened envelope up to 40% thickness", () => {
        const check = isSchemaValidCode("2440");
        expect(check.ok).toBe(true);
        expect(check.t).toBeCloseTo(0.4, 10);
        expect(check.realistic).toBe(false);
        expect(check.note).not.toBeNull();
    });

    it("rejects schema out-of-envelope codes 2912 and 2405 with a nearest valid code", () => {
        for (const bad of ["2912", "2405"]) {
            const check = isSchemaValidCode(bad);
            expect(check.ok).toBe(false);
            expect(typeof check.reason).toBe("string");
            const near = nearestValidCode(bad);
            expect(near).not.toBeNull();
            if (near !== null) expect(isSchemaValidCode(near).ok).toBe(true);
        }
    });

    it("marks the trainer band realistic", () => {
        for (const code of ["0012", "2412", "4412", "6415"]) {
            const check = isSchemaValidCode(code);
            expect(check.ok).toBe(true);
            expect(check.realistic).toBe(true);
            expect(check.note).toBeNull();
        }
    });

    it("never throws on bad input", () => {
        for (const v of [null, undefined, 42, "241", "24125", "abcd", "2400", ""]) {
            const check = isSchemaValidCode(v);
            expect(typeof check.ok).toBe("boolean");
            if (!check.ok) {
                expect(typeof check.reason).toBe("string");
                expect(check.realistic).toBe(false);
            }
        }
    });
});
