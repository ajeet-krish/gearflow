// Shared data contracts for the GearFlow WASM solver.
// Mirrors src/contracts/types.ts (GeometrySpec, GridSpec, FlowField) with
// serde renames so Rust parses the exact JSON the TS provider sends.
// This module is free of wasm-bindgen so `cargo test` runs on the host.

use serde::{Deserialize, Serialize};

/// NACA 4-digit parameters. Mirrors Naca4Params in contracts/types.ts.
#[derive(Clone, Debug, Deserialize)]
pub struct NacaParams {
    pub code: String,
    pub m: f64,
    pub p: f64,
    pub t: f64,
}

/// Chord normalized 2D point. Mirrors { x, y } point literals.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Xy {
    pub x: f64,
    pub y: f64,
}

/// Geometry spec. Mirrors GeometrySpec; JSON keys are camelCase.
/// kind is one of naca4, cylinder, block, orifice, custom.
/// For orifice, width is the plate thickness (0.02 to 0.2) and height is
/// the gap opening (0.05 to 1.8). A legacy "duct" kind still parses into
/// this struct, but public intakes migrate it: WasmLbmSolver::configure
/// runs migrate_legacy_duct, and the TS worker, bake validator, rail, and
/// App migrate or reject before the core. The duct_polygons helper and the
/// direct core branches stay for the Poiseuille channel fixture only.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometrySpec {
    pub kind: String,
    pub naca: Option<NacaParams>,
    pub chord: f64,
    pub alpha_deg: f64,
    pub n_points: usize,
    pub radius: Option<f64>,
    pub center: Option<Xy>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub polygon: Option<Vec<Xy>>,
}

/// World domain bounds. Mirrors Domain.
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Domain {
    pub x_min: f64,
    pub x_max: f64,
    pub y_min: f64,
    pub y_max: f64,
}

/// Solve grid. Mirrors GridSpec.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct GridSpec {
    pub nx: usize,
    pub ny: usize,
    pub domain: Domain,
}

/// Full flow field with f32 channels. Mirrors FlowField.
#[derive(Clone, Debug)]
pub struct FlowField {
    pub nx: usize,
    pub ny: usize,
    pub domain: Domain,
    pub u: Vec<f32>,
    pub v: Vec<f32>,
    pub p: Vec<f32>,
    pub omega: Vec<f32>,
    pub obstacle: Vec<f32>,
}

/// Panel solve summary returned by resolve calls.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveSummary {
    pub cl: f64,
    pub cp_min: f64,
    pub panel_count: usize,
}

/// Exact circle body used for cylinder masks. Mirrors CircleDef in sdf.ts.
#[derive(Clone, Copy, Debug)]
pub struct CircleDef {
    pub x: f64,
    pub y: f64,
    pub r: f64,
}

/// Orifice plate bounds. Mirrors the TS ORIFICE_* constants in
/// src/contracts/types.ts and the schema envelope in
/// src/contracts/schema.ts.
pub const ORIFICE_GAP_MIN: f64 = 0.05;
pub const ORIFICE_GAP_MAX: f64 = 1.8;
pub const ORIFICE_GAP_DEFAULT: f64 = 0.4;
pub const ORIFICE_THICKNESS_MIN: f64 = 0.02;
pub const ORIFICE_THICKNESS_MAX: f64 = 0.2;
pub const ORIFICE_THICKNESS_DEFAULT: f64 = 0.08;
pub const ORIFICE_WALL_HALF: f64 = 1.5;

/// Hard alpha envelope in degrees. Mirrors ALPHA_HARD_MIN/MAX.
pub const ALPHA_HARD_MIN: f64 = -180.0;
pub const ALPHA_HARD_MAX: f64 = 180.0;
/// Characterized alpha band. Mirrors ALPHA_MIN/MAX.
pub const ALPHA_MIN: f64 = -4.0;
pub const ALPHA_MAX: f64 = 12.0;
