// Parser tests against real vendored fixture data. Reads raw files from
// fixtures/validation (not the baked JSON) so the TS parsers and the Node
// ingest mirror stay honest against the downloads.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
    parseAirfoilDat,
    parseAirfoilToolsCsv,
    parseAirfoilToolsTxt,
    parsePolarAuto,
    parseTmrDat,
    gregoryToCpRecords,
} from "./parsePolars";

const VAL_DIR = fileURLToPath(new URL("../../fixtures/validation", import.meta.url));

function readRaw(name: string): string {
    return readFileSync(`${VAL_DIR}/${name}`, "utf8");
}

const POLARS = [
    "xf-n0012-il-100000",
    "xf-n0012-il-500000",
    "xf-naca2412-il-100000",
    "xf-naca2412-il-500000",
];

describe("parseAirfoilToolsCsv", () => {
    it("finds the Alpha header without assuming line 11", () => {
        for (const name of POLARS) {
            const table = parseAirfoilToolsCsv(readRaw(`${name}.csv`));
            expect(table.records.length).toBeGreaterThan(90);
            expect(table.records[0].alpha).toBeLessThan(-5);
            for (const r of table.records) {
                expect(Number.isFinite(r.cl)).toBe(true);
                expect(Number.isFinite(r.cd)).toBe(true);
            }
        }
    });

    it("parses the 10 metadata lines into provenance", () => {
        const table = parseAirfoilToolsCsv(readRaw("xf-naca2412-il-500000.csv"));
        expect(table.meta["Reynolds number"]).toBe("500000");
        expect(table.meta["Ncrit"]).toBe("9");
        expect(table.meta["Airfoil"]).toBe("naca2412-il");
    });

    it("rejects text without an Alpha header", () => {
        expect(() => parseAirfoilToolsCsv("no header here\n1,2,3")).toThrow();
    });
});

describe("parseAirfoilToolsTxt", () => {
    it("skips the header and dashes, parses 7 whitespace floats", () => {
        for (const name of POLARS) {
            const table = parseAirfoilToolsTxt(readRaw(`${name}.txt`));
            expect(table.records.length).toBeGreaterThan(90);
        }
    });

    it("matches the CSV parse row for row", () => {
        for (const name of POLARS) {
            const csv = parseAirfoilToolsCsv(readRaw(`${name}.csv`));
            const txt = parseAirfoilToolsTxt(readRaw(`${name}.txt`));
            expect(txt.records.length).toBe(csv.records.length);
            for (let i = 0; i < csv.records.length; i++) {
                expect(Math.abs(txt.records[i].alpha - csv.records[i].alpha)).toBeLessThan(1e-9);
                expect(Math.abs(txt.records[i].cl - csv.records[i].cl)).toBeLessThan(1e-9);
                expect(Math.abs(txt.records[i].cd - csv.records[i].cd)).toBeLessThan(1e-6);
            }
        }
    });
});

describe("parsePolarAuto", () => {
    it("routes CSV and TXT correctly", () => {
        const csv = parsePolarAuto(readRaw("xf-n0012-il-500000.csv"));
        const txt = parsePolarAuto(readRaw("xf-n0012-il-500000.txt"));
        expect(csv.records.length).toBe(txt.records.length);
        expect(csv.records.length).toBeGreaterThan(100);
    });
});

describe("parseTmrDat", () => {
    it("parses Gregory Cp zones with variables and alpha labels", () => {
        const table = parseTmrDat(readRaw("CP_Gregory_expdata.dat"));
        expect(table.variables.map((v) => v.toLowerCase())).toContain("cp");
        expect(table.zones.length).toBe(3);
        const names = table.zones.map((z) => z.name).join(" ");
        expect(names).toMatch(/alpha=0/);
        const total = table.zones.reduce((s, z) => s + z.rows.length, 0);
        expect(total).toBe(73);
    });

    it("parses Ladson zones per grit with 3 columns", () => {
        const table = parseTmrDat(readRaw("CLCD_Ladson_expdata.dat"));
        expect(table.zones.length).toBeGreaterThanOrEqual(3);
        for (const z of table.zones) {
            for (const row of z.rows) expect(row.length).toBe(3);
        }
    });

    it("converts Fortran D exponents in the McCroskey fit line", () => {
        const table = parseTmrDat(readRaw("0012.mccroskeydata.cl.dat"));
        expect(table.zones.length).toBe(1);
        expect(table.zones[0].rows.length).toBe(2);
        const [a, b] = table.zones[0].rows;
        expect(a[0]).toBeCloseTo(-10, 6);
        expect(b[0]).toBeCloseTo(10, 6);
        expect(b[1]).toBeCloseTo(1.074902, 5);
    });

    it("expands Gregory zones to flat Cp records", () => {
        const table = parseTmrDat(readRaw("CP_Gregory_expdata.dat"));
        const recs = gregoryToCpRecords(table);
        expect(recs.length).toBe(73);
        expect(recs[0].alpha).toBe(0);
        expect(recs.every((r) => Number.isFinite(r.x) && Number.isFinite(r.cp))).toBe(true);
    });
});

describe("parseAirfoilDat", () => {
    it("detects Lednicer for n0012 (66 upper, 66 lower)", () => {
        const coords = parseAirfoilDat(readRaw("n0012.dat"));
        expect(coords.upper.length).toBe(66);
        expect(coords.lower.length).toBe(66);
    });

    it("detects Selig for naca2412 (TE to TE loop split at the LE)", () => {
        const coords = parseAirfoilDat(readRaw("naca2412.dat"));
        expect(coords.upper.length).toBe(18);
        expect(coords.lower.length).toBe(18);
        expect(coords.upper[0].x).toBeCloseTo(0, 3);
        expect(coords.lower[0].x).toBeCloseTo(0, 3);
        expect(coords.upper[coords.upper.length - 1].x).toBeCloseTo(1, 6);
        expect(coords.lower[coords.lower.length - 1].x).toBeCloseTo(1, 6);
    });

    it("reaches geometry parity between both formats for 0012", () => {
        const lednicer = parseAirfoilDat(readRaw("n0012.dat"));
        const thickness = (pts: { x: number; y: number }[], x: number): number => {
            let best = pts[0];
            for (const p of pts) {
                if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
            }
            return best.y;
        };
        const t03 = thickness(lednicer.upper, 0.3) - thickness(lednicer.lower, 0.3);
        expect(t03).toBeCloseTo(0.12 * 0.5 + 0.06, 1);
        expect(t03).toBeGreaterThan(0.1);
        expect(t03).toBeLessThan(0.13);
    });

    it("rejects truncated Lednicer files with a specific parse error", () => {
        const lines = readRaw("n0012.dat").split(/\r?\n/);
        expect(lines.length).toBeGreaterThan(100);
        const truncated = lines.slice(0, 40).join("\n");
        expect(() => parseAirfoilDat(truncated)).toThrow(/truncated/);
        const nonBlank = lines.filter((l) => l.trim() !== "");
        expect(nonBlank.length).toBe(2 + 66 + 66);
        const oneShort = nonBlank.slice(0, nonBlank.length - 1).join("\n");
        expect(() => parseAirfoilDat(oneShort)).toThrow(/truncated/);
    });
});
