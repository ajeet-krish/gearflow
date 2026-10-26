// Runtime validators for Phase 1 contracts. Throw on invalid input with a clear message.
// Mirrors src/contracts/schemas/*.json (geometry, grid, flowfield, provenance,
// demopack). Keep both in sync when either changes.

import type { DemoPack, FlowField, GeometrySpec, GridSpec, ParametricSpec, RaceEngineerResult } from "./types";

function isFiniteNumber(x: unknown): x is number {
    return typeof x === "number" && Number.isFinite(x);
}

function isNonEmptyString(x: unknown): x is string {
    return typeof x === "string" && x.length > 0;
}

function checkStringLength(value: string, field: string, max: number): void {
    if (value.length > max) {
        throw new Error(`${field} must be <= ${max} chars, got ${value.length}`);
    }
}

/** Allocation caps: crafted manifests must not force huge typed arrays or textures. */
export const MAX_NX = 512;
export const MAX_NY = 512;
export const MAX_CELLS = 262144;
export const MAX_NPOINTS = 4096;
export const MAX_AIRFOIL_POINTS = 8192;

/** Chord normalized envelope: chord is always 1, magnitudes stay bounded. */
export const CHORD_VALUE = 1;
export const RADIUS_MAX = 1;
export const EXTENT_MAX = 3;
export const CENTER_X_MIN = -1;
export const CENTER_X_MAX = 3;
export const CENTER_Y_MIN = -2;
export const CENTER_Y_MAX = 2;

/** Spark spec string and point caps. */
export const SPARK_NPOINTS_MAX = 160;
export const RATIONALE_MAX = 500;
export const HEADLINE_MAX = 500;
export const EXPLANATION_MAX = 2000;
export const CAVEATS_MAX = 2000;
export const CHANGE_FIELD_MAX = 500;

/**
 * Validated UI envelope (matches the FlowControls sliders). The solver is
 * only characterized inside this envelope; wider geometry still parses at
 * the polygon level but is rejected here so providers cannot bypass it.
 */
export const ALPHA_MIN = -4;
export const ALPHA_MAX = 12;
export const NACA_M_MIN = 0;
export const NACA_M_MAX_ENV = 0.09;
export const NACA_T_MIN = 0.06;
export const NACA_T_MAX_ENV = 0.18;
export const NACA_P_MIN = 0.2;
export const NACA_P_MAX = 0.8;

/** Allowlisted fixture file paths. Rejects traversal, absolute paths, backslashes, schemes. */
export const PACK_FILE_RE = /^(geometry|flow)\/[A-Za-z0-9._-]+\.json$/;

export function validatePackFilePath(p: unknown): asserts p is string {
    if (!isNonEmptyString(p)) throw new Error("DemoPack.files entry must be a non-empty path string");
    if (p.includes("\\") || p.includes("..") || p.startsWith("/") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(p)) {
        throw new Error(`DemoPack.files entry is not an allowed fixture path: ${p}`);
    }
    if (!PACK_FILE_RE.test(p)) {
        throw new Error(`DemoPack.files entry must match geometry/<name>.json or flow/<name>.json, got ${p}`);
    }
}

export function validateGeometrySpec(g: unknown): asserts g is GeometrySpec {
    if (typeof g !== "object" || g === null) throw new Error("GeometrySpec must be an object");
    const spec = g as Record<string, unknown>;
    const kinds = ["naca4", "cylinder", "block", "duct", "custom"];
    if (!kinds.includes(spec.kind as string)) throw new Error(`GeometrySpec.kind must be one of ${kinds.join(", ")}`);
    if (!isFiniteNumber(spec.chord) || (spec.chord as number) <= 0) {
        throw new Error("GeometrySpec.chord must be a positive finite number");
    }
    if (Math.abs((spec.chord as number) - CHORD_VALUE) > 1e-9) {
        throw new Error(`GeometrySpec.chord must be ${CHORD_VALUE} (chord normalized), got ${spec.chord as number}`);
    }
    if (!isFiniteNumber(spec.alphaDeg)) throw new Error("GeometrySpec.alphaDeg must be finite");
    if ((spec.alphaDeg as number) < ALPHA_MIN || (spec.alphaDeg as number) > ALPHA_MAX) {
        throw new Error(`GeometrySpec.alphaDeg must be in [${ALPHA_MIN}, ${ALPHA_MAX}], got ${spec.alphaDeg as number}`);
    }
    if (!Number.isInteger(spec.nPoints) || (spec.nPoints as number) < 4) {
        throw new Error("GeometrySpec.nPoints must be an integer >= 4");
    }
    if ((spec.nPoints as number) > MAX_NPOINTS) {
        throw new Error(`GeometrySpec.nPoints must be <= ${MAX_NPOINTS}`);
    }
    if (spec.kind === "naca4") {
        const naca = spec.naca as Record<string, unknown> | undefined;
        if (!naca || typeof naca.code !== "string" || naca.code.length !== 4) {
            throw new Error("GeometrySpec.naca.code must be a 4 character string");
        }
        for (const k of ["m", "p", "t"] as const) {
            if (!isFiniteNumber(naca[k])) throw new Error(`GeometrySpec.naca.${k} must be finite`);
        }
        const m = naca.m as number;
        const p = naca.p as number;
        const t = naca.t as number;
        if (!(m >= NACA_M_MIN && m <= NACA_M_MAX_ENV)) throw new Error(`GeometrySpec.naca.m must be in [${NACA_M_MIN}, ${NACA_M_MAX_ENV}], got ${m}`);
        if (m > 1e-10 && !(p >= NACA_P_MIN && p <= NACA_P_MAX)) {
            throw new Error(`GeometrySpec.naca.p must be in [${NACA_P_MIN}, ${NACA_P_MAX}] when m > 0, got ${p}`);
        }
        if (!(t >= NACA_T_MIN && t <= NACA_T_MAX_ENV)) throw new Error(`GeometrySpec.naca.t must be in [${NACA_T_MIN}, ${NACA_T_MAX_ENV}], got ${t}`);
    }
    if (spec.kind === "cylinder") {
        if (!isFiniteNumber(spec.radius) || (spec.radius as number) <= 0) {
            throw new Error("GeometrySpec.radius must be a positive finite number for kind cylinder");
        }
        if ((spec.radius as number) > RADIUS_MAX) {
            throw new Error(`GeometrySpec.radius must be <= ${RADIUS_MAX}, got ${spec.radius as number}`);
        }
    }
    if (spec.kind === "block" || spec.kind === "duct") {
        for (const k of ["width", "height"] as const) {
            if (spec[k] !== undefined && (!isFiniteNumber(spec[k]) || (spec[k] as number) <= 0)) {
                throw new Error(`GeometrySpec.${k} must be a positive finite number for kind ${spec.kind as string}`);
            }
            if (spec[k] !== undefined && (spec[k] as number) > EXTENT_MAX) {
                throw new Error(`GeometrySpec.${k} must be <= ${EXTENT_MAX}, got ${spec[k] as number}`);
            }
        }
    }
    if (spec.kind === "custom") {
        validateSamPolygon(spec.polygon);
    }
    if (spec.center !== undefined) {
        const c = spec.center as Record<string, unknown>;
        if (!isFiniteNumber(c.x) || !isFiniteNumber(c.y)) {
            throw new Error("GeometrySpec.center must have finite x and y");
        }
        if ((c.x as number) < CENTER_X_MIN || (c.x as number) > CENTER_X_MAX) {
            throw new Error(`GeometrySpec.center.x must be in [${CENTER_X_MIN}, ${CENTER_X_MAX}], got ${c.x as number}`);
        }
        if ((c.y as number) < CENTER_Y_MIN || (c.y as number) > CENTER_Y_MAX) {
            throw new Error(`GeometrySpec.center.y must be in [${CENTER_Y_MIN}, ${CENTER_Y_MAX}], got ${c.y as number}`);
        }
    }
}

export function validateGridSpec(g: unknown): asserts g is GridSpec {
    if (typeof g !== "object" || g === null) throw new Error("GridSpec must be an object");
    const spec = g as Record<string, unknown>;
    if (!Number.isInteger(spec.nx) || (spec.nx as number) < 4) throw new Error("GridSpec.nx must be an integer >= 4");
    if (!Number.isInteger(spec.ny) || (spec.ny as number) < 4) throw new Error("GridSpec.ny must be an integer >= 4");
    if ((spec.nx as number) > MAX_NX) throw new Error(`GridSpec.nx must be <= ${MAX_NX}`);
    if ((spec.ny as number) > MAX_NY) throw new Error(`GridSpec.ny must be <= ${MAX_NY}`);
    if ((spec.nx as number) * (spec.ny as number) > MAX_CELLS) {
        throw new Error(`GridSpec nx*ny must be <= ${MAX_CELLS}`);
    }
    const d = spec.domain as Record<string, unknown> | undefined;
    if (!d) throw new Error("GridSpec.domain is required");
    for (const k of ["xMin", "xMax", "yMin", "yMax"] as const) {
        if (!isFiniteNumber(d[k])) throw new Error(`GridSpec.domain.${k} must be finite`);
    }
    if ((d.xMax as number) <= (d.xMin as number)) throw new Error("GridSpec.domain.xMax must exceed xMin");
    if ((d.yMax as number) <= (d.yMin as number)) throw new Error("GridSpec.domain.yMax must exceed yMin");
}

function checkChannel(name: string, arr: unknown, n: number): void {
    if (!(arr instanceof Float32Array) && !Array.isArray(arr)) {
        throw new Error(`FlowField.${name} must be a Float32Array or number[]`);
    }
    const len = (arr as { length: number }).length;
    if (len !== n) throw new Error(`FlowField.${name} length ${len} does not match nx*ny ${n} (truncated array)`);
    const seq = arr as ArrayLike<unknown>;
    for (let i = 0; i < len; i++) {
        const v = seq[i];
        if (typeof v !== "number" || !Number.isFinite(v)) {
            throw new Error(`FlowField.${name}[${i}] must be a finite number`);
        }
    }
}

export function validateFlowField(f: unknown): asserts f is FlowField {
    if (typeof f !== "object" || f === null) throw new Error("FlowField must be an object");
    const flow = f as Record<string, unknown>;
    validateGridSpec({ nx: flow.nx, ny: flow.ny, domain: flow.domain });
    const nx = flow.nx as number;
    const ny = flow.ny as number;
    const n = nx * ny;
    for (const k of ["u", "v", "p", "omega", "obstacle"] as const) {
        checkChannel(k, flow[k], n);
    }
}

function validateMeta(m: unknown): void {
    if (typeof m !== "object" || m === null) throw new Error("DemoPack.meta is required");
    const meta = m as Record<string, unknown>;
    for (const k of ["spark", "sam", "image"] as const) {
        const entry = meta[k] as Record<string, unknown> | undefined;
        if (typeof entry !== "object" || entry === null) throw new Error(`DemoPack.meta.${k} is required`);
        for (const f of ["prompt", "summary", "model"] as const) {
            if (!isNonEmptyString(entry[f])) throw new Error(`DemoPack.meta.${k}.${f} must be a non-empty string`);
        }
    }
}

export function validateDemoPack(p: unknown): asserts p is DemoPack {
    if (typeof p !== "object" || p === null) throw new Error("DemoPack must be an object");
    const pack = p as Record<string, unknown>;
    if (typeof pack.name !== "string" || pack.name.length === 0) throw new Error("DemoPack.name is required");
    if (!Number.isInteger(pack.version) || (pack.version as number) < 1) {
        throw new Error("DemoPack.version must be an integer >= 1");
    }
    validateGeometrySpec(pack.geometry);
    validateGridSpec(pack.grid);
    const prov = pack.provenance as Record<string, unknown> | undefined;
    if (!prov || typeof prov.source !== "string") throw new Error("DemoPack.provenance.source is required");
    if (prov.source !== "fake-fixture") throw new Error(`Phase 1 DemoPack.provenance.source must be fake-fixture, got ${String(prov.source)}`);
    for (const f of ["label", "generatedAt", "gridLabel", "geometryLabel"] as const) {
        if (!isNonEmptyString(prov[f])) throw new Error(`DemoPack.provenance.${f} must be a non-empty string`);
    }
    validateMeta(pack.meta);
    const files = pack.files as Record<string, unknown> | undefined;
    if (typeof files !== "object" || files === null) throw new Error("DemoPack.files is required");
    for (const f of ["geometry", "flow"] as const) {
        try {
            validatePackFilePath(files[f]);
        } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            throw new Error(`DemoPack.files.${f} invalid: ${reason}`);
        }
    }
}

/** Airfoil polygon points loaded from a geometry fixture file. */
export function validateAirfoilPoints(points: unknown, opts?: { requireNonEmpty?: boolean }): void {
    if (!Array.isArray(points)) throw new Error("airfoilPoints must be an array");
    if (points.length > MAX_AIRFOIL_POINTS) {
        throw new Error(`airfoilPoints length must be <= ${MAX_AIRFOIL_POINTS}`);
    }
    if ((opts?.requireNonEmpty ?? false) && points.length === 0) {
        throw new Error("airfoilPoints must be non-empty for airfoil geometry");
    }
    for (let i = 0; i < points.length; i++) {
        const pt = points[i] as Record<string, unknown>;
        if (typeof pt !== "object" || pt === null || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
            throw new Error(`airfoilPoints[${i}] must have finite x and y`);
        }
    }
}

/** Assert a loaded flow field matches the pack grid (nx, ny, domain). */
export function validatePackFlowConsistency(pack: DemoPack, flow: FlowField): void {
    if (flow.nx !== pack.grid.nx || flow.ny !== pack.grid.ny) {
        throw new Error(
            `FlowField grid ${flow.nx}x${flow.ny} does not match pack.grid ${pack.grid.nx}x${pack.grid.ny}`
        );
    }
    const a = flow.domain;
    const b = pack.grid.domain;
    if (a.xMin !== b.xMin || a.xMax !== b.xMax || a.yMin !== b.yMin || a.yMax !== b.yMax) {
        throw new Error("FlowField.domain does not match pack.grid.domain");
    }
}

/** Coerce a JSON flow payload (number[] channels) into a FlowField with Float32Array channels. */
export function coerceFlowField(json: {
    nx: number;
    ny: number;
    domain: { xMin: number; xMax: number; yMin: number; yMax: number };
    u: number[];
    v: number[];
    p: number[];
    omega: number[];
    obstacle: number[];
}): FlowField {
    // Enforce caps before any allocation so crafted nx/ny cannot force huge buffers.
    validateGridSpec({ nx: json.nx, ny: json.ny, domain: json.domain });
    const n = json.nx * json.ny;
    const toF32 = (name: string, a: number[]): Float32Array => {
        if (!Array.isArray(a)) throw new Error(`FlowField.${name} must be an array`);
        if (a.length !== n) throw new Error(`FlowField.${name} length ${a.length} does not match nx*ny ${n} (truncated array)`);
        for (let i = 0; i < a.length; i++) {
            if (typeof a[i] !== "number" || !Number.isFinite(a[i])) {
                throw new Error(`FlowField.${name}[${i}] must be a finite number`);
            }
        }
        return new Float32Array(a);
    };
    const field: FlowField = {
        nx: json.nx,
        ny: json.ny,
        domain: json.domain,
        u: toF32("u", json.u),
        v: toF32("v", json.v),
        p: toF32("p", json.p),
        omega: toF32("omega", json.omega),
        obstacle: toF32("obstacle", json.obstacle),
    };
    validateFlowField(field);
    return field;
}

/** Deep equality for plain JSON values (objects, arrays, primitives). */
function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => deepEqual(v, (b as unknown[])[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ka = Object.keys(ao);
    const kb = Object.keys(bo);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/** Assert a loaded geometry fixture file matches the validated manifest geometry. */
export function validateLoadedGeometryMatchesPack(packGeometry: GeometrySpec, loaded: unknown): void {
    if (!deepEqual(loaded, packGeometry)) {
        throw new Error("Geometry fixture file does not match pack.geometry");
    }
    validateGeometrySpec(loaded);
}

/** SAM polygon bounds shared by custom geometry specs and SAM outputs. */
export const SAM_POLYGON_MIN_POINTS = 3;
export const SAM_POLYGON_MAX_POINTS = 160;
export const SAM_POLYGON_Y_MIN = -1;
export const SAM_POLYGON_Y_MAX = 1;

/**
 * Chord normalized polygon check: 3 to 160 finite points, x in [0, 1],
 * y within [-1, 1]. Used for custom GeometrySpec.polygon and SAM outputs.
 */
export function validateSamPolygon(points: unknown): asserts points is Array<{ x: number; y: number }> {
    if (!Array.isArray(points)) throw new Error("polygon must be an array");
    if (points.length < SAM_POLYGON_MIN_POINTS || points.length > SAM_POLYGON_MAX_POINTS) {
        throw new Error(
            `polygon must have ${SAM_POLYGON_MIN_POINTS} to ${SAM_POLYGON_MAX_POINTS} points, got ${points.length}`
        );
    }
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < points.length; i++) {
        const pt = points[i] as Record<string, unknown>;
        if (typeof pt !== "object" || pt === null || !isFiniteNumber(pt.x) || !isFiniteNumber(pt.y)) {
            throw new Error(`polygon[${i}] must have finite x and y`);
        }
        const x = pt.x as number;
        const y = pt.y as number;
        if (y < SAM_POLYGON_Y_MIN || y > SAM_POLYGON_Y_MAX) {
            throw new Error(`polygon[${i}].y ${y} is outside chord normalized bounds [${SAM_POLYGON_Y_MIN}, ${SAM_POLYGON_Y_MAX}]`);
        }
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
    }
    if (minX < -0.05 || maxX > 1.05) {
        throw new Error(`polygon x range [${minX.toFixed(3)}, ${maxX.toFixed(3)}] is outside chord normalized bounds near [0, 1]`);
    }
    if (maxX - minX < 0.1) {
        throw new Error("polygon x extent is too narrow for a chord normalized body");
    }
}

/** Reynolds number envelope for Spark proposed specs. */
export const RE_MIN = 1000;
export const RE_MAX = 1000000;

export function validateParametricSpec(p: unknown): asserts p is ParametricSpec {
    if (typeof p !== "object" || p === null) throw new Error("ParametricSpec must be an object");
    const spec = p as Record<string, unknown>;
    if (typeof spec.rationale !== "string" || spec.rationale.length === 0) {
        throw new Error("ParametricSpec.rationale must be a non-empty string");
    }
    checkStringLength(spec.rationale as string, "ParametricSpec.rationale", RATIONALE_MAX);
    if (!isFiniteNumber(spec.reynolds) || (spec.reynolds as number) < RE_MIN || (spec.reynolds as number) > RE_MAX) {
        throw new Error(`ParametricSpec.reynolds must be finite in [${RE_MIN}, ${RE_MAX}]`);
    }
    validateGeometrySpec(spec.geometry);
    const geom = spec.geometry as GeometrySpec;
    if (geom.nPoints > SPARK_NPOINTS_MAX) {
        throw new Error(`ParametricSpec.geometry.nPoints must be <= ${SPARK_NPOINTS_MAX} for Spark specs, got ${geom.nPoints}`);
    }
}

export function validateEngineerResult(r: unknown): asserts r is RaceEngineerResult {
    if (typeof r !== "object" || r === null) throw new Error("RaceEngineerResult must be an object");
    const res = r as Record<string, unknown>;
    for (const f of ["headline", "explanation", "caveats"] as const) {
        if (typeof res[f] !== "string" || (res[f] as string).length === 0) {
            throw new Error(`RaceEngineerResult.${f} must be a non-empty string`);
        }
    }
    checkStringLength(res.headline as string, "RaceEngineerResult.headline", HEADLINE_MAX);
    checkStringLength(res.explanation as string, "RaceEngineerResult.explanation", EXPLANATION_MAX);
    checkStringLength(res.caveats as string, "RaceEngineerResult.caveats", CAVEATS_MAX);
    const change = res.suggestedChange as Record<string, unknown> | undefined;
    if (typeof change !== "object" || change === null) throw new Error("RaceEngineerResult.suggestedChange is required");
    if (typeof change.field !== "string" || change.field.length === 0) {
        throw new Error("RaceEngineerResult.suggestedChange.field must be a non-empty string");
    }
    checkStringLength(change.field as string, "RaceEngineerResult.suggestedChange.field", CHANGE_FIELD_MAX);
    for (const f of ["from", "to"] as const) {
        if (!isFiniteNumber(change[f])) throw new Error(`RaceEngineerResult.suggestedChange.${f} must be finite`);
    }
    for (const f of ["rationale", "predictedEffect"] as const) {
        if (typeof change[f] !== "string" || (change[f] as string).length === 0) {
            throw new Error(`RaceEngineerResult.suggestedChange.${f} must be a non-empty string`);
        }
        checkStringLength(change[f] as string, `RaceEngineerResult.suggestedChange.${f}`, CHANGE_FIELD_MAX);
    }
}
