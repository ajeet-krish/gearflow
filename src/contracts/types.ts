// GearFlow Phase 1 contracts. Single source of truth for geometry, grid, flow, provenance.
// Conventions: chord 1, LE at (0,0), TE at (1,0). World is y-up. Grid row-major idx = j * nx + i, j = 0 is bottom.

import type { ColormapName } from "@/flow/colormap";

export type GeometryKind = "naca4" | "cylinder" | "block" | "orifice" | "custom";

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
  /** Block extents; orifice plate thickness (width) and gap opening (height) */
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
    tool?: "spark-spec" | "spark-engineer" | "sam" | "poster" | "chat" | "baseten";
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

/** Phase B2 body token for the solver bar BODY select. Custom shapes go through set_spec. */
export type BodyToken = "naca0012" | "naca2412" | "naca4412" | "cylinder" | "block" | "orifice";

/** Phase B2 engine token. Analytic, wasm, and lbm drive the engine switch, surrogate drives the solve mode. */
export type AgentEngineToken = "analytic" | "wasm" | "lbm" | "surrogate";

/** Phase B2 agent action union. Bounds match the canvas controls: alpha in [-180, 180], reynolds in [100, 1000000]. */
export type AgentAction =
    | { kind: "set_body"; body: BodyToken }
    | { kind: "set_alpha"; alphaDeg: number }
    | { kind: "set_reynolds"; reynolds: number }
    | { kind: "set_engine"; engine: AgentEngineToken }
    | { kind: "set_field"; field: FieldMode }
    | { kind: "run_lbm" }
    | { kind: "cancel_lbm" }
    | { kind: "set_spec"; spec: ParametricSpec }
    | { kind: "setup_shedding" }
    | { kind: "setup_high_pressure"; body?: BodyToken }
    | { kind: "setup_airfoil"; body?: BodyToken; alphaDeg?: number };

/** Selectable field quantity rendered on the tunnel canvas. */
export type FieldMode = "speed" | "cp" | "omega" | "u" | "v" | "k" | "recirc";

/** Supported solve grid sizes. Surrogate stays at 128, analytic may use 64, 128, or 256. */
export type GridPreset = 64 | 128 | 256;
/** Effective solve grid size: a preset or a custom square side. */
export type GridSize = GridPreset | (number & {});

export const GRID_64: GridPreset = 64;
export const GRID_128: GridPreset = 128;
export const GRID_256: GridPreset = 256;
export const GRID_OPTIONS: GridPreset[] = [GRID_64, GRID_128, GRID_256];

/** Custom square grid bounds. Squares from 32 to 512 inclusive. */
export const CUSTOM_GRID_MIN = 32;
export const CUSTOM_GRID_MAX = 512;

/** Orifice plate bounds. Width is plate thickness, height is the gap opening. */
export const ORIFICE_GAP_MIN = 0.05;
export const ORIFICE_GAP_MAX = 1.8;
export const ORIFICE_GAP_DEFAULT = 0.4;
export const ORIFICE_THICKNESS_MIN = 0.02;
export const ORIFICE_THICKNESS_MAX = 0.2;
export const ORIFICE_THICKNESS_DEFAULT = 0.08;
export const ORIFICE_WALL_HALF = 1.5;

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
    particleSize: number;
    overlayPinned: boolean;
    overlayPinnedField: FieldMode | null;
}

/** Particle point size in world units. Clamped to the usable band below. */
export const PARTICLE_SIZE_DEFAULT = 0.018;
export const PARTICLE_SIZE_MIN = 0.008;
export const PARTICLE_SIZE_MAX = 0.036;

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
    particleSize: PARTICLE_SIZE_DEFAULT,
    overlayPinned: false,
    overlayPinnedField: null,
};

/** Binary LBM1 frame spec (parser deferred to Phase 2). Documented here so Phase 1 fixtures stay compatible. */
export const LBM1_SPEC = {
  magic: 0x4c424d31,
  version: 1,
  headerBytes: 24,
  channelOrder: ["u", "v", "p", "omega", "obstacle"] as const,
  dtypeFlagFloat32: 0,
} as const;
