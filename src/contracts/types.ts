// GearFlow Phase 1 contracts. Single source of truth for geometry, grid, flow, provenance.
// Conventions: chord 1, LE at (0,0), TE at (1,0). World is y-up. Grid row-major idx = j * nx + i, j = 0 is bottom.

export type GeometryKind = "naca4" | "cylinder" | "block" | "duct";

export interface Naca4Params {
  /** 4 digit code, e.g. "2412" */
  code: string;
  /** Max camber as fraction of chord */
  m: number;
  /** Camber position as fraction of chord */
  p: number;
  /** Max thickness as fraction of chord */
  t: number;
}

export interface GeometrySpec {
  kind: GeometryKind;
  /** NACA params when kind is naca4 */
  naca?: Naca4Params;
  /** Chord length, default 1 */
  chord: number;
  /** Angle of attack in degrees */
  alphaDeg: number;
  /** Points per surface for polygon generation */
  nPoints: number;
  /** Cylinder radius (kind === cylinder) */
  radius?: number;
  /** Cylinder or block center */
  center?: { x: number; y: number };
  /** Block or duct extents */
  width?: number;
  height?: number;
}

export interface Domain {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

export interface GridSpec {
  nx: number;
  ny: number;
  domain: Domain;
}

export interface FlowField {
  nx: number;
  ny: number;
  domain: Domain;
  /** Row-major Float32Array, idx = j * nx + i, j = 0 is bottom row (yMin) */
  u: Float32Array;
  v: Float32Array;
  p: Float32Array;
  omega: Float32Array;
  obstacle: Float32Array;
}

export type ProvenanceSource = "fake-fixture" | "analytic-potential" | "lbm-binary" | "surrogate" | "meta-sam" | "meta-spark" | "meta-image";

/** Phase 3 validation tiers. PASS blocks the demo, WARN needs a note, INFO is display only. */
export type ValidationTier = "PASS" | "WARN" | "INFO";

/** Per row outcome. WARN tier rows never report pass, they report warn inside the review band. */
export type ValidationStatus = "pass" | "warn" | "fail" | "info";

/** One row of an AirfoilTools style polar (CSV primary, TXT fallback). */
export interface PolarRecord {
    alpha: number;
    cl: number;
    cd: number;
    cdp: number;
    cm: number;
    topXtr: number;
    botXtr: number;
}

/** One Cp sample from a Tecplot style Cp DAT zone (Gregory data, upper surface only). */
export interface CpRecord {
    alpha: number;
    x: number;
    cp: number;
}

/** One rendered validation panel row: expected vs got with tolerance and provenance. */
export interface ValidationRow {
    id: string;
    label: string;
    tier: ValidationTier;
    status: ValidationStatus;
    expected: string;
    got: string;
    tolerance: string;
    source: string;
    note?: string;
}

/** Per frame surrogate backend report attached to provenance. */
export interface SurrogateMeta {
    backend: string;
    latencyMs: number;
    cached: boolean;
    weightsVersion: string;
}

export interface Provenance {
  source: ProvenanceSource;
  /** Human readable label, e.g. "Fake fixture, not physics" */
  label: string;
  generatedAt: string;
  gridLabel: string;
  geometryLabel: string;
  note?: string;
}

export interface DemoPackMeta {
  spark: { prompt: string; summary: string; model: string };
  sam: { prompt: string; summary: string; model: string };
  image: { prompt: string; summary: string; model: string };
}

export interface DemoPack {
  name: string;
  version: number;
  geometry: GeometrySpec;
  grid: GridSpec;
  provenance: Provenance;
  meta: DemoPackMeta;
  files: {
    geometry: string;
    flow: string;
  };
}

/** Default Phase 1 domain shared by grid and fixtures. */
export const DEFAULT_DOMAIN: Domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };

/** Default Phase 1 grid: 128 x 128 per researcher note. */
export const DEFAULT_GRID: GridSpec = { nx: 128, ny: 128, domain: DEFAULT_DOMAIN };

/** Binary LBM1 frame spec (parser deferred to Phase 2). Documented here so Phase 1 fixtures stay compatible. */
export const LBM1_SPEC = {
  magic: 0x4c424d31,
  version: 1,
  headerBytes: 24,
  channelOrder: ["u", "v", "p", "omega", "obstacle"] as const,
  dtypeFlagFloat32: 0,
} as const;
