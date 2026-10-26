// Pure ingest parsers for Phase 3 vendored validation fixtures. No fs, no
// fetch, no network. The ingest script (scripts/ingest-validation.mjs) is a
// line-for-line Node mirror of this module; keep both in sync and covered by
// the parity test in src/validation/parsePolars.test.ts.
//
// Supported inputs:
// * AirfoilTools CSV: about 10 metadata lines (key,value), then a header line
//   starting with "Alpha" (case insensitive), then comma rows of 7 floats.
// * AirfoilTools TXT: about 12 header lines, a header line containing
//   "alpha" and "CL", a dashes separator line, then whitespace rows of
//   7 floats.
// * TMR DAT (Tecplot style): "#" comment lines, a variables= line, zone
//   headers, then whitespace float rows. Fortran D exponents convert to E.
// * Coordinate DAT: auto-detected Lednicer (title line, count line, upper
//   then lower) vs Selig (single x,y sequence looping TE to TE).

import type { CpRecord, PolarRecord } from "@/contracts/types";
import type { Point } from "@/geometry/parametric";

/** Allocation caps: crafted fixture text must not force huge arrays. */
export const MAX_PARSE_TEXT_BYTES = 8 * 1024 * 1024;
export const MAX_POLAR_RECORDS = 10000;
export const MAX_TMR_ZONES = 256;
export const MAX_TMR_ROWS_PER_ZONE = 100000;
export const MAX_COORD_POINTS = 10000;
export const MAX_META_ENTRIES = 256;

function checkTextSize(text: string, context: string): void {
    if (text.length > MAX_PARSE_TEXT_BYTES) {
        throw new Error(`${context}: text of ${text.length} chars exceeds cap ${MAX_PARSE_TEXT_BYTES}`);
    }
}

export interface PolarTable {
    records: PolarRecord[];
    /** Raw key,value metadata lines above the CSV header (empty for TXT). */
    meta: Record<string, string>;
}

export interface TmrZone {
    name: string;
    rows: number[][];
}

export interface TmrTable {
    variables: string[];
    zones: TmrZone[];
}

export interface AirfoilCoords {
    upper: Point[];
    lower: Point[];
}

function parseFinite(value: string, context: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`parsePolars: ${context} is not a finite number, got ${JSON.stringify(value)}`);
    }
    return parsed;
}

function toPolar(values: number[], lineNo: number): PolarRecord {
    if (values.length !== 7) {
        throw new Error(`parsePolars: polar row ${lineNo} must have 7 values, got ${values.length}`);
    }
    const [alpha, cl, cd, cdp, cm, topXtr, botXtr] = values;
    return { alpha, cl, cd, cdp, cm, topXtr, botXtr };
}

/**
 * Parse an AirfoilTools CSV polar. Finds the header line starting with
 * "Alpha" (case insensitive) instead of assuming a fixed line number, then
 * reads comma separated rows of 7 floats. Metadata lines above the header
 * are kept as key,value provenance.
 */
export function parseAirfoilToolsCsv(text: string): PolarTable {
    if (typeof text !== "string" || text.length === 0) {
        throw new Error("parseAirfoilToolsCsv: text must be a non-empty string");
    }
    checkTextSize(text, "parseAirfoilToolsCsv");
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const first = lines[i].split(",")[0].trim().toLowerCase();
        if (first === "alpha") {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) {
        throw new Error("parseAirfoilToolsCsv: no header line starting with Alpha found");
    }
    const meta: Record<string, string> = {};
    for (let i = 0; i < headerIdx; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        const comma = line.indexOf(",");
        if (comma < 0) continue;
        const key = line.slice(0, comma).trim();
        const value = line.slice(comma + 1).trim();
        if (key !== "") {
            if (Object.keys(meta).length >= MAX_META_ENTRIES) {
                throw new Error(`parseAirfoilToolsCsv: more than ${MAX_META_ENTRIES} metadata entries`);
            }
            meta[key] = value;
        }
    }
    const records: PolarRecord[] = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (records.length >= MAX_POLAR_RECORDS) {
            throw new Error(`parseAirfoilToolsCsv: more than ${MAX_POLAR_RECORDS} records`);
        }
        const cells = line.split(",").map((c) => c.trim());
        if (cells.length !== 7) {
            throw new Error(`parseAirfoilToolsCsv: data line ${i + 1} must have 7 comma values, got ${cells.length}`);
        }
        records.push(toPolar(cells.map((c) => parseFinite(c, `csv line ${i + 1}`)), i + 1));
    }
    if (records.length === 0) {
        throw new Error("parseAirfoilToolsCsv: no data rows found");
    }
    return { records, meta };
}

/**
 * Parse an AirfoilTools TXT polar. Finds the header line containing both
 * "alpha" and "cl" (case insensitive), skips the dashes separator, then
 * reads whitespace separated rows of 7 floats.
 */
export function parseAirfoilToolsTxt(text: string): PolarTable {
    if (typeof text !== "string" || text.length === 0) {
        throw new Error("parseAirfoilToolsTxt: text must be a non-empty string");
    }
    checkTextSize(text, "parseAirfoilToolsTxt");
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (lower.includes("alpha") && lower.includes("cl")) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) {
        throw new Error("parseAirfoilToolsTxt: no header line containing alpha and CL found");
    }
    const records: PolarRecord[] = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (/^[-+\s.]+$/.test(line)) continue;
        if (records.length >= MAX_POLAR_RECORDS) {
            throw new Error(`parseAirfoilToolsTxt: more than ${MAX_POLAR_RECORDS} records`);
        }
        const cells = line.split(/\s+/);
        if (cells.length !== 7) {
            throw new Error(`parseAirfoilToolsTxt: data line ${i + 1} must have 7 values, got ${cells.length}`);
        }
        records.push(toPolar(cells.map((c) => parseFinite(c, `txt line ${i + 1}`)), i + 1));
    }
    if (records.length === 0) {
        throw new Error("parseAirfoilToolsTxt: no data rows found");
    }
    return { records, meta: {} };
}

/** Try CSV first (comma header), fall back to TXT (whitespace header). */
export function parsePolarAuto(text: string): PolarTable {
    if (typeof text !== "string" || text.length === 0) {
        throw new Error("parsePolarAuto: text must be a non-empty string");
    }
    checkTextSize(text, "parsePolarAuto");
    const hasCsvHeader = text.split(/\r?\n/).some((line) => line.split(",")[0].trim().toLowerCase() === "alpha");
    if (hasCsvHeader) return parseAirfoilToolsCsv(text);
    return parseAirfoilToolsTxt(text);
}

/** Convert Fortran D exponents (1.2D+03) to E so Number() parses them. */
export function fortranToFloat(token: string): number {
    return parseFinite(token.replace(/[dD]/g, "E"), "fortran float");
}

function stripTmrComments(text: string): string[] {
    const out: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        out.push(raw);
    }
    return out;
}

/** Quote-aware split of a variables= body: commas inside "..." stay intact. */
function splitVariablesBody(body: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < body.length; i++) {
        const ch = body[i];
        if (ch === '"') {
            inQuotes = !inQuotes;
            cur += ch;
        } else if (ch === "," && !inQuotes) {
            out.push(cur);
            cur = "";
        } else {
            cur += ch;
        }
    }
    out.push(cur);
    return out;
}

function parseVariablesLine(line: string): string[] {
    const eq = line.indexOf("=");
    if (eq < 0) throw new Error(`parseTmrDat: malformed variables line: ${JSON.stringify(line)}`);
    return splitVariablesBody(line.slice(eq + 1))
        .map((c) => c.trim().replace(/^"|"$/g, ""))
        .filter((c) => c !== "");
}

function parseZoneName(line: string): string {
    const match = /t\s*=\s*"([^"]*)"/i.exec(line) ?? /t\s*=\s*([^\s,]+)/i.exec(line);
    if (match) return match[1];
    return `zone`;
}

/**
 * Parse a NASA TMR style Tecplot DAT file. Strips "#" comments, reads the
 * variables= line, splits rows on zone headers, converts Fortran D
 * exponents, and parses whitespace floats. Files without zone headers
 * (McCroskey fit line) yield a single zone named "data".
 */
export function parseTmrDat(text: string): TmrTable {
    if (typeof text !== "string" || text.length === 0) {
        throw new Error("parseTmrDat: text must be a non-empty string");
    }
    checkTextSize(text, "parseTmrDat");
    const lines = stripTmrComments(text);
    const varIdx = lines.findIndex((line) => line.trim().toLowerCase().startsWith("variables"));
    if (varIdx < 0) {
        throw new Error("parseTmrDat: no variables= line found");
    }
    const variables = parseVariablesLine(lines[varIdx]);
    if (variables.length === 0) {
        throw new Error("parseTmrDat: variables= line has no entries");
    }
    const zones: TmrZone[] = [];
    let current: TmrZone | null = null;
    const ensureZone = (): TmrZone => {
        if (current === null) {
            if (zones.length >= MAX_TMR_ZONES) {
                throw new Error(`parseTmrDat: more than ${MAX_TMR_ZONES} zones`);
            }
            current = { name: "data", rows: [] };
            zones.push(current);
        }
        return current;
    };
    for (let i = varIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^zone\b/i.test(trimmed)) {
            if (zones.length >= MAX_TMR_ZONES) {
                throw new Error(`parseTmrDat: more than ${MAX_TMR_ZONES} zones`);
            }
            current = { name: parseZoneName(trimmed), rows: [] };
            zones.push(current);
            continue;
        }
        const cells = trimmed.split(/[\s,]+/).filter((c) => c !== "");
        if (cells.length === 0) continue;
        if (cells.length !== variables.length) {
            throw new Error(
                `parseTmrDat: row ${i + 1} has ${cells.length} values, expected ${variables.length} (variables: ${variables.join("|")})`,
            );
        }
        const zone = ensureZone();
        if (zone.rows.length >= MAX_TMR_ROWS_PER_ZONE) {
            throw new Error(`parseTmrDat: zone ${JSON.stringify(zone.name)} exceeds ${MAX_TMR_ROWS_PER_ZONE} rows`);
        }
        const row = cells.map((c) => fortranToFloat(c));
        zone.rows.push(row);
    }
    if (zones.length === 0 || zones.every((z) => z.rows.length === 0)) {
        throw new Error("parseTmrDat: no data rows found");
    }
    return { variables, zones };
}

/** Expand Gregory Cp zones into flat CpRecords using the zone alpha label. */
export function gregoryToCpRecords(table: TmrTable): CpRecord[] {
    const out: CpRecord[] = [];
    for (const zone of table.zones) {
        const match = /alpha\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(zone.name);
        if (!match) continue;
        const alpha = Number(match[1]);
        for (const row of zone.rows) {
            if (row.length < 2) continue;
            out.push({ alpha, x: row[0], cp: row[1] });
        }
    }
    return out;
}

function parseCoordPair(line: string): Point | null {
    const cells = line.trim().split(/[\s,]+/).filter((c) => c !== "");
    if (cells.length < 2) return null;
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

/**
 * Parse an airfoil coordinate DAT file. Auto-detects Lednicer format (title
 * line, then a count line with two integers, then upper points followed by
 * lower points) vs Selig format (a single x,y sequence looping TE to TE via
 * the leading edge). Returns upper (LE to TE) and lower (LE to TE) lists.
 */
export function parseAirfoilDat(text: string): AirfoilCoords {
    if (typeof text !== "string" || text.length === 0) {
        throw new Error("parseAirfoilDat: text must be a non-empty string");
    }
    checkTextSize(text, "parseAirfoilDat");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length < 3) {
        throw new Error("parseAirfoilDat: fewer than 3 non-empty lines");
    }
    if (lines.length > MAX_COORD_POINTS + 2) {
        throw new Error(`parseAirfoilDat: more than ${MAX_COORD_POINTS} coordinate lines`);
    }
    const countCells = lines[1].split(/[\s,]+/).filter((c) => c !== "");
    const counts = countCells.map((c) => Number(c));
    const isLednicer = counts.length === 2 && counts.every((n) => Number.isInteger(n) && n > 2);
    if (isLednicer) {
        const nUpper = counts[0];
        const nLower = counts[1];
        if (nUpper + nLower > MAX_COORD_POINTS + 2) {
            throw new Error(`parseAirfoilDat: more than ${MAX_COORD_POINTS} coordinate points`);
        }
        const have = lines.length - 2;
        if (have < nUpper + nLower) {
            throw new Error(
                `parseAirfoilDat: Lednicer counts declare ${nUpper} upper plus ${nLower} lower points but only ${have} data lines present (truncated file)`,
            );
        }
        const upper: Point[] = [];
        const lower: Point[] = [];
        for (let i = 0; i < nUpper; i++) {
            const pt = parseCoordPair(lines[2 + i]);
            if (pt === null) throw new Error(`parseAirfoilDat: bad upper point on line ${i + 3}`);
            upper.push(pt);
        }
        for (let i = 0; i < nLower; i++) {
            const pt = parseCoordPair(lines[2 + nUpper + i]);
            if (pt === null) throw new Error(`parseAirfoilDat: bad lower point on line ${i + 3 + nUpper}`);
            lower.push(pt);
        }
        return { upper, lower };
    }
    // Line 0 is the Selig title line, coordinate pairs start at line 1.
    const start = 1;
    const seq: Point[] = [];
    for (let i = start; i < lines.length; i++) {
        if (seq.length >= MAX_COORD_POINTS + 2) {
            throw new Error(`parseAirfoilDat: more than ${MAX_COORD_POINTS} coordinate points`);
        }
        const pt = parseCoordPair(lines[i]);
        if (pt === null) {
            throw new Error(`parseAirfoilDat: bad coordinate on line ${i + 1}: ${JSON.stringify(lines[i])}`);
        }
        seq.push(pt);
    }
    if (seq.length < 4) {
        throw new Error("parseAirfoilDat: fewer than 4 coordinate pairs");
    }
    let leIdx = 0;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i].x < seq[leIdx].x) leIdx = i;
    }
    const upper = seq.slice(0, leIdx + 1).reverse();
    const lower = seq.slice(leIdx);
    return { upper, lower };
}
