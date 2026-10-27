// WASM boundary for the GearFlow solver. Only this module uses
// wasm-bindgen; the core modules (geometry, potential, sdf, wake, field,
// types) stay dependency free so `cargo test` runs on the host.

pub mod boundaries;
pub mod field;
pub mod forces;
pub mod geometry;
pub mod lattice;
pub mod lbm;
pub mod potential;
pub mod sdf;
pub mod stats;
pub mod types;
pub mod wake;

use crate::field::{field_from_resolved, resolve_body, ResolvedBody};
use crate::lbm::{LbmConfig, LbmState, MAX_STATS_START_STEP};
use crate::types::{Domain, GeometrySpec, GridSpec, ResolveSummary};
use wasm_bindgen::prelude::*;

/// Allocation caps mirrored from the TS schema (MAX_NX, MAX_NY, MAX_CELLS).
pub const MAX_NX: usize = 512;
pub const MAX_NY: usize = 512;
pub const MAX_CELLS: usize = 262144;

/// Maximum accepted geometry JSON payload in bytes. Checked before any
/// parse so a huge payload cannot reach serde_json. Mirrors
/// MAX_GEOM_JSON_BYTES in the TS protocol validator.
pub const MAX_GEOM_JSON_BYTES: usize = 65536;

/// Host testable geometry payload check used by WasmLbmSolver::configure.
/// Returns Err naming the limit when the payload is oversized.
pub fn check_geom_json_len(len: usize) -> Result<(), String> {
    if len > MAX_GEOM_JSON_BYTES {
        return Err(format!(
            "WasmLbmSolver.configure: geometry JSON {len} bytes exceeds MAX_GEOM_JSON_BYTES of {MAX_GEOM_JSON_BYTES} bytes"
        ));
    }
    Ok(())
}

/// Host testable statistics start step check used by WasmLbmSolver::configure.
/// None means 0 (no transient cut, which preserves the previous four
/// argument behaviour). Values above MAX_STATS_START_STEP are rejected.
/// The binding never sees the run target, so a cut at or past the target
/// is accepted here and simply yields few or no samples once the run
/// passes it.
pub fn resolve_stats_start_step(stats_start_step: Option<u32>) -> Result<u64, String> {
    let start = stats_start_step.unwrap_or(0) as u64;
    if start > MAX_STATS_START_STEP {
        return Err(format!(
            "WasmLbmSolver.configure: stats_start_step {start} exceeds cap {MAX_STATS_START_STEP}"
        ));
    }
    Ok(start)
}

/// Cached solver holding the grid plus the last resolved body.
/// resolve() caches panels; field() reuses them (Re changes skip re-solve).
#[wasm_bindgen]
pub struct WasmSolver {
    grid: GridSpec,
    cached_geom_json: Option<String>,
    cached_u: f64,
    cached_body: Option<ResolvedBody>,
    cached_summary: Option<ResolveSummary>,
}

/// Host testable grid dimension check, mirrored in WasmSolver::new.
/// Returns Err when the grid would exceed the TS allocation caps.
pub fn validate_grid_dims(nx: usize, ny: usize) -> Result<(), String> {
    if nx < 4 || ny < 4 {
        return Err("WasmSolver: nx and ny must be integers >= 4".to_string());
    }
    if nx > MAX_NX || ny > MAX_NY {
        return Err("WasmSolver: nx and ny must be <= 512".to_string());
    }
    if nx.saturating_mul(ny) > MAX_CELLS {
        return Err("WasmSolver: nx*ny must be <= 262144".to_string());
    }
    Ok(())
}

#[wasm_bindgen]
impl WasmSolver {
    /// Create a solver for an nx by ny grid over the given domain.
    #[wasm_bindgen(constructor)]
    pub fn new(
        nx: usize,
        ny: usize,
        xmin: f64,
        xmax: f64,
        ymin: f64,
        ymax: f64,
    ) -> Result<WasmSolver, JsValue> {
        validate_grid_dims(nx, ny).map_err(|e| JsValue::from_str(&e))?;
        for (name, v) in [("xmin", xmin), ("xmax", xmax), ("ymin", ymin), ("ymax", ymax)] {
            if !v.is_finite() {
                return Err(JsValue::from_str(&format!("WasmSolver: {name} must be finite")));
            }
        }
        if !(xmax > xmin) || !(ymax > ymin) {
            return Err(JsValue::from_str("WasmSolver: domain max must exceed min"));
        }
        Ok(WasmSolver {
            grid: GridSpec {
                nx,
                ny,
                domain: Domain { x_min: xmin, x_max: xmax, y_min: ymin, y_max: ymax },
            },
            cached_geom_json: None,
            cached_u: f64::NAN,
            cached_body: None,
            cached_summary: None,
        })
    }

    /// Resolve panels for a geometry JSON plus freestream speed.
    /// Returns { cl, cpMin, panelCount }.
    pub fn resolve(&mut self, geom_json: &str, u_inf: f64) -> Result<JsValue, JsValue> {
        if !u_inf.is_finite() || u_inf <= 0.0 {
            return Err(JsValue::from_str("WasmSolver.resolve: u_inf must be positive"));
        }
        let geom: GeometrySpec = serde_json::from_str(geom_json)
            .map_err(|e| JsValue::from_str(&format!("WasmSolver.resolve: bad geometry JSON: {e}")))?;
        let (body, summary) = resolve_body(&geom, u_inf).map_err(|e| JsValue::from_str(&e))?;
        self.cached_geom_json = Some(geom_json.to_string());
        self.cached_u = u_inf;
        self.cached_summary = Some(summary);
        self.cached_body = Some(body);
        #[allow(deprecated)]
        let js = JsValue::from_serde(&summary)
            .map_err(|e| JsValue::from_str(&format!("WasmSolver.resolve: serialize failed: {e}")));
        js
    }

    /// Evaluate the field at (u_inf, re) using the cached panels.
    /// Call resolve() first. Returns { nx, ny, domain, u, v, p, omega,
    /// obstacle } with Float32Array channels.
    pub fn field(&mut self, u_inf: f64, re: f64) -> Result<JsValue, JsValue> {
        if !u_inf.is_finite() || u_inf <= 0.0 {
            return Err(JsValue::from_str("WasmSolver.field: u_inf must be positive"));
        }
        if !re.is_finite() || re <= 0.0 {
            return Err(JsValue::from_str("WasmSolver.field: re must be positive"));
        }
        // Re-resolve if U drifted since the cached solve (panels scale with U).
        if self.cached_body.is_none() || u_inf != self.cached_u {
            let json = self
                .cached_geom_json
                .clone()
                .ok_or_else(|| JsValue::from_str("WasmSolver.field: call resolve() first"))?;
            let geom: GeometrySpec = serde_json::from_str(&json)
                .map_err(|e| JsValue::from_str(&format!("WasmSolver.field: bad cached geometry: {e}")))?;
            let (body, summary) = resolve_body(&geom, u_inf).map_err(|e| JsValue::from_str(&e))?;
            self.cached_u = u_inf;
            self.cached_summary = Some(summary);
            self.cached_body = Some(body);
        }
        let body = self
            .cached_body
            .as_ref()
            .ok_or_else(|| JsValue::from_str("WasmSolver.field: call resolve() first"))?;
        let geom_json = self
            .cached_geom_json
            .clone()
            .ok_or_else(|| JsValue::from_str("WasmSolver.field: call resolve() first"))?;
        let geom: GeometrySpec = serde_json::from_str(&geom_json)
            .map_err(|e| JsValue::from_str(&format!("WasmSolver.field: bad cached geometry: {e}")))?;
        let field =
            field_from_resolved(&self.grid, &geom, body, u_inf, re).map_err(|e| JsValue::from_str(&e))?;
        let obj = js_sys::Object::new();
        let set = |key: &str, value: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(key), value)
                .map_err(|_| JsValue::from_str("WasmSolver.field: serialize failed"))
        };
        set("nx", &JsValue::from_f64(field.nx as f64))?;
        set("ny", &JsValue::from_f64(field.ny as f64))?;
        let domain = js_sys::Object::new();
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("xMin"),
            &JsValue::from_f64(field.domain.x_min),
        )
        .map_err(|_| JsValue::from_str("WasmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("xMax"),
            &JsValue::from_f64(field.domain.x_max),
        )
        .map_err(|_| JsValue::from_str("WasmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("yMin"),
            &JsValue::from_f64(field.domain.y_min),
        )
        .map_err(|_| JsValue::from_str("WasmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("yMax"),
            &JsValue::from_f64(field.domain.y_max),
        )
        .map_err(|_| JsValue::from_str("WasmSolver.field: serialize failed"))?;
        set("domain", &domain.into())?;
        set("u", &js_sys::Float32Array::from(field.u.as_slice()).into())?;
        set("v", &js_sys::Float32Array::from(field.v.as_slice()).into())?;
        set("p", &js_sys::Float32Array::from(field.p.as_slice()).into())?;
        set("omega", &js_sys::Float32Array::from(field.omega.as_slice()).into())?;
        set("obstacle", &js_sys::Float32Array::from(field.obstacle.as_slice()).into())?;
        Ok(obj.into())
    }

    /// Panel count from the last resolve, or 0 when nothing is cached.
    pub fn panel_count(&self) -> usize {
        self.cached_summary.map(|s| s.panel_count).unwrap_or(0)
    }
}

/// Viscous LBM solver binding. Mirrors the host LbmState API.
/// Construction validates grid caps plus square cells; configure()
/// builds the state; run_steps() advances in bounded batches.
#[wasm_bindgen]
pub struct WasmLbmSolver {
    grid: GridSpec,
    state: Option<LbmState>,
    geom_json: Option<String>,
}

#[wasm_bindgen]
impl WasmLbmSolver {
    /// Create an LBM solver grid. Rejects non-square cells with a
    /// corrected ny in the message.
    #[wasm_bindgen(constructor)]
    pub fn new(
        nx: usize,
        ny: usize,
        xmin: f64,
        xmax: f64,
        ymin: f64,
        ymax: f64,
    ) -> Result<WasmLbmSolver, JsValue> {
        validate_grid_dims(nx, ny).map_err(|e| JsValue::from_str(&e))?;
        for (name, v) in [("xmin", xmin), ("xmax", xmax), ("ymin", ymin), ("ymax", ymax)] {
            if !v.is_finite() {
                return Err(JsValue::from_str(&format!("WasmLbmSolver: {name} must be finite")));
            }
        }
        if !(xmax > xmin) || !(ymax > ymin) {
            return Err(JsValue::from_str("WasmLbmSolver: domain max must exceed min"));
        }
        let dx = (xmax - xmin) / (nx - 1) as f64;
        let dy = (ymax - ymin) / (ny - 1) as f64;
        if dx > 0.0 && dy > 0.0 {
            let rel = ((dx - dy).abs() / dx.max(dy)).abs();
            if rel > 0.01 {
                let ny_fix = (((ymax - ymin) / dx) + 1.0).round() as usize;
                let ny_fix = ny_fix.max(4);
                return Err(JsValue::from_str(&format!(
                    "lbm: non-square cells (dx {dx:.6}, dy {dy:.6} differ by {:.2} percent), try ny {ny_fix} for square cells",
                    rel * 100.0
                )));
            }
        }
        Ok(WasmLbmSolver {
            grid: GridSpec {
                nx,
                ny,
                domain: Domain { x_min: xmin, x_max: xmax, y_min: ymin, y_max: ymax },
            },
            state: None,
            geom_json: None,
        })
    }

    /// Configure geometry plus flow parameters. A legacy duct kind migrates
    /// to the orifice plate above, so the duct arm below only serves direct
    /// core callers (the Poiseuille channel validation fixture); every
    /// other body including the orifice plate uses uniform plus convective.
    /// stats_start_step is the optional
    /// transient cut for time statistics (None means 0, no cut).
    /// Values above MAX_STATS_START_STEP are rejected. The binding does
    /// not know the run target, so a cut at or past the target is not
    /// rejected here (it yields few or no samples). Reconfigure rebuilds
    /// the state, so the new cut replaces the old one. reset() keeps the
    /// configured cut.
    pub fn configure(
        &mut self,
        geom_json: &str,
        re: f64,
        u_lattice: f64,
        les_enabled: bool,
        stats_start_step: Option<u32>,
    ) -> Result<(), JsValue> {
        check_geom_json_len(geom_json.len())
            .map_err(|e| JsValue::from_str(&e))?;
        let parsed: GeometrySpec = serde_json::from_str(geom_json)
            .map_err(|e| JsValue::from_str(&format!("WasmLbmSolver.configure: bad geometry JSON: {e}")))?;
        // Retired duct intake migrates to the orifice plate so a legacy
        // worker JSON or direct Wasm caller runs the orifice migration
        // instead of the retired channel body. Mirrors the TS rail and App
        // migration through migrateDuctToOrifice.
        let geom = crate::geometry::migrate_legacy_duct(&parsed).unwrap_or(parsed);
        let (inlet, outlet) = if geom.kind == "duct" {
            (
                crate::boundaries::InletProfile::Parabolic,
                crate::boundaries::OutletKind::ZeroGradient,
            )
        } else {
            (
                crate::boundaries::InletProfile::Uniform,
                crate::boundaries::OutletKind::Convective,
            )
        };
        let stats_start_step = resolve_stats_start_step(stats_start_step)
            .map_err(|e| JsValue::from_str(&e))?;
        let cfg = LbmConfig {
            u_lattice,
            re,
            les_enabled,
            inlet,
            outlet,
            stats_start_step,
            ..LbmConfig::default()
        };
        let state =
            LbmState::new(&self.grid, &geom, &cfg).map_err(|e| JsValue::from_str(&e))?;
        self.geom_json = Some(geom_json.to_string());
        self.state = Some(state);
        Ok(())
    }

    /// Advance up to n steps (bounded by max_steps_per_call).
    /// Returns { stepsDone, step, cd, cl, cancelled, diverged }.
    pub fn run_steps(&mut self, n: u64) -> Result<JsValue, JsValue> {
        let st = self
            .state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WasmLbmSolver.run_steps: call configure() first"))?;
        let rep = st.run_steps(n).map_err(|e| JsValue::from_str(&e))?;
        let obj = js_sys::Object::new();
        let set = |key: &str, value: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(key), value)
                .map_err(|_| JsValue::from_str("WasmLbmSolver.run_steps: serialize failed"))
        };
        set("stepsDone", &JsValue::from_f64(rep.steps_done as f64))?;
        set("step", &JsValue::from_f64(rep.step as f64))?;
        set("cd", &JsValue::from_f64(rep.cd))?;
        set("cl", &JsValue::from_f64(rep.cl))?;
        set("cancelled", &JsValue::from_bool(rep.cancelled))?;
        set("diverged", &JsValue::from_bool(rep.diverged))?;
        Ok(obj.into())
    }

    /// Request cancellation. State stays intact and resumable.
    pub fn cancel(&mut self) {
        if let Some(st) = self.state.as_mut() {
            st.cancel();
        }
    }

    /// Clear a pending cancel so stepping can continue. Leaves the field,
    /// step count, forces, and statistics untouched. Errors when diverged.
    pub fn resume(&mut self) -> Result<(), JsValue> {
        let st = self
            .state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WasmLbmSolver.resume: call configure() first"))?;
        st.resume().map_err(|e| JsValue::from_str(&e))?;
        Ok(())
    }

    /// Restore the initial condition, clear stats and history.
    pub fn reset(&mut self) -> Result<(), JsValue> {
        let st = self
            .state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WasmLbmSolver.reset: call configure() first"))?;
        st.reset().map_err(|e| JsValue::from_str(&e))?;
        Ok(())
    }

    /// Single lattice step. Returns { step, cd, cl }.
    /// Errors when cancelled (call resume() first) or diverged.
    pub fn step(&mut self) -> Result<JsValue, JsValue> {
        let st = self
            .state
            .as_mut()
            .ok_or_else(|| JsValue::from_str("WasmLbmSolver.step: call configure() first"))?;
        if st.poisoned {
            return Err(JsValue::from_str(&format!(
                "WasmLbmSolver.step: diverged at step {}, call reset()",
                st.poison_step
            )));
        }
        if st.cancelled {
            return Err(JsValue::from_str(&format!(
                "WasmLbmSolver.step: cancelled at step {}, call resume() to continue",
                st.step
            )));
        }
        st.step_once().map_err(|e| JsValue::from_str(&e))?;
        let obj = js_sys::Object::new();
        let set = |key: &str, value: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(key), value)
                .map_err(|_| JsValue::from_str("WasmLbmSolver.step: serialize failed"))
        };
        set("step", &JsValue::from_f64(st.step as f64))?;
        set("cd", &JsValue::from_f64(st.force.cd))?;
        set("cl", &JsValue::from_f64(st.force.cl))?;
        Ok(obj.into())
    }

    /// Current drag coefficient.
    pub fn cd(&self) -> f64 {
        self.state.as_ref().map(|s| s.force.cd).unwrap_or(0.0)
    }

    /// Current lift coefficient.
    pub fn cl(&self) -> f64 {
        self.state.as_ref().map(|s| s.force.cl).unwrap_or(0.0)
    }

    /// Field snapshot with the same object shape as WasmSolver::field.
    pub fn field(&self) -> Result<JsValue, JsValue> {
        let st = self
            .state
            .as_ref()
            .ok_or_else(|| JsValue::from_str("WasmLbmSolver.field: call configure() first"))?;
        let field = st.snapshot();
        let obj = js_sys::Object::new();
        let set = |key: &str, value: &JsValue| {
            js_sys::Reflect::set(&obj, &JsValue::from_str(key), value)
                .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))
        };
        set("nx", &JsValue::from_f64(field.nx as f64))?;
        set("ny", &JsValue::from_f64(field.ny as f64))?;
        let domain = js_sys::Object::new();
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("xMin"),
            &JsValue::from_f64(field.domain.x_min),
        )
        .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("xMax"),
            &JsValue::from_f64(field.domain.x_max),
        )
        .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("yMin"),
            &JsValue::from_f64(field.domain.y_min),
        )
        .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))?;
        js_sys::Reflect::set(
            &domain,
            &JsValue::from_str("yMax"),
            &JsValue::from_f64(field.domain.y_max),
        )
        .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))?;
        set("domain", &domain.into())?;
        set("u", &js_sys::Float32Array::from(field.u.as_slice()).into())?;
        set("v", &js_sys::Float32Array::from(field.v.as_slice()).into())?;
        set("p", &js_sys::Float32Array::from(field.p.as_slice()).into())?;
        set("omega", &js_sys::Float32Array::from(field.omega.as_slice()).into())?;
        set("obstacle", &js_sys::Float32Array::from(field.obstacle.as_slice()).into())?;
        // Mean and turbulence channels from the stats accumulator.
        // Solid cells and the zero sample state read 0, all values are
        // finite at the source so no NaN or infinite crosses the boundary.
        let (u_mean, v_mean, k, recirc) = st.stats_fields();
        set("uMean", &js_sys::Float32Array::from(u_mean.as_slice()).into())?;
        set("vMean", &js_sys::Float32Array::from(v_mean.as_slice()).into())?;
        set("k", &js_sys::Float32Array::from(k.as_slice()).into())?;
        set("recirc", &js_sys::Float32Array::from(recirc.as_slice()).into())?;
        let rep = st.stats_report();
        let stats_obj = js_sys::Object::new();
        let set_stat = |key: &str, value: &JsValue| {
            js_sys::Reflect::set(&stats_obj, &JsValue::from_str(key), value)
                .map_err(|_| JsValue::from_str("WasmLbmSolver.field: serialize failed"))
        };
        let finite_f64 = |x: f64| {
            if x.is_finite() {
                x
            } else {
                0.0
            }
        };
        set_stat("samples", &JsValue::from_f64(rep.samples as f64))?;
        set_stat("startStep", &JsValue::from_f64(rep.start_step as f64))?;
        set_stat("step", &JsValue::from_f64(rep.step as f64))?;
        set_stat("recircFraction", &JsValue::from_f64(finite_f64(rep.recirc_fraction)))?;
        set_stat("cdMean", &JsValue::from_f64(finite_f64(rep.cd_mean)))?;
        set_stat("clMean", &JsValue::from_f64(finite_f64(rep.cl_mean)))?;
        set_stat("clRms", &JsValue::from_f64(finite_f64(rep.cl_rms)))?;
        match rep.strouhal {
            Some(v) if v.is_finite() && v > 0.0 => {
                set_stat("strouhal", &JsValue::from_f64(v))?;
            }
            _ => {
                set_stat("strouhal", &JsValue::null())?;
            }
        }
        set("stats", &stats_obj.into())?;
        Ok(obj.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grid_dims_reject_tiny_grids() {
        assert!(validate_grid_dims(2, 2).is_err());
    }

    #[test]
    fn grid_dims_reject_oversize_grids_before_allocation() {
        assert!(validate_grid_dims(513, 8).is_err());
        assert!(validate_grid_dims(8, 513).is_err());
        assert!(validate_grid_dims(1024, 1024).is_err());
    }

    #[test]
    fn grid_dims_accept_valid_grid() {
        assert!(validate_grid_dims(32, 24).is_ok());
    }

    #[test]
    fn geom_json_cap_accepts_limit_rejects_over() {
        assert!(check_geom_json_len(MAX_GEOM_JSON_BYTES).is_ok());
        assert!(check_geom_json_len(0).is_ok());
        let err = check_geom_json_len(MAX_GEOM_JSON_BYTES + 1).unwrap_err();
        assert!(err.contains("MAX_GEOM_JSON_BYTES"), "err = {err}");
        assert!(err.contains("65536"), "err = {err}");
    }

    fn stats_cut_test_grid() -> GridSpec {
        GridSpec {
            nx: 96,
            ny: 48,
            domain: Domain { x_min: 0.0, x_max: 1.9, y_min: -0.47, y_max: 0.47 },
        }
    }

    fn stats_cut_test_geom_json() -> String {
        "{\"kind\":\"cylinder\",\"chord\":1.0,\"alphaDeg\":0.0,\"nPoints\":64,\"radius\":0.12,\"center\":{\"x\":0.55,\"y\":0.0}}".to_string()
    }

    fn stats_cut_test_solver() -> WasmLbmSolver {
        let grid = stats_cut_test_grid();
        WasmLbmSolver::new(
            grid.nx,
            grid.ny,
            grid.domain.x_min,
            grid.domain.x_max,
            grid.domain.y_min,
            grid.domain.y_max,
        )
        .ok()
        .unwrap()
    }

    #[test]
    fn stats_start_step_helper_defaults_and_rejects() {
        assert_eq!(resolve_stats_start_step(None).unwrap(), 0);
        assert_eq!(resolve_stats_start_step(Some(8000)).unwrap(), 8000);
        assert_eq!(resolve_stats_start_step(Some(2_000_000)).unwrap(), 2_000_000);
        let err = resolve_stats_start_step(Some(2_000_001)).unwrap_err();
        assert!(err.contains("exceeds cap"), "err = {err}");
        assert!(err.contains("2000000"), "err = {err}");
        // The full u32 range reaches the check without truncation, so the
        // top of the range is rejected, never panics.
        assert!(resolve_stats_start_step(Some(u32::MAX)).is_err());
    }

    #[test]
    fn configure_without_stats_cut_reports_start_zero() {
        let mut solver = stats_cut_test_solver();
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, None)
            .is_ok());
        let rep = solver.state.as_ref().unwrap().stats_report();
        assert_eq!(rep.start_step, 0);
        assert_eq!(rep.samples, 0);
    }

    #[test]
    fn configure_with_stats_cut_gates_transient() {
        let mut solver = stats_cut_test_solver();
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, Some(8000))
            .is_ok());
        let rep = solver.state.as_ref().unwrap().stats_report();
        assert_eq!(rep.start_step, 8000);
        assert_eq!(rep.samples, 0);
        let st = solver.state.as_mut().unwrap();
        while st.step < 8100 {
            let want = (8100 - st.step).min(512);
            st.run_steps(want).unwrap();
        }
        let rep = solver.state.as_ref().unwrap().stats_report();
        assert_eq!(rep.step, 8100);
        assert_eq!(rep.start_step, 8000);
        // Steps 8000, 8010, up to 8100 sample once every 10 steps.
        assert_eq!(rep.samples, 11);
    }

    #[test]
    fn reconfigure_replaces_stats_cut() {
        let mut solver = stats_cut_test_solver();
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, Some(8000))
            .is_ok());
        assert_eq!(solver.state.as_ref().unwrap().stats_report().start_step, 8000);
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, None)
            .is_ok());
        assert_eq!(solver.state.as_ref().unwrap().stats_report().start_step, 0);
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, Some(100))
            .is_ok());
        assert_eq!(solver.state.as_ref().unwrap().stats_report().start_step, 100);
    }

    #[test]
    fn configure_rejects_stats_cut_above_cap() {
        // The binding maps resolve_stats_start_step errors into JsValue,
        // and JsValue construction aborts on the host (wasm-bindgen has
        // no JS heap here), so host tests assert the helper plus the
        // host core guard. The one line map_err between them is covered
        // by compilation and the wasm-pack build.
        let err = resolve_stats_start_step(Some(2_000_001)).unwrap_err();
        assert!(err.contains("exceeds cap"), "err = {err}");
        let mut cfg = LbmConfig::default();
        cfg.stats_start_step = MAX_STATS_START_STEP + 1;
        let grid = stats_cut_test_grid();
        let geom: GeometrySpec = serde_json::from_str(&stats_cut_test_geom_json()).unwrap();
        let err = LbmState::new(&grid, &geom, &cfg).unwrap_err();
        assert!(err.contains("exceeds cap"), "err = {err}");
    }

    #[test]
    fn reset_keeps_configured_stats_cut() {
        let mut solver = stats_cut_test_solver();
        assert!(solver
            .configure(&stats_cut_test_geom_json(), 40.0, 0.06, false, Some(50))
            .is_ok());
        solver.state.as_mut().unwrap().run_steps(100).unwrap();
        let rep = solver.state.as_ref().unwrap().stats_report();
        assert_eq!(rep.start_step, 50);
        // Steps 50, 60, 70, 80, 90, 100 sample once every 10 steps.
        assert_eq!(rep.samples, 6);
        solver.state.as_mut().unwrap().reset().unwrap();
        let rep = solver.state.as_ref().unwrap().stats_report();
        assert_eq!(rep.step, 0);
        assert_eq!(rep.samples, 0);
        assert_eq!(rep.start_step, 50);
    }
}
