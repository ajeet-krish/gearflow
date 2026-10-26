// Static typed access to committed validation JSON fixtures. All data is
// vendored under fixtures/validation (written by scripts/ingest-validation.mjs
// from raw downloads). No runtime fetch, offline safe. The JSON files are
// committed to the repo; raw downloads stay as provenance.

import type { CpRecord, PolarRecord } from "@/contracts/types";
import { gregoryToCpRecords } from "./parsePolars";
import polar0012Re100k from "../../fixtures/validation/xf-n0012-il-100000.json";
import polar0012Re500k from "../../fixtures/validation/xf-n0012-il-500000.json";
import polar2412Re100k from "../../fixtures/validation/xf-naca2412-il-100000.json";
import polar2412Re500k from "../../fixtures/validation/xf-naca2412-il-500000.json";
import mccroskey from "../../fixtures/validation/0012.mccroskeydata.cl.json";
import ladson from "../../fixtures/validation/CLCD_Ladson_expdata.json";
import gregory from "../../fixtures/validation/CP_Gregory_expdata.json";
import coords0012 from "../../fixtures/validation/n0012.json";
import coords2412 from "../../fixtures/validation/naca2412.json";

export interface PolarDataset {
    meta: Record<string, string>;
    records: PolarRecord[];
}

export interface TmrDataset {
    variables: string[];
    zones: { name: string; rows: number[][] }[];
}

export interface CoordsDataset {
    upper: { x: number; y: number }[];
    lower: { x: number; y: number }[];
    format: string;
}

/** Caps mirror the parser module so committed JSON cannot force huge scans. */
export const MAX_DATASET_RECORDS = 10000;
export const MAX_DATASET_ZONES = 256;
export const MAX_DATASET_ROWS_PER_ZONE = 100000;
export const MAX_DATASET_COORDS = 10000;

function requireFiniteRecord(r: PolarRecord, name: string, idx: number): void {
    for (const k of ["alpha", "cl", "cd", "cdp", "cm", "topXtr", "botXtr"] as const) {
        if (!Number.isFinite(r[k])) {
            throw new Error(`datasets: ${name} record ${idx} field ${k} is not finite`);
        }
    }
}

function asPolar(raw: unknown, name: string): PolarDataset {
    const table = raw as PolarDataset;
    if (!Array.isArray(table.records) || table.records.length === 0) {
        throw new Error(`datasets: ${name} has no records`);
    }
    if (table.records.length > MAX_DATASET_RECORDS) {
        throw new Error(`datasets: ${name} has ${table.records.length} records, cap is ${MAX_DATASET_RECORDS}`);
    }
    table.records.forEach((r, i) => {
        if (r === null || typeof r !== "object") {
            throw new Error(`datasets: ${name} record ${i} is null or not an object`);
        }
        requireFiniteRecord(r, name, i);
    });
    if (typeof table.meta !== "object" || table.meta === null) {
        throw new Error(`datasets: ${name} meta must be an object`);
    }
    if (Object.keys(table.meta).length > 256) {
        throw new Error(`datasets: ${name} meta exceeds 256 entries`);
    }
    return table;
}

function asTmr(raw: unknown, name: string): TmrDataset {
    const table = raw as TmrDataset;
    if (!Array.isArray(table.variables) || table.variables.length === 0) {
        throw new Error(`datasets: ${name} has no variables`);
    }
    if (!Array.isArray(table.zones) || table.zones.length === 0) {
        throw new Error(`datasets: ${name} has no zones`);
    }
    if (table.zones.length > MAX_DATASET_ZONES) {
        throw new Error(`datasets: ${name} has too many zones`);
    }
    for (const z of table.zones) {
        if (z === null || typeof z !== "object") {
            throw new Error(`datasets: ${name} zone is null or not an object`);
        }
        if (typeof z.name !== "string") throw new Error(`datasets: ${name} zone name must be a string`);
        if (!Array.isArray(z.rows) || z.rows.length === 0) {
            throw new Error(`datasets: ${name} zone ${JSON.stringify(z.name)} has no rows`);
        }
        if (z.rows.length > MAX_DATASET_ROWS_PER_ZONE) {
            throw new Error(`datasets: ${name} zone ${JSON.stringify(z.name)} exceeds row cap`);
        }
        for (let i = 0; i < z.rows.length; i++) {
            const row = z.rows[i];
            if (!Array.isArray(row) || row.length !== table.variables.length) {
                throw new Error(
                    `datasets: ${name} zone ${JSON.stringify(z.name)} row ${i} has ${Array.isArray(row) ? row.length : "?"} values, expected ${table.variables.length}`,
                );
            }
            for (let j = 0; j < row.length; j++) {
                if (!Number.isFinite(row[j])) {
                    throw new Error(`datasets: ${name} zone ${JSON.stringify(z.name)} row ${i} col ${j} is not finite`);
                }
            }
        }
    }
    return table;
}

function asCoords(raw: unknown, name: string): CoordsDataset {
    const table = raw as CoordsDataset;
    for (const side of ["upper", "lower"] as const) {
        const pts = table[side];
        if (!Array.isArray(pts) || pts.length === 0) {
            throw new Error(`datasets: ${name} ${side} has no points`);
        }
        if (pts.length > MAX_DATASET_COORDS) {
            throw new Error(`datasets: ${name} ${side} exceeds coord cap`);
        }
        for (let i = 0; i < pts.length; i++) {
            const pt = pts[i] as unknown;
            if (pt === null || typeof pt !== "object") {
                throw new Error(`datasets: ${name} ${side}[${i}] is null or not an object`);
            }
            const coord = pt as { x: unknown; y: unknown };
            if (!Number.isFinite(coord.x) || !Number.isFinite(coord.y)) {
                throw new Error(`datasets: ${name} ${side}[${i}] is not finite`);
            }
        }
    }
    return table;
}

/** XFOIL NACA 0012 polar at Re 100k, Ncrit 9 (WARN display only). */
export const POLAR_0012_RE100K: PolarDataset = asPolar(polar0012Re100k, "0012 Re100k");

/** XFOIL NACA 0012 polar at Re 500k, Ncrit 9 (clean PASS anchor). */
export const POLAR_0012_RE500K: PolarDataset = asPolar(polar0012Re500k, "0012 Re500k");

/** XFOIL NACA 2412 polar at Re 100k, Ncrit 9 (WARN display only). */
export const POLAR_2412_RE100K: PolarDataset = asPolar(polar2412Re100k, "2412 Re100k");

/** XFOIL NACA 2412 polar at Re 500k, Ncrit 9 (clean PASS anchor). */
export const POLAR_2412_RE500K: PolarDataset = asPolar(polar2412Re500k, "2412 Re500k");

/** McCroskey best fit slope line at Re 6M M 0.15 (2 point fit line). */
export const MCCROSKEY_FIT: TmrDataset = asTmr(mccroskey, "McCroskey fit");

/** Ladson tripped force data at Re 6M M 0.15, zones per grit. */
export const LADSON_DATA: TmrDataset = asTmr(ladson, "Ladson data");

/** Gregory Cp at Re 2.88M, upper surface only, zones per alpha. */
export const GREGORY_CP: TmrDataset = asTmr(gregory, "Gregory Cp");

/** NACA 0012 coordinates, Lednicer format (upper then lower). */
export const COORDS_0012: CoordsDataset = asCoords(coords0012, "coords 0012");

/** NACA 2412 coordinates, Selig format (single TE to TE loop). */
export const COORDS_2412: CoordsDataset = asCoords(coords2412, "coords 2412");

/** Cl lookup at an exact alpha in a polar-like list, throws when missing. */
export function clAtAlpha(records: { alpha: number; cl: number }[], alpha: number): number {
    if (!Number.isFinite(alpha)) {
        throw new Error(`datasets: alpha must be finite, got ${String(alpha)}`);
    }
    for (const r of records) {
        if (!Number.isFinite(r.alpha) || !Number.isFinite(r.cl)) {
            throw new Error("datasets: polar record has non-finite alpha or cl");
        }
        if (Math.abs(r.alpha - alpha) < 1e-9) return r.cl;
    }
    throw new Error(`datasets: no polar record at alpha ${alpha}`);
}

/** Flat Cp records from Gregory zones, parsed from zone alpha labels. */
export function gregoryCpRecords(): CpRecord[] {
    return gregoryToCpRecords(GREGORY_CP);
}
