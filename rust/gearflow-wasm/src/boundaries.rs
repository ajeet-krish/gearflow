// LBM boundary conditions: Zou and He inlet, convective outlet,
// zero gradient fallback, free slip top and bottom, corner precedence.
// Pure math, no wasm-bindgen, host testable.

use crate::lattice::REFLECT_Y;

/// Inlet velocity profile.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InletProfile {
    Uniform,
    Parabolic,
}

/// Outlet treatment.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum OutletKind {
    Convective,
    ZeroGradient,
}

impl InletProfile {
    /// Inlet speed factor at row j. Parabolic peaks at 1 on the centreline.
    pub fn factor(&self, j: usize, ny: usize, u_lattice: f64) -> f64 {
        match self {
            InletProfile::Uniform => u_lattice,
            InletProfile::Parabolic => {
                if ny < 2 {
                    return u_lattice;
                }
                let s = j as f64 / (ny - 1) as f64;
                u_lattice * 4.0 * s * (1.0 - s)
            }
        }
    }
}

/// Zou and He inlet on column i = 0. Unknowns after streaming are f1, f5, f8.
/// Skips solid cells. Uses the exact blueprint density formula.
pub fn apply_inlet(
    f_next: &mut [f32],
    nx: usize,
    ny: usize,
    solid: &[u8],
    profile: InletProfile,
    u_lattice: f64,
) {
    for j in 0..ny {
        let k = j * nx;
        if solid[k] != 0 {
            continue;
        }
        let ux = profile.factor(j, ny, u_lattice);
        if !(ux >= 0.0) || !ux.is_finite() {
            continue;
        }
        if ux >= 0.999 {
            continue;
        }
        let b = k * 9;
        let f0 = f_next[b] as f64;
        let f2 = f_next[b + 2] as f64;
        let f4 = f_next[b + 4] as f64;
        let f3 = f_next[b + 3] as f64;
        let f6 = f_next[b + 6] as f64;
        let f7 = f_next[b + 7] as f64;
        let denom = 1.0 - ux;
        if denom.abs() < 1e-12 {
            continue;
        }
        let rho_in = (f0 + f2 + f4 + 2.0 * (f3 + f6 + f7)) / denom;
        if !rho_in.is_finite() || rho_in <= 0.0 {
            continue;
        }
        let f1 = f3 + (2.0 / 3.0) * rho_in * ux;
        let f5 = f7 + 0.5 * (f4 - f2) + (1.0 / 6.0) * rho_in * ux;
        let f8 = f6 + 0.5 * (f2 - f4) + (1.0 / 6.0) * rho_in * ux;
        f_next[b + 1] = f1 as f32;
        f_next[b + 5] = f5 as f32;
        f_next[b + 8] = f8 as f32;
    }
}

/// Convective outlet on column i = nx - 1 for incoming d in {3, 6, 7}.
/// f[d](nx-1) = (f_old[d](nx-1) + Uc f[d](nx-2)) / (1 + Uc).
pub fn apply_outlet_convective(
    f_next: &mut [f32],
    f_old: &[f32],
    nx: usize,
    ny: usize,
    solid: &[u8],
    uc: f64,
) {
    let denom = 1.0 + uc;
    if !(denom > 0.0) || !denom.is_finite() {
        return;
    }
    for j in 0..ny {
        let k_out = j * nx + (nx - 1);
        if solid[k_out] != 0 {
            continue;
        }
        let k_in = j * nx + (nx - 2);
        if solid[k_in] != 0 {
            continue;
        }
        for d in [3usize, 6, 7] {
            let old = f_old[k_out * 9 + d] as f64;
            let inner = f_next[k_in * 9 + d] as f64;
            if !old.is_finite() || !inner.is_finite() {
                continue;
            }
            f_next[k_out * 9 + d] = ((old + uc * inner) / denom) as f32;
        }
    }
}

/// Zero gradient outlet: copy every population from the interior neighbour.
pub fn apply_outlet_zero_gradient(f_next: &mut [f32], nx: usize, ny: usize, solid: &[u8]) {
    for j in 0..ny {
        let k_out = j * nx + (nx - 1);
        if solid[k_out] != 0 {
            continue;
        }
        let k_in = j * nx + (nx - 2);
        if solid[k_in] != 0 {
            continue;
        }
        for d in 0..9 {
            f_next[k_out * 9 + d] = f_next[k_in * 9 + d];
        }
    }
}

/// Free slip top and bottom via specular reflection through REFLECT_Y.
/// Top row j = ny - 1 misses southward d in {4, 7, 8}, filled from the
/// valid northward partners. Bottom row j = 0 misses northward
/// d in {2, 5, 6}. Only the missing populations are written.
pub fn apply_free_slip(f_next: &mut [f32], nx: usize, ny: usize, solid: &[u8]) {
    let top = ny - 1;
    for i in 0..nx {
        let k = top * nx + i;
        if solid[k] != 0 {
            continue;
        }
        let b = k * 9;
        for d in [4usize, 7, 8] {
            f_next[b + d] = f_next[b + REFLECT_Y[d]];
        }
    }
    for i in 0..nx {
        let k = i;
        if solid[k] != 0 {
            continue;
        }
        let b = k * 9;
        for d in [2usize, 5, 6] {
            f_next[b + d] = f_next[b + REFLECT_Y[d]];
        }
    }
}

/// Apply all boundaries with corner precedence: free slip first,
/// then inlet overwrite, then outlet overwrite.
/// Panics on buffer size mismatches so a future caller passing a wrong
/// sized field fails loudly instead of indexing out of bounds or
/// silently skipping rows.
pub fn apply_boundaries(
    f_next: &mut [f32],
    f_old: &[f32],
    nx: usize,
    ny: usize,
    solid: &[u8],
    inlet: InletProfile,
    outlet: OutletKind,
    u_lattice: f64,
) {
    assert!(nx >= 1 && ny >= 1, "boundaries: grid dims must be positive");
    let cells = nx.checked_mul(ny).expect("boundaries: nx*ny overflows");
    assert!(f_next.len() == cells * 9, "boundaries: f_next len must equal nx*ny*9");
    assert!(f_old.len() == cells * 9, "boundaries: f_old len must equal nx*ny*9");
    assert!(solid.len() == cells, "boundaries: solid len must equal nx*ny");
    apply_free_slip(f_next, nx, ny, solid);
    apply_inlet(f_next, nx, ny, solid, inlet, u_lattice);
    match outlet {
        OutletKind::Convective => apply_outlet_convective(f_next, f_old, nx, ny, solid, u_lattice),
        OutletKind::ZeroGradient => apply_outlet_zero_gradient(f_next, nx, ny, solid),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parabolic_factor_peaks_at_centre() {
        let ny = 33;
        let peak = InletProfile::Parabolic.factor(16, ny, 0.1);
        assert!((peak - 0.1).abs() < 1e-12, "peak = {peak}");
        assert!(InletProfile::Parabolic.factor(0, ny, 0.1).abs() < 1e-12);
    }

    #[test]
    fn uniform_factor_is_constant() {
        assert!((InletProfile::Uniform.factor(0, 16, 0.07) - 0.07).abs() < 1e-15);
        assert!((InletProfile::Uniform.factor(15, 16, 0.07) - 0.07).abs() < 1e-15);
    }

    #[test]
    fn free_slip_mirrors_normal_populations() {
        let (nx, ny) = (4, 4);
        let mut f = vec![0.0f32; nx * ny * 9];
        let solid = vec![0u8; nx * ny];
        // Top row: valid northward f2, f5, f6 fill missing southward.
        let k = (ny - 1) * nx + 1;
        f[k * 9 + 2] = 0.2;
        f[k * 9 + 6] = 0.06;
        f[k * 9 + 5] = 0.05;
        apply_free_slip(&mut f, nx, ny, &solid);
        assert_eq!(f[k * 9 + 4], 0.2);
        assert_eq!(f[k * 9 + 7], 0.06);
        assert_eq!(f[k * 9 + 8], 0.05);
        // Bottom row: valid southward f4, f7, f8 fill missing northward.
        let kb = 2usize;
        let mut g = vec![0.0f32; nx * ny * 9];
        g[kb * 9 + 4] = 0.3;
        g[kb * 9 + 8] = 0.07;
        g[kb * 9 + 7] = 0.09;
        apply_free_slip(&mut g, nx, ny, &solid);
        assert_eq!(g[kb * 9 + 2], 0.3);
        assert_eq!(g[kb * 9 + 5], 0.07);
        assert_eq!(g[kb * 9 + 6], 0.09);
    }

    #[test]
    fn zou_he_inlet_matches_hand_formula() {
        // Hand case with exact binary fractions so f32 is exact.
        // ux 0.5, f0 0.5, f2 0.25, f4 0.125, f3 0.25, f6 0.125, f7 0.125.
        // rho_in = (0.5 + 0.25 + 0.125 + 2 (0.25 + 0.125 + 0.125)) / 0.5
        //        = 1.875 / 0.5 = 3.75.
        // f1 = 0.25 + (2/3) * 3.75 * 0.5 = 1.5.
        // f5 = 0.125 + 0.5 (0.125 - 0.25) + (1/6) * 3.75 * 0.5 = 0.375.
        // f8 = 0.125 + 0.5 (0.25 - 0.125) + (1/6) * 3.75 * 0.5 = 0.5.
        // The f4 minus f2 term is negative, the f2 minus f4 term is
        // positive, pinning the sign of each transverse correction.
        let (nx, ny) = (3, 3);
        let mut f = vec![0.0f32; nx * ny * 9];
        let solid = vec![0u8; nx * ny];
        let j = 1usize;
        let b = (j * nx) * 9;
        f[b] = 0.5;
        f[b + 2] = 0.25;
        f[b + 4] = 0.125;
        f[b + 3] = 0.25;
        f[b + 6] = 0.125;
        f[b + 7] = 0.125;
        apply_inlet(&mut f, nx, ny, &solid, InletProfile::Uniform, 0.5);
        let rho_in = (0.5 + 0.25 + 0.125 + 2.0 * (0.25 + 0.125 + 0.125)) / 0.5;
        assert!((rho_in - 3.75f64).abs() < 1e-12);
        assert!(((f[b + 1] as f64) - 1.5).abs() < 1e-9, "f1 = {}", f[b + 1]);
        assert!(((f[b + 5] as f64) - 0.375).abs() < 1e-9, "f5 = {}", f[b + 5]);
        assert!(((f[b + 8] as f64) - 0.5).abs() < 1e-9, "f8 = {}", f[b + 8]);
        // Sign pins: f5 correction (f4 - f2) pulls below the pressure term,
        // f8 correction (f2 - f4) pushes above it by the same magnitude.
        let press = (1.0 / 6.0) * rho_in * 0.5;
        assert!((f[b + 5] as f64) < 0.125 + press);
        assert!((f[b + 8] as f64) > 0.125 + press);
    }

    #[test]
    fn convective_outlet_matches_weighted_formula() {
        // f[d](nx-1) = (f_old[d](nx-1) + Uc f[d](nx-2)) / (1 + Uc).
        let (nx, ny) = (4, 2);
        let solid = vec![0u8; nx * ny];
        let uc = 0.1;
        let mut f_next = vec![0.0f32; nx * ny * 9];
        let mut f_old = vec![0.0f32; nx * ny * 9];
        for j in 0..ny {
            let k_out = j * nx + (nx - 1);
            let k_in = j * nx + (nx - 2);
            f_old[(k_out * 9) + 3] = 0.6;
            f_next[(k_in * 9) + 3] = 0.3;
            f_old[(k_out * 9) + 6] = 0.2;
            f_next[(k_in * 9) + 6] = 0.5;
            f_old[(k_out * 9) + 7] = 0.0;
            f_next[(k_in * 9) + 7] = 0.4;
        }
        apply_outlet_convective(&mut f_next, &f_old, nx, ny, &solid, uc);
        let denom = 1.0 + uc;
        let e3 = (0.6 + uc * 0.3) / denom;
        let e6 = (0.2 + uc * 0.5) / denom;
        let e7 = (0.0 + uc * 0.4) / denom;
        for j in 0..ny {
            let k_out = j * nx + (nx - 1);
            assert!(((f_next[k_out * 9 + 3] as f64) - e3).abs() < 1e-6);
            assert!(((f_next[k_out * 9 + 6] as f64) - e6).abs() < 1e-6);
            assert!(((f_next[k_out * 9 + 7] as f64) - e7).abs() < 1e-6);
        }
        // Wrong slice check: using the outlet column itself as the inner
        // value would give f_old / (1 + Uc) plus Uc times itself, which
        // differs whenever inner and outlet differ.
        let wrong = (0.6 + uc * 0.6) / denom;
        assert!((wrong - e3).abs() > 1e-9, "wrong slice must differ");
    }

    #[test]
    fn convective_outlet_skips_solid_interior() {
        let (nx, ny) = (4, 2);
        let mut solid = vec![0u8; nx * ny];
        solid[0 * nx + (nx - 2)] = 1;
        let mut f_next = vec![1.0f32; nx * ny * 9];
        let f_old = vec![0.5f32; nx * ny * 9];
        let before = f_next.clone();
        apply_outlet_convective(&mut f_next, &f_old, nx, ny, &solid, 0.1);
        let k_out = 0 * nx + (nx - 1);
        for d in [3usize, 6, 7] {
            assert_eq!(f_next[k_out * 9 + d], before[k_out * 9 + d]);
        }
        // Fluid row still updates.
        let k1 = 1 * nx + (nx - 1);
        assert!((f_next[k1 * 9 + 3] as f64 - (0.5 + 0.1 * 1.0) / 1.1).abs() < 1e-6);
    }

    #[test]
    fn corner_precedence_inlet_and_outlet_win() {
        // 4 by 4 with a solid bottom left corner and zero edges elsewhere.
        // Free slip runs first, inlet and outlet overwrite after, so the
        // corner columns must hold the boundary formulas, not free slip.
        let (nx, ny) = (4, 4);
        let mut solid = vec![0u8; nx * ny];
        solid[0] = 1;
        let mut f_next = vec![0.0f32; nx * ny * 9];
        let mut f_old = vec![0.0f32; nx * ny * 9];
        // Top left corner inputs for Zou He with ux 0.5.
        let ktl = (ny - 1) * nx;
        f_next[ktl * 9] = 0.5;
        f_next[ktl * 9 + 2] = 0.25;
        f_next[ktl * 9 + 4] = 0.125;
        f_next[ktl * 9 + 3] = 0.25;
        f_next[ktl * 9 + 6] = 0.125;
        f_next[ktl * 9 + 7] = 0.125;
        // Outlet column old values plus inner values for convective.
        for j in 0..ny {
            let k_out = j * nx + (nx - 1);
            let k_in = j * nx + (nx - 2);
            if solid[k_out] != 0 {
                continue;
            }
            f_old[k_out * 9 + 3] = 1.0;
            f_next[k_in * 9 + 3] = 0.0;
            f_old[k_out * 9 + 6] = 1.0;
            f_next[k_in * 9 + 6] = 0.0;
            f_old[k_out * 9 + 7] = 1.0;
            f_next[k_in * 9 + 7] = 0.0;
        }
        apply_boundaries(
            &mut f_next,
            &f_old,
            nx,
            ny,
            &solid,
            InletProfile::Uniform,
            OutletKind::Convective,
            0.5,
        );
        // Inlet wins at top left: free slip first sets f4 to f2 (0.25),
        // then Zou He gives rho 4.0, f8 0.458333, not the free slip copy.
        let rho_after = (0.5 + 0.25 + 0.25 + 2.0 * (0.25 + 0.125 + 0.125)) / 0.5;
        assert!((rho_after - 4.0f64).abs() < 1e-12);
        let exp_f8 = 0.125 + 0.5 * (0.25 - 0.25) + (1.0 / 6.0) * rho_after * 0.5;
        assert!(((f_next[ktl * 9 + 8] as f64) - exp_f8).abs() < 1e-6);
        // Outlet wins at bottom right: convective 1 / 1.5, not free slip zero.
        let kbr = 0 * nx + (nx - 1);
        let exp_out = 1.0 / 1.5;
        assert!(((f_next[kbr * 9 + 3] as f64) - exp_out).abs() < 1e-6);
        assert!(((f_next[kbr * 9 + 6] as f64) - exp_out).abs() < 1e-6);
        // Solid corner untouched.
        for d in 0..9 {
            assert_eq!(f_next[d], 0.0);
        }
    }

    #[test]
    #[should_panic(expected = "boundaries: solid len")]
    fn apply_boundaries_panics_on_short_solid() {
        let (nx, ny) = (4, 4);
        let mut f_next = vec![0.0f32; nx * ny * 9];
        let f_old = vec![0.0f32; nx * ny * 9];
        let solid = vec![0u8; 4];
        apply_boundaries(&mut f_next, &f_old, nx, ny, &solid, InletProfile::Uniform, OutletKind::Convective, 0.05);
    }
}
