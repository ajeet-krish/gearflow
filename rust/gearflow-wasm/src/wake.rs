// Viscous wake overlay ported from src/flow/wake.ts. The only place where
// Reynolds number enters: potential panels are inviscid, the wake adds a
// downstream velocity deficit plus downwash. Mutates u and v in place.
// Pure math, no wasm-bindgen, host testable.

use crate::types::{Domain, ALPHA_MAX, ALPHA_MIN};

/// Wake centreline slope for an angle of attack. Mirrors
/// wakeSlopeForAlpha in src/flow/wake.ts: the effective alpha is clamped
/// to the characterized band so full rotation sweeps cannot blow up the
/// tan term.
pub fn wake_slope_for_alpha(alpha_deg: f64) -> f64 {
    if !alpha_deg.is_finite() {
        return 0.0;
    }
    let clamped = alpha_deg.clamp(ALPHA_MIN, ALPHA_MAX);
    -((clamped * std::f64::consts::PI) / 180.0).tan() * 0.5
}

/// Wake shape parameters. Mirrors WakeParams in wake.ts.
#[derive(Clone, Copy, Debug)]
pub struct WakeParams {
    pub u: f64,
    pub re: f64,
    pub base_y: f64,
    pub slope: f64,
    pub x_wake: f64,
}

/// Apply the wake deficit downstream of x_wake. Cells upstream of x_wake and
/// obstacle cells are never touched. Operates on f32 channels exactly like
/// the TS Float32Array version: values are promoted to f64, computed, and
/// rounded back to f32 on store.
pub fn apply_wake(
    u: &mut [f32],
    v: &mut [f32],
    nx: usize,
    ny: usize,
    domain: Domain,
    obstacle: &[f32],
    params: WakeParams,
) -> Result<(), String> {
    if u.len() != nx * ny || v.len() != nx * ny || obstacle.len() != nx * ny {
        return Err("apply_wake: channel length does not match nx * ny".to_string());
    }
    if nx < 4 || ny < 4 {
        return Err(format!("apply_wake: nx and ny must be >= 4, got {nx}x{ny}"));
    }
    if !(domain.x_min.is_finite()
        && domain.x_max.is_finite()
        && domain.y_min.is_finite()
        && domain.y_max.is_finite())
    {
        return Err("apply_wake: domain must have finite bounds".to_string());
    }
    let WakeParams { u: uu, re, base_y, slope, x_wake } = params;
    if !uu.is_finite() || uu <= 0.0 {
        return Err(format!("apply_wake: U must be positive, got {uu}"));
    }
    if !re.is_finite() || re <= 0.0 {
        return Err(format!("apply_wake: Re must be positive, got {re}"));
    }
    if !base_y.is_finite() || !slope.is_finite() {
        return Err(format!("apply_wake: base_y and slope must be finite, got ({base_y}, {slope})"));
    }
    if !x_wake.is_finite() {
        return Err(format!("apply_wake: x_wake must be finite, got {x_wake}"));
    }
    let amp = (0.6f64).min(8.0 / re.sqrt());
    let width_scale = 1.0 + 60.0 / re;
    for j in 0..ny {
        let y = domain.y_min + ((domain.y_max - domain.y_min) * j as f64) / (ny - 1) as f64;
        for i in 0..nx {
            let x = domain.x_min + ((domain.x_max - domain.x_min) * i as f64) / (nx - 1) as f64;
            if x <= x_wake {
                continue;
            }
            let k = j * nx + i;
            if obstacle[k] > 0.5 {
                continue;
            }
            let behind = x - x_wake;
            let center = base_y + slope * behind;
            let yw = y - center;
            let w = (0.12 + behind * 0.18) * width_scale;
            let ramp = (behind * 1.4).min(1.0);
            let g = (-(yw * yw) / (w * w)).exp() * ramp;
            let new_u = (0.05 * uu).max(u[k] as f64 - uu * amp * g);
            u[k] = new_u as f32;
            v[k] = (v[k] as f64 + uu * slope * g * 0.5) as f32;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank(n: usize) -> (Vec<f32>, Vec<f32>, Vec<f32>) {
        (vec![1.0; n], vec![0.0; n], vec![0.0; n])
    }

    #[test]
    fn upstream_and_obstacle_cells_untouched() {
        let nx = 8;
        let ny = 4;
        let domain = Domain { x_min: -0.5, x_max: 2.0, y_min: -1.0, y_max: 1.0 };
        let (mut u, mut v, mut obs) = blank(nx * ny);
        obs[1 * nx + 7] = 1.0;
        let params = WakeParams { u: 1.0, re: 1000.0, base_y: 0.0, slope: 0.0, x_wake: 0.8 };
        apply_wake(&mut u, &mut v, nx, ny, domain, &obs, params).unwrap();
        // Column i = 0 sits at x = -0.5, upstream of the wake: untouched.
        assert_eq!(u[0], 1.0);
        assert_eq!(v[0], 0.0);
        // Obstacle cell untouched.
        assert_eq!(u[1 * nx + 7], 1.0);
        // Downstream centerline cell loses speed.
        assert!(u[1 * nx + 6] < 1.0);
    }

    #[test]
    fn rejects_bad_input() {
        let domain = Domain { x_min: 0.0, x_max: 1.0, y_min: 0.0, y_max: 1.0 };
        let (mut u, mut v, obs) = blank(16);
        let bad = WakeParams { u: -1.0, re: 1000.0, base_y: 0.0, slope: 0.0, x_wake: 0.8 };
        assert!(apply_wake(&mut u, &mut v, 4, 4, domain, &obs, bad).is_err());
    }

    #[test]
    fn wake_slope_clamps_out_of_band_alpha() {
        let in_band = wake_slope_for_alpha(6.0);
        assert!(in_band < 0.0);
        assert!((wake_slope_for_alpha(-4.0) - wake_slope_for_alpha(-90.0)).abs() < 1e-12);
        assert!((wake_slope_for_alpha(12.0) - wake_slope_for_alpha(180.0)).abs() < 1e-12);
        assert_eq!(wake_slope_for_alpha(f64::NAN), 0.0);
    }
}
