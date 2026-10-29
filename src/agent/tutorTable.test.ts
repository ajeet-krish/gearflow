// Phase T1 tutor table tests: finite guards, source family deltas, and
// the LBM CpMin n/a rule. Pure, zero network.

import { describe, expect, it } from "vitest";
import { buildTutorTable, tutorRowsText, tutorSourceFamily, type TutorSnapshotLite } from "./tutorTable";

function lite(over: Partial<TutorSnapshotLite> = {}): TutorSnapshotLite {
    return {
        caseKey: "naca2412-a6-r50000",
        bodyLabel: "NACA 2412",
        alpha: 6,
        reynolds: 50000,
        cl: 0.654,
        cpMin: -1.234,
        regime: "laminar, attached",
        pathLabel: "analytic potential flow, not validated",
        strouhal: null,
        ...over,
    };
}

function cell(rows: ReturnType<typeof buildTutorTable>, metric: string, side: "before" | "after" | "delta"): string {
    const found = rows.find((row) => row.metric === metric);
    if (found === undefined) throw new Error(`missing row ${metric}`);
    return found[side];
}

describe("tutorSourceFamily", () => {
    it("classifies lbm, neural, analytic, and unknown labels", () => {
        expect(tutorSourceFamily("LBM solved, instantaneous snapshot")).toBe("lbm");
        expect(tutorSourceFamily("neural-v3 phase averaged, modeled")).toBe("neural");
        expect(tutorSourceFamily("analytic potential flow, not validated")).toBe("analytic");
        expect(tutorSourceFamily("pending")).toBe("unknown");
        expect(tutorSourceFamily(null)).toBe("unknown");
    });
});

describe("buildTutorTable", () => {
    it("renders finite values with numeric deltas inside one family", () => {
        const rows = buildTutorTable(lite(), lite({ alpha: 7, cl: 0.721 }));
        expect(cell(rows, "Alpha", "before")).toBe("6.0 deg");
        expect(cell(rows, "Alpha", "after")).toBe("7.0 deg");
        expect(cell(rows, "Alpha", "delta")).toBe("+1.0 deg");
        expect(cell(rows, "Cl", "delta")).toBe("+0.067");
        expect(cell(rows, "Re", "delta")).toBe("+0");
    });

    it("renders n/a for NaN sides with an n/a delta inside one family", () => {
        const rows = buildTutorTable(lite({ cl: Number.NaN }), lite({ cl: 0.721 }));
        expect(cell(rows, "Cl", "before")).toBe("n/a");
        expect(cell(rows, "Cl", "after")).toBe("0.721");
        expect(cell(rows, "Cl", "delta")).toBe("n/a");
    });

    it("marks deltas source changed when the path family moves", () => {
        const rows = buildTutorTable(
            lite({ pathLabel: "analytic potential flow, not validated", cl: 0.654 }),
            lite({ pathLabel: "neural-v2 predicted, not validated", cl: 0.7 }),
        );
        expect(cell(rows, "Cl", "delta")).toBe("source changed");
        expect(cell(rows, "CpMin", "delta")).toBe("source changed");
        expect(cell(rows, "Re", "delta")).toBe("source changed");
    });

    it("never quotes CpMin on an LBM frame", () => {
        const rows = buildTutorTable(
            lite({ pathLabel: "LBM solved, instantaneous snapshot", cpMin: -1.2, cl: 0.6 }),
            lite({ pathLabel: "LBM solved, instantaneous snapshot", cpMin: -1.5, cl: 0.62 }),
        );
        expect(cell(rows, "CpMin", "before")).toBe("n/a");
        expect(cell(rows, "CpMin", "after")).toBe("n/a");
        expect(cell(rows, "CpMin", "delta")).toBe("n/a");
        expect(cell(rows, "Cl", "delta")).toBe("+0.020");
    });

    it("never throws on null snapshots and renders pending text", () => {
        const rows = buildTutorTable(null, undefined);
        expect(rows.length).toBeGreaterThan(0);
        expect(tutorRowsText(rows)).toContain("n/a");
        expect(tutorRowsText([])).toContain("pending");
    });

    it("caps oversized text cells at 80 chars", () => {
        const big = "L".repeat(300);
        const rows = buildTutorTable(lite({ bodyLabel: big }), lite({ regime: big, pathLabel: big }));
        for (const row of rows) {
            expect(row.before.length).toBeLessThanOrEqual(80);
            expect(row.after.length).toBeLessThanOrEqual(80);
        }
        const text = tutorRowsText(rows);
        for (const line of text.split("\n").slice(1)) {
            for (const cell of line.split(" | ")) {
                expect(cell.length).toBeLessThanOrEqual(80);
            }
        }
        const direct = tutorRowsText([
            { metric: "Body", before: "B".repeat(500), after: "A".repeat(500), delta: "n/a" },
        ]);
        expect(direct).toContain(`${"B".repeat(77)}...`);
        expect(direct).not.toContain("B".repeat(500));
    });
});
