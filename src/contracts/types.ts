// GearFlow Phase 1 contracts. Single source of truth for geometry, grid, flow, provenance.
// Conventions: chord 1, LE at (0,0), TE at (1,0). World is y-up. Grid row-major idx = j * nx + i, j = 0 is bottom.

import type { ColormapName } from "@/flow/colormap";

export type GeometryKind = "naca4" | "cylinder" | "block" | "duct" | "custom";

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
  /** Custom polygon points in chord normalized coords, LE at (0,0), chord 1 (kind === custom) */
  polygon?: Array<{ x: number; y: number }>;
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

export interface LbmStats {
  samples: number;
  startStep: number;
  step: number;
  recircFraction: number;
  cdMean: number;
  clMean: number;
  clRms: number;
  strouhal: number | null;
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
  /** Time mean u from the LBM stats accumulator, absent before the first worker snapshot. */
  uMean?: Float32Array;
  /** Time mean v from the LBM stats accumulator, absent before the first worker snapshot. */
  vMean?: Float32Array;
  /** Turbulent kinetic energy from the LBM stats accumulator, absent before the first worker snapshot. */
  k?: Float32Array;
  /** Recirculation mask from the LBM stats accumulator, absent before the first worker snapshot. */
  recirc?: Float32Array;
  /** Turbulence statistics report, absent before the first worker snapshot. */
  lbmStats?: LbmStats;
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

/** Phase 4 Meta orchestration contracts. Spark, SAM, and image poster types. */

/** Spark spec proposal: geometry plus flow condition plus model rationale. */
export interface ParametricSpec {
  geometry: GeometrySpec;
  reynolds: number;
  rationale: string;
}

/** One actionable geometry tweak proposed by the race engineer. */
export interface SuggestedChange {
  field: string;
  from: number;
  to: number;
  rationale: string;
  predictedEffect: string;
}

/** Race engineer explanation for a completed run. */
export interface RaceEngineerResult {
  headline: string;
  explanation: string;
  suggestedChange: SuggestedChange;
  caveats: string;
}

/** One Meta API call record for the eval log panel. */
export interface EvalLogEntry {
  id: string;
  at: string;
  feature: string;
  model: string;
  latencyMs: number;
  costUsd: number;
  costEstimated: boolean;
  cached: boolean;
  ok: boolean;
  fallback: string | null;
  hash: string;
}

/** SAM segmentation outcome: chord normalized polygon plus quality flags. */
export interface SamResult {
  polygon: Array<{ x: number; y: number }>;
  maskIou: number;
  usedFallback: boolean;
  confidence: number;
}

/** One baked offline demo case. No network needed to serve these. */
export interface OfflineCase {
  id: string;
  label: string;
  spec: ParametricSpec;
  sparkPrompt: string;
  engineer: RaceEngineerResult;
  samPolygon: Array<{ x: number; y: number }>;
  poster: string;
}

/** Default Phase 1 domain shared by grid and fixtures. */
export const DEFAULT_DOMAIN: Domain = { xMin: -0.5, xMax: 2.0, yMin: -1.0, yMax: 1.0 };

/** Default Phase 1 grid: 128 x 128 per researcher note. */
export const DEFAULT_GRID: GridSpec = { nx: 128, ny: 128, domain: DEFAULT_DOMAIN };

/** Phase 6 conversational agent, display, and resolution contracts. */

/** One chat transcript row in the agent console. */
export interface ChatTurn {
    id: string;
    role: "user" | "assistant";
    text: string;
    at: string;
    tool?: "spark-spec" | "spark-engineer" | "sam" | "poster" | "chat";
    status?: "live" | "cached" | "fallback" | "offline";
    applied?: boolean;
    specSnapshot?: ParametricSpec;
}

/** Structured action the agent can take on a turn. */
export interface ChatAction {
    kind: "spec" | "explain" | "sam" | "poster";
    spec?: ParametricSpec;
    engineer?: RaceEngineerResult;
    sam?: SamResult;
    posterUrl?: string;
}

/** Selectable field quantity rendered on the tunnel canvas. */
export type FieldMode = "speed" | "cp" | "omega" | "u" | "v" | "k" | "recirc";

/** Supported solve grid sizes. Surrogate stays at 128, analytic may use 256. */
export type GridSize = 128 | 256;

export const GRID_128: GridSize = 128;
export const GRID_256: GridSize = 256;
export const GRID_OPTIONS: GridSize[] = [GRID_128, GRID_256];

/** User controlled display preferences, persisted to localStorage. */
export type ParticleColorMode = "auto" | "white" | "black" | "cyan" | "magenta" | "orange";

export interface DisplayPrefs {
    colormap: ColormapName;
    variable: FieldMode;
    theme: "dark" | "light";
    showLegend: boolean;
    fieldVisible: boolean;
    contours: boolean;
    particleCount: number;
    particleColor: ParticleColorMode;
    showStreamlines: boolean;
    meanFields: boolean;
}

/** Default Phase 6 display preferences. Dark is the default; the theme toggle also offers light. */
export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = {
    colormap: "viridis",
    variable: "speed",
    theme: "dark",
    showLegend: true,
    fieldVisible: true,
    contours: false,
    particleCount: 3000,
    particleColor: "auto",
    showStreamlines: false,
    meanFields: false,
};

/** Binary LBM1 frame spec (parser deferred to Phase 2). Documented here so Phase 1 fixtures stay compatible. */
export const LBM1_SPEC = {
  magic: 0x4c424d31,
  version: 1,
  headerBytes: 24,
  channelOrder: ["u", "v", "p", "omega", "obstacle"] as const,
  dtypeFlagFloat32: 0,
} as const;
