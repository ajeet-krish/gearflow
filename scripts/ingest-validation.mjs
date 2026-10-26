// Ingest Phase 3 vendored validation fixtures. Reads raw downloads from
// fixtures/validation (*.csv, *.txt, *.dat), writes normalized JSON beside
// them for the offline validation panel. Deterministic, no network.
// Run: node scripts/ingest-validation.mjs (or npm run ingest:validation)
//
// SINGLE SOURCE OF TRUTH: the canonical parse logic lives in TypeScript
// (src/validation/parsePolars.ts). This script is a line-for-line mirror for
// offline baking only: same Alpha header scan, same dashes skip, same
// Fortran D exponent conversion, same Lednicer vs Selig auto-detect.
// If you change the TS module, mirror the change here, re-run ingest, and
// run the parity guard: npm test -- parsePolars

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const valDir = join(root, "fixtures", "validation");

// Mirror of src/validation/parsePolars.ts caps. Keep in sync.
const MAX_PARSE_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_POLAR_RECORDS = 10000;
const MAX_TMR_ZONES = 256;
const MAX_TMR_ROWS_PER_ZONE = 100000;
const MAX_COORD_POINTS = 10000;

function checkTextSize(text, context) {
    if (text.length > MAX_PARSE_TEXT_BYTES) {
        throw new Error(`ingest: ${context} exceeds ${MAX_PARSE_TEXT_BYTES} chars`);
    }
}

function splitVariablesBody(body) {
    const out = [];
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

function parseFinite(value, context) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        throw new Error(`ingest: ${context} is not finite, got ${JSON.stringify(value)}`);
    }
    return parsed;
}

function toPolar(values, lineNo) {
    if (values.length !== 7) throw new Error(`ingest: polar row ${lineNo} must have 7 values, got ${values.length}`);
    const [alpha, cl, cd, cdp, cm, topXtr, botXtr] = values;
    return { alpha, cl, cd, cdp, cm, topXtr, botXtr };
}

function parseCsv(text) {
    checkTextSize(text, "csv");
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].split(",")[0].trim().toLowerCase() === "alpha") {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) throw new Error("ingest: no Alpha header found");
    const meta = {};
    for (let i = 0; i < headerIdx; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        const comma = line.indexOf(",");
        if (comma < 0) continue;
        const key = line.slice(0, comma).trim();
        const value = line.slice(comma + 1).trim();
        if (key !== "") meta[key] = value;
    }
    const records = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (records.length >= MAX_POLAR_RECORDS) throw new Error("ingest: too many csv rows");
        const cells = line.split(",").map((c) => c.trim());
        if (cells.length !== 7) throw new Error(`ingest: csv line ${i + 1} must have 7 values, got ${cells.length}`);
        records.push(toPolar(cells.map((c) => parseFinite(c, `csv line ${i + 1}`)), i + 1));
    }
    if (records.length === 0) throw new Error("ingest: no csv data rows");
    return { records, meta };
}

function parseTxt(text) {
    checkTextSize(text, "txt");
    const lines = text.split(/\r?\n/);
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const lower = lines[i].toLowerCase();
        if (lower.includes("alpha") && lower.includes("cl")) {
            headerIdx = i;
            break;
        }
    }
    if (headerIdx < 0) throw new Error("ingest: no alpha/CL header found");
    const records = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === "") continue;
        if (/^[-+\s.]+$/.test(line)) continue;
        if (records.length >= MAX_POLAR_RECORDS) throw new Error("ingest: too many txt rows");
        const cells = line.split(/\s+/);
        if (cells.length !== 7) throw new Error(`ingest: txt line ${i + 1} must have 7 values, got ${cells.length}`);
        records.push(toPolar(cells.map((c) => parseFinite(c, `txt line ${i + 1}`)), i + 1));
    }
    if (records.length === 0) throw new Error("ingest: no txt data rows");
    return { records, meta: {} };
}

function fortranToFloat(token) {
    return parseFinite(token.replace(/[dD]/g, "E"), "fortran float");
}

function parseTmrDat(text) {
    checkTextSize(text, "tmr");
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed.startsWith("#")) continue;
        lines.push(raw);
    }
    const varIdx = lines.findIndex((line) => line.trim().toLowerCase().startsWith("variables"));
    if (varIdx < 0) throw new Error("ingest: no variables= line found");
    const eq = lines[varIdx].indexOf("=");
    const variables = splitVariablesBody(lines[varIdx].slice(eq + 1))
        .map((c) => c.trim().replace(/^"|"$/g, ""))
        .filter((c) => c !== "");
    if (variables.length === 0) throw new Error("ingest: no variables entries");
    const zones = [];
    let current = null;
    for (let i = varIdx + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (/^zone\b/i.test(trimmed)) {
            if (zones.length >= MAX_TMR_ZONES) throw new Error("ingest: too many zones");
            const match = /t\s*=\s*"([^"]*)"/i.exec(trimmed) ?? /t\s*=\s*([^\s,]+)/i.exec(trimmed);
            current = { name: match ? match[1] : "zone", rows: [] };
            zones.push(current);
            continue;
        }
        const cells = trimmed.split(/[\s,]+/).filter((c) => c !== "");
        if (cells.length === 0) continue;
        if (cells.length !== variables.length) {
            throw new Error(`ingest: row ${i + 1} has ${cells.length} values, expected ${variables.length}`);
        }
        if (current === null) {
            if (zones.length >= MAX_TMR_ZONES) throw new Error("ingest: too many zones");
            current = { name: "data", rows: [] };
            zones.push(current);
        }
        if (current.rows.length >= MAX_TMR_ROWS_PER_ZONE) throw new Error("ingest: too many rows in zone");
        current.rows.push(cells.map((c) => fortranToFloat(c)));
    }
    if (zones.length === 0 || zones.every((z) => z.rows.length === 0)) {
        throw new Error("ingest: no TMR data rows found");
    }
    return { variables, zones };
}

function parseCoordPair(line) {
    const cells = line.trim().split(/[\s,]+/).filter((c) => c !== "");
    if (cells.length < 2) return null;
    const x = Number(cells[0]);
    const y = Number(cells[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
}

function parseAirfoilDat(text) {
    checkTextSize(text, "coords");
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
    if (lines.length < 3) throw new Error("ingest: fewer than 3 non-empty lines");
    if (lines.length > MAX_COORD_POINTS + 2) throw new Error("ingest: too many coord lines");
    const counts = lines[1].split(/[\s,]+/).filter((c) => c !== "").map((c) => Number(c));
    const isLednicer =
        counts.length === 2 &&
        counts.every((n) => Number.isInteger(n) && n > 2);
    if (isLednicer) {
        if (counts[0] + counts[1] > MAX_COORD_POINTS + 2) throw new Error("ingest: too many coord points");
        const have = lines.length - 2;
        if (have < counts[0] + counts[1]) {
            throw new Error(
                `ingest: Lednicer counts declare ${counts[0]} upper plus ${counts[1]} lower points but only ${have} data lines present (truncated file)`,
            );
        }
        const upper = [];
        const lower = [];
        for (let i = 0; i < counts[0]; i++) {
            const pt = parseCoordPair(lines[2 + i]);
            if (pt === null) throw new Error(`ingest: bad upper point on line ${i + 3}`);
            upper.push(pt);
        }
        for (let i = 0; i < counts[1]; i++) {
            const pt = parseCoordPair(lines[2 + counts[0] + i]);
            if (pt === null) throw new Error(`ingest: bad lower point on line ${i + 3 + counts[0]}`);
            lower.push(pt);
        }
        return { upper, lower, format: "lednicer" };
    }
    const seq = [];
    for (let i = 1; i < lines.length; i++) {
        const pt = parseCoordPair(lines[i]);
        if (pt === null) throw new Error(`ingest: bad coordinate on line ${i + 1}: ${JSON.stringify(lines[i])}`);
        seq.push(pt);
    }
    let leIdx = 0;
    for (let i = 1; i < seq.length; i++) {
        if (seq[i].x < seq[leIdx].x) leIdx = i;
    }
    return { upper: seq.slice(0, leIdx + 1).reverse(), lower: seq.slice(leIdx), format: "selig" };
}

const POLARS = [
    "xf-n0012-il-100000",
    "xf-n0012-il-500000",
    "xf-naca2412-il-100000",
    "xf-naca2412-il-500000",
];

const TMR = ["0012.mccroskeydata.cl", "CLCD_Ladson_expdata", "CP_Gregory_expdata"];

const COORDS = ["n0012", "naca2412"];

mkdirSync(valDir, { recursive: true });

for (const name of POLARS) {
    const csv = readFileSync(join(valDir, `${name}.csv`), "utf8");
    const txt = readFileSync(join(valDir, `${name}.txt`), "utf8");
    const fromCsv = parseCsv(csv);
    const fromTxt = parseTxt(txt);
    if (fromCsv.records.length !== fromTxt.records.length) {
        throw new Error(`ingest: CSV vs TXT row mismatch for ${name}`);
    }
    writeFileSync(join(valDir, `${name}.json`), JSON.stringify({ meta: fromCsv.meta, records: fromCsv.records }, null, 2) + "\n");
    console.log(`ingest: ${name}.json rows=${fromCsv.records.length}`);
}

for (const name of TMR) {
    const text = readFileSync(join(valDir, `${name}.dat`), "utf8");
    const table = parseTmrDat(text);
    const total = table.zones.reduce((sum, z) => sum + z.rows.length, 0);
    writeFileSync(join(valDir, `${name}.json`), JSON.stringify(table, null, 2) + "\n");
    console.log(`ingest: ${name}.json zones=${table.zones.length} rows=${total}`);
}

for (const name of COORDS) {
    const text = readFileSync(join(valDir, `${name}.dat`), "utf8");
    const coords = parseAirfoilDat(text);
    writeFileSync(join(valDir, `${name}.json`), JSON.stringify(coords, null, 2) + "\n");
    console.log(`ingest: ${name}.json format=${coords.format} upper=${coords.upper.length} lower=${coords.lower.length}`);
}

console.log("ingest: done");
