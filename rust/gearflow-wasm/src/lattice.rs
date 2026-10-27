// D2Q9 lattice tables, equilibrium, macroscopics, parameters, Smagorinsky.
// BGK with halfway bounce back. All accumulation in f64, rounded to f32.
// Pure math, no wasm-bindgen, host testable.

/// Lattice speed of sound squared.
pub const CS2: f64 = 1.0 / 3.0;
/// Lattice speed of sound.
pub const CS: f64 = 0.5773502691896258;
/// Default Smagorinsky constant.
pub const CS_SMAG_DEFAULT: f64 = 0.17;
/// Default Strouhal used for the shedding period estimate.
pub const ST_DEFAULT: f64 = 0.165;
/// Floor below which tau is rejected.
pub const TAU_FLOOR: f64 = 0.505;
/// Warn band below which tau logs a warning.
pub const TAU_WARN: f64 = 0.55;
/// Valid lattice speed range.
pub const U_LAT_MIN: f64 = 0.02;
pub const U_LAT_MAX: f64 = 0.12;

/// Provenance for resolved viscous LBM runs.
pub const PROVENANCE_LBM: &str = "LBM viscous (D2Q9 BGK, halfway bounce back, momentum exchange forces): Cd and Cl computed, not validated above Re 500. Re above 500 uses Smagorinsky LES and is modelled. Potential preview is inviscid and instant.";
/// Short provenance with the Re filled in by provenance_short().
/// Canonical accessor for PROVENANCE_LBM_SHORT (blueprint section 9).
/// Assembled text is identical to section 9 with [Re] replaced by re.
pub const PROVENANCE_LBM_SHORT_PREFIX: &str =
    "LBM viscous (D2Q9 BGK, halfway bounce back, momentum exchange forces): Cd and Cl computed at Re ";
pub const PROVENANCE_LBM_SHORT_SUFFIX: &str = ". Potential preview is inviscid and instant.";

/// Short provenance string with the Reynolds number labelled.
/// Canonical accessor for PROVENANCE_LBM_SHORT (blueprint section 9).
pub fn provenance_short(re: f64) -> String {
    format!("{PROVENANCE_LBM_SHORT_PREFIX}{re}{PROVENANCE_LBM_SHORT_SUFFIX}")
}

/// Direction tables in the fixed crate order.
pub const CX: [i32; 9] = [0, 1, 0, -1, 0, 1, -1, -1, 1];
pub const CY: [i32; 9] = [0, 0, 1, 0, -1, 1, 1, -1, -1];
pub const W: [f64; 9] = [
    4.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 9.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
    1.0 / 36.0,
];
pub const OPP: [usize; 9] = [0, 3, 4, 1, 2, 7, 8, 5, 6];
/// Specular reflection across a horizontal wall (flip cy).
pub const REFLECT_Y: [usize; 9] = [0, 1, 4, 3, 2, 8, 7, 6, 5];
/// Specular reflection across a vertical wall (flip cx) per blueprint table.
pub const REFLECT_X: [usize; 9] = [0, 3, 2, 1, 4, 7, 8, 5, 6];

/// Bundle of the direction tables for callers that prefer one handle.
#[derive(Clone, Copy, Debug)]
pub struct LatticeSet {
    pub cx: [i32; 9],
    pub cy: [i32; 9],
    pub w: [f64; 9],
    pub opp: [usize; 9],
    pub reflect_x: [usize; 9],
    pub reflect_y: [usize; 9],
}

/// The single canonical D2Q9 set.
pub const D2Q9: LatticeSet = LatticeSet {
    cx: CX,
    cy: CY,
    w: W,
    opp: OPP,
    reflect_x: REFLECT_X,
    reflect_y: REFLECT_Y,
};

/// Streaming source for destination (i, j) along direction d.
/// Returns None outside the domain. No modulo anywhere.
/// Panics on a direction outside 0..9 so misuse fails loudly.
pub fn source_index(i: usize, j: usize, dir: usize, nx: usize, ny: usize) -> Option<usize> {
    assert!(dir < 9, "lattice: source_index direction must be 0..9");
    assert!(nx >= 1 && ny >= 1, "lattice: source_index grid dims must be positive");
    let xs = i as i32 - CX[dir];
    let ys = j as i32 - CY[dir];
    if xs < 0 || ys < 0 {
        return None;
    }
    let xs = xs as usize;
    let ys = ys as usize;
    if xs >= nx || ys >= ny {
        return None;
    }
    Some(ys * nx + xs)
}

/// Equilibrium population for one direction.
/// Panics on a direction outside 0..9 so misuse fails loudly.
pub fn equilibrium(rho: f64, ux: f64, uy: f64, dir: usize) -> f64 {
    assert!(dir < 9, "lattice: equilibrium direction must be 0..9");
    let cu = CX[dir] as f64 * ux + CY[dir] as f64 * uy;
    let u2 = ux * ux + uy * uy;
    W[dir] * rho * (1.0 + 3.0 * cu + 4.5 * cu * cu - 1.5 * u2)
}

/// Macroscopic density and velocity from one cell population slice.
/// Panics unless the slice holds at least 9 populations so a future
/// caller passing a misaligned slice fails loudly instead of
/// accumulating a silent partial sum.
pub fn macroscopic(f_cell: &[f32]) -> (f64, f64, f64) {
    assert!(f_cell.len() >= 9, "lattice: macroscopic needs 9 populations");
    let mut rho = 0.0;
    let mut ux = 0.0;
    let mut uy = 0.0;
    for d in 0..9 {
        let f = f_cell[d] as f64;
        rho += f;
        ux += f * CX[d] as f64;
        uy += f * CY[d] as f64;
    }
    if rho != 0.0 {
        ux /= rho;
        uy /= rho;
    }
    (rho, ux, uy)
}

/// Converted lattice parameters for one run.
#[derive(Clone, Copy, Debug)]
pub struct LatticeParams {
    pub h: f64,
    pub d_lat: f64,
    pub h_lat: f64,
    pub blockage: f64,
    pub nu_lat: f64,
    pub tau: f64,
    pub omega: f64,
    pub ma: f64,
    pub t_steps: f64,
    pub u_lattice: f64,
    pub re: f64,
    pub d_phys: f64,
}

/// Build lattice parameters from physical inputs. Uses the exact
/// blueprint conversions. st is the Strouhal used for T_steps.
pub fn lattice_params(
    dx_phys: f64,
    ny: usize,
    d_phys: f64,
    u_lattice: f64,
    re: f64,
    st: f64,
) -> Result<LatticeParams, String> {
    if !dx_phys.is_finite() || dx_phys <= 0.0 {
        return Err(format!("lattice: dx_phys must be positive, got {dx_phys}"));
    }
    if !d_phys.is_finite() || d_phys <= 0.0 {
        return Err(format!("lattice: D_phys must be positive, got {d_phys}"));
    }
    if !u_lattice.is_finite() || u_lattice <= 0.0 {
        return Err(format!("lattice: u_lattice must be positive, got {u_lattice}"));
    }
    if !re.is_finite() || re <= 0.0 {
        return Err(format!("lattice: re must be positive, got {re}"));
    }
    if ny < 4 {
        return Err(format!("lattice: ny must be >= 4, got {ny}"));
    }
    let h = dx_phys;
    let d_lat = d_phys / h;
    let h_lat = (ny - 1) as f64;
    let blockage = if h_lat > 0.0 { d_lat / h_lat } else { 0.0 };
    let nu_lat = u_lattice * d_lat / re;
    let tau = 3.0 * nu_lat + 0.5;
    let omega = 1.0 / tau;
    let ma = u_lattice / CS;
    let st_use = if st.is_finite() && st > 0.0 { st } else { ST_DEFAULT };
    let t_steps = d_lat / (st_use * u_lattice);
    Ok(LatticeParams {
        h,
        d_lat,
        h_lat,
        blockage,
        nu_lat,
        tau,
        omega,
        ma,
        t_steps,
        u_lattice,
        re,
        d_phys,
    })
}

/// Validate the relaxation time floor and warn band.
pub fn check_tau(tau: f64) -> Result<Option<String>, String> {
    if !tau.is_finite() {
        return Err("lbm: tau must be finite".to_string());
    }
    if tau <= TAU_FLOOR {
        return Err(format!("lbm: tau {tau} at or below floor {TAU_FLOOR}, reduce u_lattice or refine grid"));
    }
    if tau < TAU_WARN {
        return Ok(Some(format!(
            "lbm: tau {tau} below {TAU_WARN}, low viscosity run, watch for instability"
        )));
    }
    Ok(None)
}

/// Non equilibrium second moment sums used by the Smagorinsky kernel.
/// Panics unless both slices hold at least 9 entries so a misaligned
/// caller fails loudly instead of silently dropping directions.
pub fn non_equilibrium_moments(f: &[f64], feq: &[f64]) -> (f64, f64, f64) {
    assert!(f.len() >= 9, "lattice: non_equilibrium_moments needs 9 populations");
    assert!(feq.len() >= 9, "lattice: non_equilibrium_moments needs 9 equilibria");
    let mut qxx = 0.0;
    let mut qyy = 0.0;
    let mut qxy = 0.0;
    for d in 0..9 {
        let neq = f[d] - feq[d];
        let cx = CX[d] as f64;
        let cy = CY[d] as f64;
        qxx += neq * cx * cx;
        qyy += neq * cy * cy;
        qxy += neq * cx * cy;
    }
    (qxx, qyy, qxy)
}

/// Explicit Smagorinsky effective relaxation time per the blueprint.
/// Returns (tau_eff, nu_t, smag). nu_t clamped at 0.1, tau_eff at 2.0.
pub fn smagorinsky_tau(
    qxx: f64,
    qyy: f64,
    qxy: f64,
    rho: f64,
    tau: f64,
    cs_smag: f64,
    nu_lat: f64,
) -> (f64, f64, f64) {
    if !rho.is_finite() || rho <= 0.0 {
        return (tau, 0.0, 0.0);
    }
    let denom = 2.0 * rho * CS2 * tau;
    if denom == 0.0 || !denom.is_finite() {
        return (tau, 0.0, 0.0);
    }
    let sxx = -qxx / denom;
    let syy = -qyy / denom;
    let sxy = -qxy / denom;
    let smag = (2.0 * (sxx * sxx + 2.0 * sxy * sxy + syy * syy)).sqrt();
    let mut nu_t = cs_smag * cs_smag * smag;
    if !nu_t.is_finite() || nu_t < 0.0 {
        nu_t = 0.0;
    }
    if nu_t > 0.1 {
        nu_t = 0.1;
    }
    let nu_eff = nu_lat + nu_t;
    let mut tau_eff = 3.0 * nu_eff + 0.5;
    if tau_eff > 2.0 {
        tau_eff = 2.0;
    }
    if !tau_eff.is_finite() {
        return (tau, 0.0, 0.0);
    }
    (tau_eff, nu_t, smag)
}

/// Reference blockage limit in percent for labelling.
pub const BLOCKAGE_LIMIT_PERCENT: f64 = 5.0;

/// Blockage labelling for Phase 11 and Phase 12.
/// ratio is D_lat / H_lat, percent is ratio times 100,
/// cd_correction is (1 - ratio) squared, the first order
/// solid blockage factor that maps a confined Cd to free flow.
#[derive(Clone, Debug)]
pub struct BlockageReport {
    pub ratio: f64,
    pub percent: f64,
    pub limit_percent: f64,
    pub warning: Option<String>,
    pub cd_correction: f64,
}

/// Build a blockage report from a blockage ratio.
/// Negative ratios are clamped to 0, ratios above 1 are clamped to 1
/// for the correction factor so the output stays finite.
pub fn blockage_report(ratio: f64) -> BlockageReport {
    let r = if !ratio.is_finite() {
        0.0
    } else {
        ratio.clamp(0.0, 1.0)
    };
    let percent = r * 100.0;
    let warning = if r > BLOCKAGE_LIMIT_PERCENT / 100.0 {
        Some(format!(
            "blockage {:.1} percent exceeds 5 percent reference limit, Cd will read high",
            percent
        ))
    } else {
        None
    };
    BlockageReport {
        ratio: r,
        percent,
        limit_percent: BLOCKAGE_LIMIT_PERCENT,
        warning,
        cd_correction: (1.0 - r) * (1.0 - r),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weights_sum_to_one() {
        let s: f64 = W.iter().sum();
        assert!((s - 1.0).abs() < 1e-15);
    }

    #[test]
    fn opposite_pairs_match() {
        for d in 0..9 {
            assert_eq!(OPP[OPP[d]], d);
            assert_eq!(CX[d] + CX[OPP[d]], 0);
            assert_eq!(CY[d] + CY[OPP[d]], 0);
        }
    }

    #[test]
    fn reflect_tables_are_involutions() {
        for d in 0..9 {
            assert_eq!(REFLECT_Y[REFLECT_Y[d]], d);
            assert_eq!(REFLECT_X[REFLECT_X[d]], d);
        }
        assert_eq!(REFLECT_Y[2], 4);
        assert_eq!(REFLECT_Y[5], 8);
        assert_eq!(REFLECT_Y[6], 7);
    }

    #[test]
    fn equilibrium_conserves_mass_and_momentum() {
        let rho = 1.0;
        let (ux, uy) = (0.05, 0.01);
        let mut mass = 0.0;
        let mut mx = 0.0;
        let mut my = 0.0;
        for d in 0..9 {
            let f = equilibrium(rho, ux, uy, d);
            mass += f;
            mx += f * CX[d] as f64;
            my += f * CY[d] as f64;
        }
        assert!((mass - rho).abs() < 1e-12, "mass = {mass}");
        assert!((mx - rho * ux).abs() < 1e-12);
        assert!((my - rho * uy).abs() < 1e-12);
    }

    #[test]
    fn lattice_params_match_blueprint() {
        let p = lattice_params(0.02, 128, 0.32, 0.08, 100.0, 0.165).unwrap();
        assert!((p.d_lat - 16.0).abs() < 1e-12);
        assert!((p.nu_lat - 0.08 * 16.0 / 100.0).abs() < 1e-15);
        assert!((p.tau - (3.0 * p.nu_lat + 0.5)).abs() < 1e-15);
        assert!((p.ma - 0.08 * 3.0f64.sqrt()).abs() < 1e-15);
        assert!((p.t_steps - 16.0 / (0.165 * 0.08)).abs() < 1e-9);
    }

    #[test]
    fn tau_floor_rejects() {
        assert!(check_tau(0.5).is_err());
        assert!(check_tau(0.505).is_err());
        assert!(check_tau(0.52).is_ok());
    }

    #[test]
    fn source_index_bounds() {
        assert!(source_index(0, 0, 1, 8, 8).is_none());
        assert!(source_index(4, 4, 1, 8, 8).is_some());
    }

    #[test]
    #[should_panic(expected = "direction must be 0..9")]
    fn source_index_panics_on_bad_direction() {
        let _ = source_index(4, 4, 9, 8, 8);
    }

    #[test]
    #[should_panic(expected = "needs 9 populations")]
    fn macroscopic_panics_on_short_slice() {
        let _ = macroscopic(&[1.0f32; 4]);
    }

    #[test]
    #[should_panic(expected = "needs 9 equilibria")]
    fn non_equilibrium_moments_panics_on_short_slice() {
        let _ = non_equilibrium_moments(&[0.0; 9], &[0.0; 4]);
    }

    #[test]
    fn blockage_report_factors() {
        let free = blockage_report(0.0);
        assert!((free.ratio - 0.0).abs() < 1e-15);
        assert!((free.percent - 0.0).abs() < 1e-15);
        assert!((free.limit_percent - 5.0).abs() < 1e-15);
        assert!(free.warning.is_none());
        assert!((free.cd_correction - 1.0).abs() < 1e-15);
        let mid = blockage_report(0.047);
        assert!((mid.percent - 4.7).abs() < 1e-12);
        assert!(mid.warning.is_none());
        let expected_mid = (1.0 - 0.047) * (1.0 - 0.047);
        assert!((mid.cd_correction - expected_mid).abs() < 1e-15);
        let high = blockage_report(0.126);
        assert!((high.percent - 12.6).abs() < 1e-12);
        assert!(high.warning.is_some());
        let expected_high = (1.0 - 0.126) * (1.0 - 0.126);
        assert!((high.cd_correction - expected_high).abs() < 1e-15);
    }
}
