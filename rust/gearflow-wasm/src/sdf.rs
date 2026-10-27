// Signed distance grids ported from src/flow/sdf.ts.
// Union of bodies is the pointwise minimum. Cylinders pass exact circle
// definitions so the mask does not inherit polygon faceting.
// Pure math, no wasm-bindgen, host testable.

use crate::geometry::point_in_polygon;
use crate::types::{CircleDef, Domain, Xy};

/// Allocation and work caps, mirroring the TS module.
pub const MAX_SDF_BODIES: usize = 8;
pub const MAX_SDF_TOTAL_POINTS: usize = 2048;

/// Exact signed distance to a circle: negative inside, zero on the surface.
pub fn circle_sdf(px: f64, py: f64, cx: f64, cy: f64, r: f64) -> Result<f64, String> {
    if !px.is_finite() || !py.is_finite() {
        return Err(format!("circle_sdf: point must be finite, got ({px}, {py})"));
    }
    if !cx.is_finite() || !cy.is_finite() {
        return Err(format!("circle_sdf: center must be finite, got ({cx}, {cy})"));
    }
    if !r.is_finite() || r <= 0.0 {
        return Err(format!("circle_sdf: r must be positive, got {r}"));
    }
    Ok((px - cx).hypot(py - cy) - r)
}

/// Signed distance to a polygon: edge distance, negative inside.
pub fn polygon_sdf(px: f64, py: f64, poly: &[Xy]) -> Result<f64, String> {
    if poly.len() < 3 {
        return Err("polygon_sdf: polygon must have at least 3 points".to_string());
    }
    if !px.is_finite() || !py.is_finite() {
        return Err(format!("polygon_sdf: query point ({px}, {py}) must be finite"));
    }
    for (i, pt) in poly.iter().enumerate() {
        if !pt.x.is_finite() || !pt.y.is_finite() {
            return Err(format!("polygon_sdf: polygon[{i}] must have finite x and y"));
        }
    }
    Ok(polygon_sdf_unsafe(px, py, poly))
}

/// Unchecked inner kernel: no per-cell validation. Callers validate once up
/// front. Keeps the hot loop free of repeated type checks.
fn polygon_sdf_unsafe(px: f64, py: f64, poly: &[Xy]) -> f64 {
    let mut min_d2 = f64::INFINITY;
    for i in 0..poly.len() {
        let a = poly[i];
        let b = poly[(i + 1) % poly.len()];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let len2 = dx * dx + dy * dy;
        let len2 = if len2 == 0.0 { 1e-12 } else { len2 };
        let mut s = ((px - a.x) * dx + (py - a.y) * dy) / len2;
        if s < 0.0 {
            s = 0.0;
        } else if s > 1.0 {
            s = 1.0;
        }
        let ex = a.x + s * dx - px;
        let ey = a.y + s * dy - py;
        let d2 = ex * ex + ey * ey;
        if d2 < min_d2 {
            min_d2 = d2;
        }
    }
    let dist = min_d2.sqrt();
    if point_in_polygon(px, py, poly) {
        -dist
    } else {
        dist
    }
}

/// Build sdf and obstacle masks over a grid. Distance is the union minimum
/// across polygons and exact circles. Obstacle is 1 where sdf <= 0.
/// Returns (sdf, obstacle) as f32 row-major grids, j = 0 is the bottom row.
pub fn build_sdf_grid(
    polygons: &[Vec<Xy>],
    nx: usize,
    ny: usize,
    domain: Domain,
    circles: &[CircleDef],
) -> Result<(Vec<f32>, Vec<f32>), String> {
    if polygons.is_empty() {
        return Err("build_sdf_grid: polygons must be a non-empty array".to_string());
    }
    for (i, poly) in polygons.iter().enumerate() {
        if poly.len() < 3 {
            return Err(format!("build_sdf_grid: polygons[{i}] must have at least 3 points"));
        }
        for (j, pt) in poly.iter().enumerate() {
            if !pt.x.is_finite() || !pt.y.is_finite() {
                return Err(format!(
                    "build_sdf_grid: polygons[{i}][{j}] must have finite x and y"
                ));
            }
        }
    }
    for (i, c) in circles.iter().enumerate() {
        if !c.x.is_finite() || !c.y.is_finite() {
            return Err(format!("build_sdf_grid: circles[{i}] must have finite x and y"));
        }
        if !c.r.is_finite() || c.r <= 0.0 {
            return Err(format!(
                "build_sdf_grid: circles[{i}].r must be positive"
            ));
        }
    }
    if nx < 4 || ny < 4 {
        return Err(format!("build_sdf_grid: nx and ny must be >= 4, got {nx}x{ny}"));
    }
    if nx > 512 || ny > 512 {
        return Err(format!("build_sdf_grid: nx and ny must be <= 512, got {nx}x{ny}"));
    }
    if nx.saturating_mul(ny) > 262144 {
        return Err("build_sdf_grid: nx*ny must be <= 262144".to_string());
    }
    if !(domain.x_max > domain.x_min) || !(domain.y_max > domain.y_min) {
        return Err("build_sdf_grid: domain bounds must be ordered".to_string());
    }
    if polygons.len() > MAX_SDF_BODIES {
        return Err(format!(
            "build_sdf_grid: {} bodies exceed cap {MAX_SDF_BODIES}",
            polygons.len()
        ));
    }
    let total_points: usize = polygons.iter().map(|p| p.len()).sum();
    if total_points > MAX_SDF_TOTAL_POINTS {
        return Err(format!(
            "build_sdf_grid: {total_points} total points exceed cap {MAX_SDF_TOTAL_POINTS}"
        ));
    }
    let mut sdf = vec![0.0f32; nx * ny];
    let mut obstacle = vec![0.0f32; nx * ny];
    for j in 0..ny {
        let y = domain.y_min + ((domain.y_max - domain.y_min) * j as f64) / (ny - 1) as f64;
        for i in 0..nx {
            let x = domain.x_min + ((domain.x_max - domain.x_min) * i as f64) / (nx - 1) as f64;
            let mut d = f64::INFINITY;
            for poly in polygons {
                let pd = polygon_sdf_unsafe(x, y, poly);
                if pd < d {
                    d = pd;
                }
            }
            for c in circles {
                let cd = (x - c.x).hypot(y - c.y) - c.r;
                if cd < d {
                    d = cd;
                }
            }
            let k = j * nx + i;
            sdf[k] = d as f32;
            obstacle[k] = if d <= 0.0 { 1.0 } else { 0.0 };
        }
    }
    Ok((sdf, obstacle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn circle_sdf_sign() {
        assert!((circle_sdf(0.0, 0.0, 0.0, 0.0, 1.0).unwrap() + 1.0).abs() < 1e-12);
        assert!(circle_sdf(1.0, 0.0, 0.0, 0.0, 1.0).unwrap().abs() < 1e-12);
        assert!(circle_sdf(2.0, 0.0, 0.0, 0.0, 1.0).unwrap() > 0.0);
        assert!(circle_sdf(0.0, 0.0, 0.0, 0.0, -1.0).is_err());
    }

    #[test]
    fn polygon_sdf_square() {
        let sq = vec![
            Xy { x: 0.0, y: 0.0 },
            Xy { x: 1.0, y: 0.0 },
            Xy { x: 1.0, y: 1.0 },
            Xy { x: 0.0, y: 1.0 },
        ];
        assert!(polygon_sdf(0.5, 0.5, &sq).unwrap() < 0.0);
        assert!(polygon_sdf(2.0, 0.5, &sq).unwrap() > 0.0);
        assert!((polygon_sdf(2.0, 0.5, &sq).unwrap() - 1.0).abs() < 1e-12);
    }

    #[test]
    fn grid_union_and_obstacle() {
        let sq = vec![
            Xy { x: 0.0, y: 0.0 },
            Xy { x: 1.0, y: 0.0 },
            Xy { x: 1.0, y: 1.0 },
            Xy { x: 0.0, y: 1.0 },
        ];
        let domain = Domain { x_min: -1.0, x_max: 2.0, y_min: -1.0, y_max: 2.0 };
        let (sdf, obs) = build_sdf_grid(&[sq], 8, 8, domain, &[]).unwrap();
        assert_eq!(sdf.len(), 64);
        // Center-ish cell inside the square is masked.
        let inside_count = obs.iter().filter(|&&o| o > 0.5).count();
        assert!(inside_count > 0 && inside_count < 64);
    }

    #[test]
    fn rejects_oversize_grid_before_allocation() {
        let sq = vec![
            Xy { x: 0.0, y: 0.0 },
            Xy { x: 1.0, y: 0.0 },
            Xy { x: 1.0, y: 1.0 },
            Xy { x: 0.0, y: 1.0 },
        ];
        let domain = Domain { x_min: -1.0, x_max: 2.0, y_min: -1.0, y_max: 2.0 };
        assert!(build_sdf_grid(&[sq.clone()], 513, 8, domain, &[]).is_err());
        assert!(build_sdf_grid(&[sq.clone()], 8, 513, domain, &[]).is_err());
        assert!(build_sdf_grid(&[sq], 1024, 1024, domain, &[]).is_err());
    }
}
