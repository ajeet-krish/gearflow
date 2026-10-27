// Full analytic pipeline ported from src/flow/analyticFlow.ts.
// resolve_body builds polygons, panels with exact cylinder circles, and the
// panel solution. field_from_resolved evaluates velocity, applies the wake,
// caps speed, sets Bernoulli pressure, central difference vorticity, zeroes
// obstacles, and sweeps for finiteness. f64 internally, f32 at output.
// Pure math, no wasm-bindgen, host testable.

use crate::geometry::build_polygons;
use crate::potential::{build_panels, panel_velocity, solve_bodies, Panel, PanelSolution};
use crate::sdf::build_sdf_grid;
use crate::types::{CircleDef, Domain, FlowField, GeometrySpec, GridSpec, ResolveSummary, Xy};
use crate::wake::{apply_wake, WakeParams};

pub struct ResolvedBody {
    pub polygons: Vec<Vec<Xy>>,
    pub panels: Vec<Panel>,
    pub sol: PanelSolution,
    pub circles: Vec<CircleDef>,
}

/// Closed airfoil check: at least 3 finite points with a chord-like x extent.
pub fn is_closed_airfoil(polygon: &[Xy]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut min_x = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    for p in polygon {
        if !p.x.is_finite() || !p.y.is_finite() {
            return false;
        }
        if p.x < min_x {
            min_x = p.x;
        }
        if p.x > max_x {
            max_x = p.x;
        }
    }
    max_x - min_x >= 0.1
}

/// Build polygons, panels with exact cylinder circles, and the panel solution.
pub fn resolve_body(geom: &GeometrySpec, u: f64) -> Result<(ResolvedBody, ResolveSummary), String> {
    if !u.is_finite() || u <= 0.0 {
        return Err(format!("resolve_body: U must be positive, got {u}"));
    }
    if !geom.chord.is_finite() || geom.chord <= 0.0 {
        return Err("resolve_body: chord must be positive".to_string());
    }
    let polygons = build_polygons(geom)?;
    let mut bodies: Vec<Vec<Panel>> = Vec::with_capacity(polygons.len());
    for poly in &polygons {
        bodies.push(build_panels(poly)?);
    }
    // Kutta applies to lifting airfoil bodies: NACA 4-digit sections and
    // closed custom airfoil polygons. Blunt bodies keep gamma 0.
    let kutta: Vec<bool> = polygons
        .iter()
        .map(|poly| geom.kind == "naca4" || (geom.kind == "custom" && is_closed_airfoil(poly)))
        .collect();
    let sol = solve_bodies(&bodies, u, geom.chord, &kutta)?;
    if !sol.cl.is_finite() {
        return Err("resolve_body: non-finite cl (singular panel evaluation)".to_string());
    }
    for c in &sol.cp {
        if !c.is_finite() {
            return Err("resolve_body: non-finite cp (singular panel evaluation)".to_string());
        }
    }
    let panels = sol.panels.clone();
    let mut circles: Vec<CircleDef> = Vec::new();
    if geom.kind == "cylinder" {
        let c = geom.center.unwrap_or(Xy { x: 0.5, y: 0.0 });
        circles.push(CircleDef { x: c.x, y: c.y, r: geom.radius.unwrap_or(0.25) });
    }
    let cp_min = sol.cp.iter().cloned().fold(f64::INFINITY, f64::min);
    let summary = ResolveSummary { cl: sol.cl, cp_min, panel_count: panels.len() };
    Ok((ResolvedBody { polygons, panels, sol, circles }, summary))
}

/// Evaluate the full field from a cached panel solution. Re is wake only.
pub fn field_from_resolved(
    grid: &GridSpec,
    geom: &GeometrySpec,
    body: &ResolvedBody,
    u: f64,
    re: f64,
) -> Result<FlowField, String> {
    if grid.nx < 4 || grid.ny < 4 {
        return Err("field_from_resolved: nx and ny must be >= 4".to_string());
    }
    if grid.nx > 512 || grid.ny > 512 {
        return Err("field_from_resolved: nx and ny must be <= 512".to_string());
    }
    if grid.nx.saturating_mul(grid.ny) > 262144 {
        return Err("field_from_resolved: nx*ny must be <= 262144".to_string());
    }
    if !(grid.domain.x_max > grid.domain.x_min) || !(grid.domain.y_max > grid.domain.y_min) {
        return Err("field_from_resolved: domain bounds must be ordered".to_string());
    }
    if !u.is_finite() || u <= 0.0 {
        return Err(format!("field_from_resolved: U must be positive, got {u}"));
    }
    if !re.is_finite() || re <= 0.0 {
        return Err(format!("field_from_resolved: Re must be positive, got {re}"));
    }
    let (nx, ny) = (grid.nx, grid.ny);
    let domain: Domain = grid.domain;
    let n = nx * ny;
    let (_sdf, obstacle) = build_sdf_grid(&body.polygons, nx, ny, domain, &body.circles)?;
    let mut uu = vec![0.0f32; n];
    let mut vv = vec![0.0f32; n];
    let mut pp = vec![0.0f32; n];
    let mut omega = vec![0.0f32; n];
    let dx = (domain.x_max - domain.x_min) / (nx - 1) as f64;
    let dy = (domain.y_max - domain.y_min) / (ny - 1) as f64;
    for j in 0..ny {
        let y = domain.y_min + dy * j as f64;
        for i in 0..nx {
            let k = j * nx + i;
            if obstacle[k] > 0.5 {
                continue;
            }
            let x = domain.x_min + dx * i as f64;
            let (vel_u, vel_v) = panel_velocity(x, y, &body.sol, u)?;
            uu[k] = vel_u as f32;
            vv[k] = vel_v as f32;
        }
    }
    let mut base_y = geom.center.map(|c| c.y).unwrap_or(0.0);
    if geom.kind == "naca4" {
        if let Some(first) = body.polygons.first() {
            if !first.is_empty() {
                let sum: f64 = first.iter().map(|pt| pt.y).sum();
                base_y = sum / first.len() as f64;
            }
        }
    }
    let slope = -((geom.alpha_deg * std::f64::consts::PI) / 180.0).tan() * 0.5;
    apply_wake(
        &mut uu,
        &mut vv,
        nx,
        ny,
        domain,
        &obstacle,
        WakeParams { u, re, base_y, slope, x_wake: 0.8 },
    )?;
    let cap = 3.0 * u;
    for k in 0..n {
        if obstacle[k] > 0.5 {
            continue;
        }
        let sp = (uu[k] as f64).hypot(vv[k] as f64);
        if sp > cap && sp > 0.0 {
            let s = cap / sp;
            uu[k] = (uu[k] as f64 * s) as f32;
            vv[k] = (vv[k] as f64 * s) as f32;
        }
    }
    let half_u2 = 0.5 * u * u;
    for k in 0..n {
        if obstacle[k] > 0.5 {
            continue;
        }
        pp[k] = (half_u2 - 0.5 * ((uu[k] as f64) * (uu[k] as f64) + (vv[k] as f64) * (vv[k] as f64))) as f32;
    }
    for j in 0..ny {
        for i in 0..nx {
            let k = j * nx + i;
            if obstacle[k] > 0.5 {
                omega[k] = 0.0;
                continue;
            }
            let i_l = if i > 0 { i - 1 } else { i };
            let i_r = if i + 1 < nx { i + 1 } else { i };
            let j_b = if j > 0 { j - 1 } else { j };
            let j_t = if j + 1 < ny { j + 1 } else { j };
            let denom_x = (i_r - i_l) as f64 * dx;
            let denom_y = (j_t - j_b) as f64 * dy;
            let denom_x = if denom_x == 0.0 { 1.0 } else { denom_x };
            let denom_y = if denom_y == 0.0 { 1.0 } else { denom_y };
            let dvdx = (vv[j * nx + i_r] as f64 - vv[j * nx + i_l] as f64) / denom_x;
            let dudy = (uu[j_t * nx + i] as f64 - uu[j_b * nx + i] as f64) / denom_y;
            omega[k] = (dvdx - dudy) as f32;
        }
    }
    for k in 0..n {
        if obstacle[k] > 0.5 {
            uu[k] = 0.0;
            vv[k] = 0.0;
            pp[k] = 0.0;
            omega[k] = 0.0;
        }
    }
    let mut non_finite_count = 0;
    for k in 0..n {
        if obstacle[k] > 0.5 {
            continue;
        }
        if !uu[k].is_finite() || !vv[k].is_finite() || !pp[k].is_finite() || !omega[k].is_finite() {
            non_finite_count += 1;
        }
    }
    if non_finite_count > 0 {
        return Err(format!(
            "field_from_resolved: {non_finite_count} non-finite field values (singular panel evaluation)"
        ));
    }
    Ok(FlowField { nx, ny, domain, u: uu, v: vv, p: pp, omega, obstacle })
}

/// Full pipeline: resolve panels, then evaluate the field.
pub fn generate_flow(
    grid: &GridSpec,
    geom: &GeometrySpec,
    u: f64,
    re: f64,
) -> Result<(FlowField, ResolveSummary), String> {
    let (body, mut summary) = resolve_body(geom, u)?;
    let field = field_from_resolved(grid, geom, &body, u, re)?;
    if !summary.cl.is_finite() {
        return Err("generate_flow: non-finite cl".to_string());
    }
    if !summary.cp_min.is_finite() {
        return Err("generate_flow: non-finite cp_min".to_string());
    }
    summary.panel_count = body.panels.len();
    Ok((field, summary))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Domain, NacaParams};

    fn naca_geom() -> GeometrySpec {
        GeometrySpec {
            kind: "naca4".to_string(),
            naca: Some(NacaParams { code: "2412".to_string(), m: 0.02, p: 0.4, t: 0.12 }),
            chord: 1.0,
            alpha_deg: 6.0,
            n_points: 60,
            radius: None,
            center: None,
            width: None,
            height: None,
            polygon: None,
        }
    }

    fn grid() -> GridSpec {
        GridSpec {
            nx: 32,
            ny: 24,
            domain: Domain { x_min: -0.5, x_max: 2.0, y_min: -1.0, y_max: 1.0 },
        }
    }

    #[test]
    fn pipeline_produces_finite_lifting_field() {
        let geom = naca_geom();
        let (field, summary) = generate_flow(&grid(), &geom, 1.0, 1000.0).unwrap();
        assert!(summary.cl > 0.3, "cl = {}", summary.cl);
        assert!(summary.cp_min < 0.0);
        assert!(summary.panel_count > 0);
        assert_eq!(field.u.len(), 32 * 24);
        assert!(field.obstacle.iter().any(|&o| o > 0.5));
        assert!(field.obstacle.iter().any(|&o| o <= 0.5));
        // Obstacle cells are exactly zeroed.
        for k in 0..field.u.len() {
            if field.obstacle[k] > 0.5 {
                assert_eq!(field.u[k], 0.0);
                assert_eq!(field.v[k], 0.0);
                assert_eq!(field.p[k], 0.0);
                assert_eq!(field.omega[k], 0.0);
            }
        }
    }

    #[test]
    fn cylinder_has_zero_lift() {
        let geom = GeometrySpec {
            kind: "cylinder".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: Some(0.25),
            center: Some(Xy { x: 0.5, y: 0.0 }),
            width: None,
            height: None,
            polygon: None,
        };
        let (_field, summary) = generate_flow(&grid(), &geom, 1.0, 1000.0).unwrap();
        assert!(summary.cl.abs() < 1e-9, "cl = {}", summary.cl);
    }

    #[test]
    fn rejects_oversize_grid_before_allocation() {
        let geom = naca_geom();
        let (body, _) = resolve_body(&geom, 1.0).unwrap();
        let big = GridSpec {
            nx: 1024,
            ny: 1024,
            domain: Domain { x_min: -0.5, x_max: 2.0, y_min: -1.0, y_max: 1.0 },
        };
        assert!(field_from_resolved(&big, &geom, &body, 1.0, 1000.0).is_err());
        let wide = GridSpec {
            nx: 513,
            ny: 8,
            domain: Domain { x_min: -0.5, x_max: 2.0, y_min: -1.0, y_max: 1.0 },
        };
        assert!(field_from_resolved(&wide, &geom, &body, 1.0, 1000.0).is_err());
    }
}
