// Constant source plus per-body vortex panel solver, ported from
// src/flow/potential.ts (Hess and Smith style). Closed bodies only: N
// constant source strengths plus one vortex strength per lifting body. Each
// Kutta body contributes one Kutta equation (trailing edge tangential
// velocities sum to zero). Sequential Gaussian elimination, no parallelism,
// so the op order (and rounding) matches the TS reference exactly.
// Pure math, no wasm-bindgen, host testable.

use crate::geometry::{dedup_closed, polygon_signed_area};
use crate::types::Xy;

/// Hard cap on panels per body so the dense solve stays interactive.
pub const MAX_PANELS: usize = 160;
/// Hard cap on total unknowns (panels plus Kutta rows).
pub const MAX_TOTAL_PANELS: usize = 320;
/// Distance guard that keeps near singular evaluations finite.
pub const SINGULARITY_GUARD: f64 = 1e-9;

#[derive(Clone, Copy, Debug)]
pub struct Panel {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub xc: f64,
    pub yc: f64,
    pub tx: f64,
    pub ty: f64,
    pub nx: f64,
    pub ny: f64,
    pub len: f64,
}

pub struct PanelSolution {
    pub panels: Vec<Panel>,
    pub sigma: Vec<f64>,
    /// Legacy single gamma: gammas[0] for single-body solves, 0 when no Kutta body.
    pub gamma: f64,
    /// Per-body vortex strength, index aligns with the bodies slice.
    pub gammas: Vec<f64>,
    /// Body index per panel in panels order.
    pub panel_body: Vec<usize>,
    /// Pressure coefficient per panel, 1 - (Vt / U)^2.
    pub cp: Vec<f64>,
    /// Lift coefficient from pressure integration, referenced to chord_ref.
    pub cl: f64,
}

/// Convert a closed polygon into panels. Deduplicates the closing point,
/// stride caps to MAX_PANELS, enforces CCW (outward normals), and builds
/// collocation points plus tangent and outward normal frames.
pub fn build_panels(points: &[Xy]) -> Result<Vec<Panel>, String> {
    if points.len() < 3 {
        return Err(format!(
            "build_panels: polygon must have at least 3 points, got {}",
            points.len()
        ));
    }
    for (i, p) in points.iter().enumerate() {
        if !p.x.is_finite() || !p.y.is_finite() {
            return Err(format!("build_panels: polygon[{i}] must be finite"));
        }
    }
    let clean: Vec<Xy> = points.iter().map(|p| Xy { x: p.x, y: p.y }).collect();
    let clean = dedup_closed(&clean);
    if clean.len() < 3 {
        return Err("build_panels: polygon collapsed to fewer than 3 distinct points".to_string());
    }
    let mut ordered = clean;
    if polygon_signed_area(&ordered) < 0.0 {
        ordered.reverse();
    }
    let sampled: Vec<Xy> = if ordered.len() > MAX_PANELS {
        let stride = ordered.len().div_ceil(MAX_PANELS);
        ordered.into_iter().step_by(stride).collect()
    } else {
        ordered
    };
    let mut panels = Vec::with_capacity(sampled.len());
    for i in 0..sampled.len() {
        let a = sampled[i];
        let b = sampled[(i + 1) % sampled.len()];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len = dx.hypot(dy);
        if !(len > 1e-12) {
            return Err(format!("build_panels: panel {i} is degenerate (zero length)"));
        }
        let tx = dx / len;
        let ty = dy / len;
        panels.push(Panel {
            x1: a.x,
            y1: a.y,
            x2: b.x,
            y2: b.y,
            xc: (a.x + b.x) / 2.0,
            yc: (a.y + b.y) / 2.0,
            tx,
            ty,
            nx: ty,
            ny: -tx,
            len,
        });
    }
    Ok(panels)
}

struct UnitInfluence {
    cn_s: f64,
    ct_s: f64,
    cn_v: f64,
    ct_v: f64,
}

/// Unit strength influence of panel pj at the collocation point of pi.
fn influence(pi: &Panel, pj: &Panel) -> UnitInfluence {
    let dx = pi.xc - pj.x1;
    let dy = pi.yc - pj.y1;
    let x = dx * pj.tx + dy * pj.ty;
    let z = dx * pj.nx + dy * pj.ny;
    let l = pj.len;
    let g2 = SINGULARITY_GUARD * SINGULARITY_GUARD;
    let r1 = (x * x + z * z).max(g2);
    let xl = x - l;
    let r2 = (xl * xl + z * z).max(g2);
    let us = (r1.ln() - r2.ln()) / (4.0 * std::f64::consts::PI);
    let a1 = z.atan2(x);
    let a2 = z.atan2(xl);
    let ws = (a2 - a1) / (2.0 * std::f64::consts::PI);
    let tjn = pj.tx * pi.nx + pj.ty * pi.ny;
    let njn = pj.nx * pi.nx + pj.ny * pi.ny;
    let tjt = pj.tx * pi.tx + pj.ty * pi.ty;
    let njt = pj.nx * pi.tx + pj.ny * pi.ty;
    UnitInfluence {
        cn_s: us * tjn + ws * njn,
        ct_s: us * tjt + ws * njt,
        cn_v: -ws * tjn + us * njn,
        ct_v: -ws * tjt + us * njt,
    }
}

struct UnitField {
    us: f64,
    ws: f64,
}

/// Unit strength field of panel p at an arbitrary point (global frame).
fn unit_field(px: f64, py: f64, p: &Panel) -> UnitField {
    let dx = px - p.x1;
    let dy = py - p.y1;
    let x = dx * p.tx + dy * p.ty;
    let z = dx * p.nx + dy * p.ny;
    let l = p.len;
    let g2 = SINGULARITY_GUARD * SINGULARITY_GUARD;
    let r1 = (x * x + z * z).max(g2);
    let xl = x - l;
    let r2 = (xl * xl + z * z).max(g2);
    let us = (r1.ln() - r2.ln()) / (4.0 * std::f64::consts::PI);
    let a1 = z.atan2(x);
    let a2 = z.atan2(xl);
    let ws = (a2 - a1) / (2.0 * std::f64::consts::PI);
    UnitField { us, ws }
}

/// Solve the multi-body panel system for freestream (U, 0). Each entry of
/// bodies holds that body's panels; kutta_per_body selects which bodies carry
/// a vortex unknown plus a Kutta equation on that body's own TE pair.
pub fn solve_bodies(
    bodies: &[Vec<Panel>],
    u: f64,
    chord_ref: f64,
    kutta_per_body: &[bool],
) -> Result<PanelSolution, String> {
    if bodies.is_empty() {
        return Err("solve_bodies: need at least one body".to_string());
    }
    for (b, body) in bodies.iter().enumerate() {
        if body.len() < 3 {
            return Err(format!("solve_bodies: body {b} needs at least 3 panels"));
        }
        if body.len() > MAX_PANELS {
            return Err(format!(
                "solve_bodies: body {b} has {} panels, exceeds per-body cap {MAX_PANELS}",
                body.len()
            ));
        }
    }
    if !u.is_finite() || u <= 0.0 {
        return Err(format!("solve_bodies: U must be positive, got {u}"));
    }
    if !chord_ref.is_finite() || chord_ref <= 0.0 {
        return Err(format!("solve_bodies: chord_ref must be positive, got {chord_ref}"));
    }
    if kutta_per_body.len() != bodies.len() {
        return Err(format!(
            "solve_bodies: kutta_per_body length {} does not match bodies {}",
            kutta_per_body.len(),
            bodies.len()
        ));
    }
    let mut panels: Vec<Panel> = Vec::new();
    let mut panel_body: Vec<usize> = Vec::new();
    let mut body_start: Vec<usize> = Vec::new();
    for (b, body) in bodies.iter().enumerate() {
        body_start.push(panels.len());
        for p in body {
            panels.push(*p);
            panel_body.push(b);
        }
    }
    let n = panels.len();
    let kutta_bodies: Vec<usize> = (0..bodies.len()).filter(|&b| kutta_per_body[b]).collect();
    let k = kutta_bodies.len();
    let nn = n + k;
    if nn > MAX_TOTAL_PANELS {
        return Err(format!(
            "solve_bodies: total unknowns {nn} (panels {n} plus {k} Kutta rows) exceed cap {MAX_TOTAL_PANELS}"
        ));
    }
    let mut aug = vec![vec![0.0; nn + 1]; nn];
    let mut gamma_col_of_body: Vec<Option<usize>> = vec![None; bodies.len()];
    for (kk, &b) in kutta_bodies.iter().enumerate() {
        gamma_col_of_body[b] = Some(n + kk);
    }
    for i in 0..n {
        let c = panels[i];
        for j in 0..n {
            let cn_s = if i == j {
                0.5
            } else {
                influence(&c, &panels[j]).cn_s
            };
            aug[i][j] = cn_s;
        }
        for kk in 0..k {
            let b = kutta_bodies[kk];
            let mut sum_cn_v = 0.0;
            let start = body_start[b];
            let end = start + bodies[b].len();
            for j in start..end {
                if i == j {
                    continue;
                }
                sum_cn_v += influence(&c, &panels[j]).cn_v;
            }
            aug[i][n + kk] = sum_cn_v;
        }
        aug[i][nn] = -(u * c.nx);
    }
    for kk in 0..k {
        let b = kutta_bodies[kk];
        let row = n + kk;
        let te0 = body_start[b];
        let te1 = body_start[b] + bodies[b].len() - 1;
        let p0 = panels[te0];
        let p1 = panels[te1];
        for j in 0..n {
            let ct_s0 = if j == te0 {
                0.0
            } else {
                influence(&p0, &panels[j]).ct_s
            };
            let ct_s1 = if j == te1 {
                0.0
            } else {
                influence(&p1, &panels[j]).ct_s
            };
            aug[row][j] = ct_s0 + ct_s1;
        }
        for m in 0..k {
            let bm = kutta_bodies[m];
            let mut sum_ct_v = 0.0;
            let start = body_start[bm];
            let end = start + bodies[bm].len();
            for j in start..end {
                let ct_v0 = if j == te0 {
                    -0.5
                } else {
                    influence(&p0, &panels[j]).ct_v
                };
                let ct_v1 = if j == te1 {
                    -0.5
                } else {
                    influence(&p1, &panels[j]).ct_v
                };
                sum_ct_v += ct_v0 + ct_v1;
            }
            aug[row][n + m] = sum_ct_v;
        }
        aug[row][nn] = -(u * p0.tx + u * p1.tx);
    }
    // Forward elimination with partial pivoting (same op order as TS).
    for col in 0..nn {
        let mut piv = col;
        let mut best = aug[col][col].abs();
        for r in (col + 1)..nn {
            let v = aug[r][col].abs();
            if v > best {
                best = v;
                piv = r;
            }
        }
        if !(best > 0.0) || !best.is_finite() {
            return Err("solve_bodies: singular panel system".to_string());
        }
        if piv != col {
            aug.swap(col, piv);
        }
        let diag = aug[col][col];
        for r in (col + 1)..nn {
            let f = aug[r][col] / diag;
            if f != 0.0 {
                for c in col..=nn {
                    aug[r][c] -= f * aug[col][c];
                }
            }
        }
    }
    let mut x = vec![0.0; nn];
    for r in (0..nn).rev() {
        let mut s = aug[r][nn];
        for c in (r + 1)..nn {
            s -= aug[r][c] * x[c];
        }
        x[r] = s / aug[r][r];
        if !x[r].is_finite() {
            return Err("solve_bodies: singular panel system".to_string());
        }
    }
    let sigma = x[..n].to_vec();
    let mut gammas = vec![0.0; bodies.len()];
    for (kk, &b) in kutta_bodies.iter().enumerate() {
        gammas[b] = x[n + kk];
    }
    let gamma = if k > 0 { gammas[kutta_bodies[0]] } else { 0.0 };
    let mut cp = vec![0.0; n];
    let mut lift = 0.0;
    for i in 0..n {
        let c = panels[i];
        let mut vt = u * c.tx;
        for j in 0..n {
            let (ct_s, ct_v) = if i == j {
                (0.0, -0.5)
            } else {
                let inf = influence(&c, &panels[j]);
                (inf.ct_s, inf.ct_v)
            };
            let gj = gammas[panel_body[j]];
            vt += sigma[j] * ct_s + gj * ct_v;
        }
        let vtr = vt / u;
        cp[i] = 1.0 - vtr * vtr;
        lift += -cp[i] * c.ny * c.len;
    }
    for (i, &c) in cp.iter().enumerate() {
        if !c.is_finite() {
            return Err(format!("solve_bodies: non-finite cp[{i}] (singular panel evaluation)"));
        }
    }
    let cl = lift / chord_ref;
    if !cl.is_finite() {
        return Err("solve_bodies: non-finite cl (singular panel evaluation)".to_string());
    }
    Ok(PanelSolution {
        panels,
        sigma,
        gamma,
        gammas,
        panel_body,
        cp,
        cl,
    })
}

/// Solve a single body panel system for freestream (U, 0). Kutta defaults to
/// true; pass false for non-lifting bodies to get pure source flow.
pub fn solve_panels(
    panels: &[Panel],
    u: f64,
    chord_ref: f64,
    kutta: bool,
) -> Result<PanelSolution, String> {
    if panels.len() < 3 {
        return Err(format!("solve_panels: need at least 3 panels, got {}", panels.len()));
    }
    if panels.len() > MAX_PANELS {
        return Err(format!(
            "solve_panels: {} panels exceed cap {MAX_PANELS}",
            panels.len()
        ));
    }
    solve_bodies(&[panels.to_vec()], u, chord_ref, &[kutta])
}

/// Velocity at (x, y) from a solved panel system plus freestream (U, 0).
pub fn panel_velocity(x: f64, y: f64, sol: &PanelSolution, u: f64) -> Result<(f64, f64), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err(format!("panel_velocity: point must be finite, got ({x}, {y})"));
    }
    if !u.is_finite() || u <= 0.0 {
        return Err(format!("panel_velocity: U must be positive, got {u}"));
    }
    let mut vel_u = u;
    let mut vel_v = 0.0;
    for (j, p) in sol.panels.iter().enumerate() {
        let gj = sol.gammas[sol.panel_body[j]];
        let f = unit_field(x, y, p);
        let lu = sol.sigma[j] * f.us - gj * f.ws;
        let lw = sol.sigma[j] * f.ws + gj * f.us;
        vel_u += lu * p.tx + lw * p.nx;
        vel_v += lu * p.ty + lw * p.ny;
    }
    Ok((vel_u, vel_v))
}

/// Exact potential flow around a cylinder (uniform stream plus doublet, with
/// optional circulation gamma, CCW positive). Zero velocity inside the solid.
pub fn cylinder_velocity(
    x: f64,
    y: f64,
    cx: f64,
    cy: f64,
    radius: f64,
    u: f64,
    gamma: f64,
) -> Result<(f64, f64), String> {
    if !x.is_finite() || !y.is_finite() {
        return Err(format!("cylinder_velocity: point must be finite, got ({x}, {y})"));
    }
    if !cx.is_finite() || !cy.is_finite() {
        return Err(format!("cylinder_velocity: center must be finite, got ({cx}, {cy})"));
    }
    if !radius.is_finite() || radius <= 0.0 {
        return Err(format!("cylinder_velocity: radius must be positive, got {radius}"));
    }
    if !u.is_finite() || u <= 0.0 {
        return Err(format!("cylinder_velocity: U must be positive, got {u}"));
    }
    if !gamma.is_finite() {
        return Err(format!("cylinder_velocity: gamma must be finite, got {gamma}"));
    }
    let dx = x - cx;
    let dy = y - cy;
    let r2 = dx * dx + dy * dy;
    let r_sq = radius * radius;
    if r2 <= r_sq {
        return Ok((0.0, 0.0));
    }
    let r4 = r2 * r2;
    let doublet = (u * r_sq) / r4;
    let mut vel_u = u - doublet * (dx * dx - dy * dy);
    let mut vel_v = -doublet * 2.0 * dx * dy;
    if gamma != 0.0 {
        let circ = gamma / (2.0 * std::f64::consts::PI * r2);
        vel_u += -circ * dy;
        vel_v += circ * dx;
    }
    Ok((vel_u, vel_v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{cylinder_polygon, naca4_airfoil, transform_points};

    fn airfoil_panels() -> Vec<Panel> {
        let raw = naca4_airfoil(0.02, 0.4, 0.12, 60).unwrap();
        let world = transform_points(&raw, 0.0, 0.0, 1.0, 6.0).unwrap();
        build_panels(&world).unwrap()
    }

    #[test]
    fn kutta_solve_produces_positive_lift() {
        let panels = airfoil_panels();
        let sol = solve_panels(&panels, 1.0, 1.0, true).unwrap();
        assert!(sol.cl > 0.3 && sol.cl < 2.0, "cl = {}", sol.cl);
        assert!(sol.gamma != 0.0);
        let cp_min = sol.cp.iter().cloned().fold(f64::INFINITY, f64::min);
        assert!(cp_min < 0.0);
    }

    #[test]
    fn non_lifting_solve_has_zero_gamma() {
        let poly = cylinder_polygon(0.5, 0.0, 0.25, 32).unwrap();
        let panels = build_panels(&poly).unwrap();
        let sol = solve_panels(&panels, 1.0, 1.0, false).unwrap();
        assert_eq!(sol.gamma, 0.0);
        assert!(sol.cl.abs() < 1e-9, "cl = {}", sol.cl);
    }

    #[test]
    fn cylinder_exact_matches_freestream_far_away() {
        let (u, v) = cylinder_velocity(10.0, 0.0, 0.5, 0.0, 0.25, 1.0, 0.0).unwrap();
        assert!((u - 1.0).abs() < 0.01);
        assert!(v.abs() < 0.01);
        assert_eq!(cylinder_velocity(0.5, 0.0, 0.5, 0.0, 0.25, 1.0, 0.0).unwrap(), (0.0, 0.0));
    }

    #[test]
    fn degenerate_polygon_rejected() {
        let pts = vec![Xy { x: 0.0, y: 0.0 }; 4];
        assert!(build_panels(&pts).is_err());
    }
}
