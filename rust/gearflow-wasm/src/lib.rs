// WASM boundary for the GearFlow solver. Only this module uses
// wasm-bindgen; the core modules (geometry, potential, sdf, wake, field,
// types) stay dependency free so `cargo test` runs on the host.

mod field;
mod geometry;
mod potential;
mod sdf;
mod types;
mod wake;

use crate::field::{field_from_resolved, resolve_body, ResolvedBody};
use crate::types::{Domain, GeometrySpec, GridSpec, ResolveSummary};
use wasm_bindgen::prelude::*;

/// Allocation caps mirrored from the TS schema (MAX_NX, MAX_NY, MAX_CELLS).
pub const MAX_NX: usize = 512;
pub const MAX_NY: usize = 512;
pub const MAX_CELLS: usize = 262144;

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
}
