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
