// Parametric geometry ported from src/geometry/parametric.ts.
// Same cosine spacing, same closed trailing edge coeff (-0.1036), same
// aerodynamic alpha sign (positive alpha is nose up, math angle negated).
// Pure math, no wasm-bindgen, host testable.

use crate::types::{
    GeometrySpec, Xy, ALPHA_HARD_MAX, ALPHA_HARD_MIN, ORIFICE_GAP_DEFAULT, ORIFICE_GAP_MAX,
    ORIFICE_GAP_MIN, ORIFICE_THICKNESS_DEFAULT, ORIFICE_THICKNESS_MAX, ORIFICE_THICKNESS_MIN,
    ORIFICE_WALL_HALF,
};

/// Max camber fraction accepted by naca4_airfoil.
pub const NACA_M_MAX: f64 = 0.095;
/// Max thickness fraction accepted by naca4_airfoil.
pub const NACA_T_MAX: f64 = 0.4;
/// Hard cap on points per polygon so the dense panel solve stays interactive.
pub const MAX_POLYGON_POINTS: usize = 160;

fn finite(name: &str, v: f64) -> Result<f64, String> {
    if v.is_finite() {
        Ok(v)
    } else {
        Err(format!("{name} must be a finite number"))
    }
}

/// NACA 4-digit airfoil polygon, y-up, closed trailing edge (-0.1036).
/// Returns a closed loop: upper surface TE to LE, then lower surface LE to TE.
pub fn naca4_airfoil(m: f64, p: f64, t: f64, n_points: usize) -> Result<Vec<Xy>, String> {
    if n_points < 2 {
        return Err(format!("naca4_airfoil: n_points must be >= 2, got {n_points}"));
    }
    if !(m >= 0.0 && m <= NACA_M_MAX) {
        return Err(format!("naca4_airfoil: m must be in [0, {NACA_M_MAX}], got {m}"));
    }
    if m > 1e-10 && !(p > 0.0 && p < 1.0) {
        return Err(format!("naca4_airfoil: p must be in (0, 1) when m > 0, got {p}"));
    }
    if !(t > 0.0 && t <= NACA_T_MAX) {
        return Err(format!("naca4_airfoil: t must be in (0, {NACA_T_MAX}], got {t}"));
    }
    let n = n_points;
    let mut xs = Vec::with_capacity(n);
    for i in 0..n {
        let beta = (i as f64 / (n - 1) as f64) * std::f64::consts::PI;
        xs.push((1.0 - beta.cos()) / 2.0);
    }
    let yt: Vec<f64> = xs
        .iter()
        .map(|&xi| {
            5.0 * t
                * (0.2969 * xi.sqrt() - 0.126 * xi - 0.3516 * xi * xi
                    + 0.2843 * xi * xi * xi
                    - 0.1036 * xi * xi * xi * xi)
        })
        .collect();
    let mut yc = vec![0.0; n];
    let mut dyc = vec![0.0; n];
    if m > 1e-10 && p > 1e-10 {
        for i in 0..n {
            if xs[i] < p {
                yc[i] = (m / (p * p)) * (2.0 * p * xs[i] - xs[i] * xs[i]);
                dyc[i] = ((2.0 * m) / (p * p)) * (p - xs[i]);
            } else {
                yc[i] = (m / ((1.0 - p) * (1.0 - p)))
                    * (1.0 - 2.0 * p + 2.0 * p * xs[i] - xs[i] * xs[i]);
                dyc[i] = ((2.0 * m) / ((1.0 - p) * (1.0 - p))) * (p - xs[i]);
            }
        }
    }
    let mut upper = Vec::with_capacity(n);
    let mut lower = Vec::with_capacity(n);
    for i in 0..n {
        let theta = dyc[i].atan();
        upper.push(Xy {
            x: xs[i] - yt[i] * theta.sin(),
            y: yc[i] + yt[i] * theta.cos(),
        });
        lower.push(Xy {
            x: xs[i] + yt[i] * theta.sin(),
            y: yc[i] - yt[i] * theta.cos(),
        });
    }
    let mut result = Vec::with_capacity(2 * n - 1);
    for i in (0..n).rev() {
        result.push(upper[i]);
    }
    for i in 1..n {
        result.push(lower[i]);
    }
    Ok(result)
}

/// Rotate, scale, translate. angle_deg is aerodynamic alpha: positive means
/// nose up, clockwise in y-up coords, so the math angle is negated.
pub fn transform_points(
    points: &[Xy],
    cx: f64,
    cy: f64,
    scale: f64,
    angle_deg: f64,
) -> Result<Vec<Xy>, String> {
    if points.is_empty() {
        return Err("transform_points: polygon must be non-empty".to_string());
    }
    finite("transform_points: cx", cx)?;
    finite("transform_points: cy", cy)?;
    if !scale.is_finite() || scale <= 0.0 {
        return Err(format!("transform_points: scale must be positive, got {scale}"));
    }
    finite("transform_points: angle_deg", angle_deg)?;
    let a = (-angle_deg * std::f64::consts::PI) / 180.0;
    let cos_a = a.cos();
    let sin_a = a.sin();
    let mut out = Vec::with_capacity(points.len());
    for pt in points {
        if !pt.x.is_finite() || !pt.y.is_finite() {
            return Err(format!(
                "transform_points: polygon points must be finite, got ({}, {})",
                pt.x, pt.y
            ));
        }
        let xs = pt.x * scale;
        let ys = pt.y * scale;
        out.push(Xy {
            x: xs * cos_a - ys * sin_a + cx,
            y: xs * sin_a + ys * cos_a + cy,
        });
    }
    Ok(out)
}

/// Ray cast point in polygon. Matches the TS loop exactly.
pub fn point_in_polygon(px: f64, py: f64, poly: &[Xy]) -> bool {
    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let xi = poly[i].x;
        let yi = poly[i].y;
        let xj = poly[j].x;
        let yj = poly[j].y;
        if (yi > py) != (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Signed area of a closed polygon (positive for CCW).
pub fn polygon_signed_area(pts: &[Xy]) -> f64 {
    let mut a = 0.0;
    for i in 0..pts.len() {
        let p = pts[i];
        let q = pts[(i + 1) % pts.len()];
        a += p.x * q.y - q.x * p.y;
    }
    a / 2.0
}

/// Drop consecutive duplicates (tolerance 1e-12) and a duplicate closing point.
pub fn dedup_closed(pts: &[Xy]) -> Vec<Xy> {
    let mut out: Vec<Xy> = Vec::with_capacity(pts.len());
    for p in pts {
        let keep = match out.last() {
            None => true,
            Some(q) => (p.x - q.x).hypot(p.y - q.y) > 1e-12,
        };
        if keep {
            out.push(*p);
        }
    }
    if out.len() > 1 {
        let f = out[0];
        let l = out[out.len() - 1];
        if (f.x - l.x).hypot(f.y - l.y) <= 1e-12 {
            out.pop();
        }
    }
    out
}

/// Stride sample long polygons down to MAX_POLYGON_POINTS points.
fn stride_cap(pts: Vec<Xy>) -> Vec<Xy> {
    if pts.len() <= MAX_POLYGON_POINTS {
        return pts;
    }
    let stride = pts.len().div_ceil(MAX_POLYGON_POINTS);
    pts.into_iter().step_by(stride).collect()
}

fn ensure_ccw(pts: Vec<Xy>) -> Vec<Xy> {
    if polygon_signed_area(&pts) < 0.0 {
        let mut rev = pts;
        rev.reverse();
        rev
    } else {
        pts
    }
}

/// Cylinder polygon, counter-clockwise, y-up. Angle 0 sits at (cx + r, cy).
pub fn cylinder_polygon(cx: f64, cy: f64, radius: f64, n_points: usize) -> Result<Vec<Xy>, String> {
    finite("cylinder_polygon: cx", cx)?;
    finite("cylinder_polygon: cy", cy)?;
    if !radius.is_finite() || radius <= 0.0 {
        return Err(format!(
            "cylinder_polygon: radius must be positive, got {radius}"
        ));
    }
    if n_points < 4 {
        return Err(format!(
            "cylinder_polygon: n_points must be >= 4, got {n_points}"
        ));
    }
    let mut pts = Vec::with_capacity(n_points);
    for i in 0..n_points {
        let a = (i as f64 / n_points as f64) * 2.0 * std::f64::consts::PI;
        pts.push(Xy {
            x: cx + radius * a.cos(),
            y: cy + radius * a.sin(),
        });
    }
    Ok(pts)
}

/// Even arclength sampler around an axis aligned rectangle, CCW from (x0, y0).
fn sample_rectangle(x0: f64, y0: f64, x1: f64, y1: f64, n_points: usize) -> Vec<Xy> {
    let corners = [
        Xy { x: x0, y: y0 },
        Xy { x: x1, y: y0 },
        Xy { x: x1, y: y1 },
        Xy { x: x0, y: y1 },
    ];
    let mut edge_len = [0.0; 4];
    let mut perimeter = 0.0;
    for e in 0..4 {
        let a = corners[e];
        let b = corners[(e + 1) % 4];
        let len = (b.x - a.x).hypot(b.y - a.y);
        edge_len[e] = len;
        perimeter += len;
    }
    let mut pts = Vec::with_capacity(n_points);
    for i in 0..n_points {
        let mut s = (i as f64 / n_points as f64) * perimeter;
        let mut e = 0;
        while e < 3 && s > edge_len[e] {
            s -= edge_len[e];
            e += 1;
        }
        let a = corners[e];
        let b = corners[(e + 1) % 4];
        let t = if edge_len[e] > 0.0 { s / edge_len[e] } else { 0.0 };
        pts.push(Xy {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
        });
    }
    pts
}

/// Block polygon, counter-clockwise, centered at (cx, cy).
pub fn block_polygon(
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    n_points: usize,
) -> Result<Vec<Xy>, String> {
    finite("block_polygon: cx", cx)?;
    finite("block_polygon: cy", cy)?;
    if !width.is_finite() || width <= 0.0 {
        return Err(format!("block_polygon: width must be positive, got {width}"));
    }
    if !height.is_finite() || height <= 0.0 {
        return Err(format!("block_polygon: height must be positive, got {height}"));
    }
    if n_points < 4 {
        return Err(format!("block_polygon: n_points must be >= 4, got {n_points}"));
    }
    Ok(sample_rectangle(
        cx - width / 2.0,
        cy - height / 2.0,
        cx + width / 2.0,
        cy + height / 2.0,
        n_points,
    ))
}

/// Orifice plate polygons: two solid segments above and below a central gap
/// of full height `gap`, plate thickness `thickness` in x. Mirrors
/// orificePolygons in src/geometry/parametric.ts. Returns [upper, lower].
/// Alpha rotation is ignored so the plate stays normal to the channel axis.
pub fn orifice_polygons(
    cx: f64,
    cy: f64,
    thickness: f64,
    gap: f64,
    n_points: usize,
    wall_half: f64,
) -> Result<Vec<Vec<Xy>>, String> {
    finite("orifice_polygons: cx", cx)?;
    finite("orifice_polygons: cy", cy)?;
    if !thickness.is_finite() || thickness < ORIFICE_THICKNESS_MIN || thickness > ORIFICE_THICKNESS_MAX {
        return Err(format!(
            "orifice_polygons: thickness must be in [{ORIFICE_THICKNESS_MIN}, {ORIFICE_THICKNESS_MAX}], got {thickness}"
        ));
    }
    if !gap.is_finite() || gap < ORIFICE_GAP_MIN || gap > ORIFICE_GAP_MAX {
        return Err(format!(
            "orifice_polygons: gap must be in [{ORIFICE_GAP_MIN}, {ORIFICE_GAP_MAX}], got {gap}"
        ));
    }
    if n_points < 4 {
        return Err(format!(
            "orifice_polygons: n_points must be >= 4, got {n_points}"
        ));
    }
    if !wall_half.is_finite() || wall_half <= gap / 2.0 {
        return Err(format!(
            "orifice_polygons: wall_half must exceed gap / 2, got {wall_half}"
        ));
    }
    let per = std::cmp::max(4, n_points.div_ceil(2));
    let upper = sample_rectangle(
        cx - thickness / 2.0,
        cy + gap / 2.0,
        cx + thickness / 2.0,
        cy + wall_half,
        per,
    );
    let lower = sample_rectangle(
        cx - thickness / 2.0,
        cy - wall_half,
        cx + thickness / 2.0,
        cy - gap / 2.0,
        per,
    );
    Ok(vec![upper, lower])
}

/// Duct wall polygons: two solid plates above and below a channel of full
/// height `height`. Returns [upper, lower]. Alpha rotation is ignored.
/// Legacy channel body kept for Poiseuille validation fixtures; new UI
/// specs use the orifice plate body above.
pub fn duct_polygons(
    cx: f64,
    cy: f64,
    width: f64,
    height: f64,
    n_points: usize,
    wall_half: f64,
) -> Result<Vec<Vec<Xy>>, String> {
    finite("duct_polygons: cx", cx)?;
    finite("duct_polygons: cy", cy)?;
    if !width.is_finite() || width <= 0.0 {
        return Err(format!("duct_polygons: width must be positive, got {width}"));
    }
    if !height.is_finite() || height <= 0.0 {
        return Err(format!("duct_polygons: height must be positive, got {height}"));
    }
    if n_points < 4 {
        return Err(format!("duct_polygons: n_points must be >= 4, got {n_points}"));
    }
    if !wall_half.is_finite() || wall_half <= height / 2.0 {
        return Err(format!(
            "duct_polygons: wall_half must exceed height / 2, got {wall_half}"
        ));
    }
    let per = std::cmp::max(4, n_points.div_ceil(2));
    let upper = sample_rectangle(
        cx - width / 2.0,
        cy + height / 2.0,
        cx + width / 2.0,
        cy + wall_half,
        per,
    );
    let lower = sample_rectangle(
        cx - width / 2.0,
        cy - wall_half,
        cx + width / 2.0,
        cy - height / 2.0,
        per,
    );
    Ok(vec![upper, lower])
}

/// Legacy duct intake migration. The retired "duct" kind measured the
/// channel length in width, so migration resets the plate thickness to the
/// default and clamps the channel height into the orifice gap envelope,
/// mirroring migrateDuctToOrifice in src/geometry/parametric.ts. Returns
/// None for non-duct specs. Public intakes (WasmLbmSolver::configure, the
/// worker JSON path) migrate through here; the duct_polygons helper below
/// stays for the Poiseuille channel validation fixture only.
pub fn migrate_legacy_duct(spec: &GeometrySpec) -> Option<GeometrySpec> {
    if spec.kind != "duct" {
        return None;
    }
    let raw_gap = spec.height.unwrap_or(ORIFICE_GAP_DEFAULT);
    let gap = if raw_gap.is_finite() {
        raw_gap.clamp(ORIFICE_GAP_MIN, ORIFICE_GAP_MAX)
    } else {
        ORIFICE_GAP_DEFAULT
    };
    Some(GeometrySpec {
        kind: "orifice".to_string(),
        width: Some(ORIFICE_THICKNESS_DEFAULT),
        height: Some(gap),
        ..spec.clone()
    })
}

/// Build world space polygons for a GeometrySpec. Chord 1 with LE at (0, 0),
/// y-up. Returns one polygon per body, deduplicated, stride capped, CCW.
/// Accepts the hard alpha envelope [-180, 180]; orifice, duct, cylinder,
/// and block ignore rotation for axis alignment while airfoils rotate.
pub fn build_polygons(spec: &GeometrySpec) -> Result<Vec<Vec<Xy>>, String> {
    let kinds = ["naca4", "cylinder", "block", "orifice", "duct", "custom"];
    if !kinds.contains(&spec.kind.as_str()) {
        return Err(format!(
            "build_polygons: kind must be one of {}, got {}",
            kinds.join(", "),
            spec.kind
        ));
    }
    finite("build_polygons: chord", spec.chord)?;
    if spec.chord <= 0.0 {
        return Err(format!("build_polygons: chord must be positive, got {}", spec.chord));
    }
    finite("build_polygons: alpha_deg", spec.alpha_deg)?;
    if spec.alpha_deg < ALPHA_HARD_MIN || spec.alpha_deg > ALPHA_HARD_MAX {
        return Err(format!(
            "build_polygons: alpha_deg must be in [{ALPHA_HARD_MIN}, {ALPHA_HARD_MAX}], got {}",
            spec.alpha_deg
        ));
    }
    if spec.n_points < 4 {
        return Err(format!(
            "build_polygons: n_points must be >= 4, got {}",
            spec.n_points
        ));
    }
    if spec.n_points > MAX_POLYGON_POINTS {
        return Err(format!(
            "build_polygons: n_points {} exceeds cap {MAX_POLYGON_POINTS}",
            spec.n_points
        ));
    }
    let center = spec.center.unwrap_or(Xy { x: 0.5, y: 0.0 });
    finite("build_polygons: center.x", center.x)?;
    finite("build_polygons: center.y", center.y)?;
    let polys: Vec<Vec<Xy>> = if spec.kind == "naca4" {
        let naca = spec
            .naca
            .as_ref()
            .ok_or_else(|| "build_polygons: naca params are required for kind naca4".to_string())?;
        let raw = naca4_airfoil(naca.m, naca.p, naca.t, spec.n_points)?;
        vec![transform_points(&raw, 0.0, 0.0, spec.chord, spec.alpha_deg)?]
    } else if spec.kind == "cylinder" {
        let radius = spec.radius.unwrap_or(0.25);
        vec![cylinder_polygon(center.x, center.y, radius, spec.n_points)?]
    } else if spec.kind == "block" {
        let width = spec.width.unwrap_or(0.5);
        let height = spec.height.unwrap_or(0.5);
        let raw = block_polygon(0.0, 0.0, width, height, spec.n_points)?;
        vec![transform_points(&raw, center.x, center.y, 1.0, spec.alpha_deg)?]
    } else if spec.kind == "custom" {
        let poly = spec
            .polygon
            .as_ref()
            .ok_or_else(|| "build_polygons: polygon with at least 3 points is required for kind custom".to_string())?;
        if poly.len() > MAX_POLYGON_POINTS {
            return Err(format!(
                "build_polygons: custom polygon with {} points exceeds cap {MAX_POLYGON_POINTS}",
                poly.len()
            ));
        }
        if poly.len() < 3 {
            return Err("build_polygons: polygon with at least 3 points is required for kind custom".to_string());
        }
        for pt in poly {
            finite("build_polygons: polygon.x", pt.x)?;
            finite("build_polygons: polygon.y", pt.y)?;
        }
        let raw: Vec<Xy> = poly.iter().map(|pt| Xy { x: pt.x, y: pt.y }).collect();
        vec![transform_points(&raw, 0.0, 0.0, spec.chord, spec.alpha_deg)?]
    } else if spec.kind == "orifice" {
        let thickness = spec.width.unwrap_or(ORIFICE_THICKNESS_DEFAULT);
        let gap = spec.height.unwrap_or(ORIFICE_GAP_DEFAULT);
        orifice_polygons(center.x, center.y, thickness, gap, spec.n_points, ORIFICE_WALL_HALF)?
    } else {
        let width = spec.width.unwrap_or(1.0);
        let height = spec.height.unwrap_or(0.4);
        duct_polygons(center.x, center.y, width, height, spec.n_points, 1.5)?
    };
    Ok(polys
        .into_iter()
        .map(|poly| ensure_ccw(stride_cap(dedup_closed(&poly))))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn naca_symmetric_has_zero_camber_line() {
        let pts = naca4_airfoil(0.0, 0.0, 0.12, 20).unwrap();
        assert_eq!(pts.len(), 2 * 20 - 1);
        // Upper TE and lower TE meet at the closed trailing edge (x near 1).
        let first = pts[0];
        let last = pts[pts.len() - 1];
        assert!((first.x - 1.0).abs() < 0.01);
        assert!((last.x - 1.0).abs() < 0.01);
        // Symmetric: upper and lower at same x have mirrored y.
        assert!((first.y + last.y).abs() < 1e-12);
    }

    #[test]
    fn transform_nose_up_moves_te_down() {
        let raw = vec![Xy { x: 1.0, y: 0.0 }];
        let out = transform_points(&raw, 0.0, 0.0, 1.0, 6.0).unwrap();
        assert!((out[0].x - 0.9945).abs() < 1e-3);
        assert!(out[0].y < 0.0);
    }

    #[test]
    fn point_in_polygon_square() {
        let sq = vec![
            Xy { x: 0.0, y: 0.0 },
            Xy { x: 1.0, y: 0.0 },
            Xy { x: 1.0, y: 1.0 },
            Xy { x: 0.0, y: 1.0 },
        ];
        assert!(point_in_polygon(0.5, 0.5, &sq));
        assert!(!point_in_polygon(2.0, 0.5, &sq));
    }

    #[test]
    fn rejects_bad_inputs() {
        assert!(naca4_airfoil(0.5, 0.4, 0.12, 20).is_err());
        assert!(naca4_airfoil(0.02, 0.4, 0.12, 1).is_err());
        assert!(transform_points(&[], 0.0, 0.0, 1.0, 0.0).is_err());
        assert!(cylinder_polygon(0.0, 0.0, -1.0, 16).is_err());
    }

    #[test]
    fn rejects_oversize_n_points_before_allocation() {
        use crate::types::{GeometrySpec, NacaParams};
        let spec = GeometrySpec {
            kind: "naca4".to_string(),
            naca: Some(NacaParams { code: "2412".to_string(), m: 0.02, p: 0.4, t: 0.12 }),
            chord: 1.0,
            alpha_deg: 6.0,
            n_points: MAX_POLYGON_POINTS + 1,
            radius: None,
            center: None,
            width: None,
            height: None,
            polygon: None,
        };
        assert!(build_polygons(&spec).is_err());
    }

    #[test]
    fn rejects_oversize_custom_polygon_before_allocation() {
        use crate::types::GeometrySpec;
        let poly: Vec<crate::types::Xy> = (0..(MAX_POLYGON_POINTS + 1))
            .map(|i| crate::types::Xy { x: i as f64 / MAX_POLYGON_POINTS as f64, y: 0.0 })
            .collect();
        let spec = GeometrySpec {
            kind: "custom".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 16,
            radius: None,
            center: None,
            width: None,
            height: None,
            polygon: Some(poly),
        };
        assert!(build_polygons(&spec).is_err());
    }

    fn orifice_geom(thickness: f64, gap: f64) -> crate::types::GeometrySpec {
        crate::types::GeometrySpec {
            kind: "orifice".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(crate::types::Xy { x: 0.5, y: 0.0 }),
            width: Some(thickness),
            height: Some(gap),
            polygon: None,
        }
    }

    #[test]
    fn orifice_returns_two_segments_with_open_gap() {
        let walls = orifice_polygons(0.5, 0.0, 0.08, 0.4, 64, ORIFICE_WALL_HALF).unwrap();
        assert_eq!(walls.len(), 2);
        for w in &walls {
            assert!(w.len() >= 4);
        }
        let upper = &walls[0];
        let lower = &walls[1];
        let upper_min_y = upper.iter().map(|p| p.y).fold(f64::INFINITY, f64::min);
        let lower_max_y = lower.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max);
        assert!((upper_min_y - 0.2).abs() < 1e-12, "upper_min_y = {upper_min_y}");
        assert!((lower_max_y + 0.2).abs() < 1e-12, "lower_max_y = {lower_max_y}");
        for w in walls {
            for p in w {
                assert!((p.x - 0.5).abs() <= 0.04 + 1e-12, "p.x = {}", p.x);
            }
        }
        let polys = build_polygons(&orifice_geom(0.08, 0.4)).unwrap();
        assert_eq!(polys.len(), 2);
    }

    #[test]
    fn orifice_rejects_out_of_envelope_gap_and_thickness() {
        assert!(orifice_polygons(0.5, 0.0, 0.005, 0.4, 64, ORIFICE_WALL_HALF).is_err());
        assert!(orifice_polygons(0.5, 0.0, 0.08, 0.01, 64, ORIFICE_WALL_HALF).is_err());
        assert!(orifice_polygons(0.5, 0.0, 0.08, 2.5, 64, ORIFICE_WALL_HALF).is_err());
    }

    #[test]
    fn build_polygons_accepts_full_rotation_alpha() {
        let mut spec = orifice_geom(0.08, 0.4);
        spec.alpha_deg = 180.0;
        assert!(build_polygons(&spec).is_ok());
        spec.alpha_deg = -180.0;
        assert!(build_polygons(&spec).is_ok());
        spec.alpha_deg = 181.0;
        assert!(build_polygons(&spec).is_err());
    }

    #[test]
    fn legacy_duct_migrates_to_orifice_at_intake() {
        use crate::types::GeometrySpec;
        let duct = GeometrySpec {
            kind: "duct".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(crate::types::Xy { x: 0.5, y: 0.0 }),
            width: Some(1.0),
            height: Some(0.9),
            polygon: None,
        };
        let migrated = migrate_legacy_duct(&duct).expect("duct must migrate");
        assert_eq!(migrated.kind, "orifice");
        assert!((migrated.width.unwrap() - ORIFICE_THICKNESS_DEFAULT).abs() < 1e-12);
        assert!((migrated.height.unwrap() - 0.9).abs() < 1e-12);
        // Clamp an out of envelope channel height into the gap envelope.
        let tall = GeometrySpec { height: Some(9.0), ..duct.clone() };
        let clamped = migrate_legacy_duct(&tall).expect("duct must migrate");
        assert!((clamped.height.unwrap() - ORIFICE_GAP_MAX).abs() < 1e-12);
        // Migrated walls are the two orifice segments with an open gap.
        let polys = build_polygons(&migrated).unwrap();
        assert_eq!(polys.len(), 2);
        // Non-duct specs pass through untouched.
        assert!(migrate_legacy_duct(&orifice_geom(0.08, 0.4)).is_none());
    }
}
