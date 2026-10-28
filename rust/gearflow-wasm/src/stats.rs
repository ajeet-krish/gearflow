// Time statistics for the LBM core. Transient gating, accumulation,
// finalisation with the exact blueprint formulas and epsilon guards.
// Pure math, no wasm-bindgen, host testable.

use crate::lattice::CS2;

/// Running time statistics over the fluid cells.
#[derive(Clone, Debug)]
pub struct StatsAccumulator {
    pub start_step: u64,
    pub sample_every: u64,
    pub samples: u64,
    nx: usize,
    ny: usize,
    cells: usize,
    sum_u: Vec<f64>,
    sum_v: Vec<f64>,
    sum_p: Vec<f64>,
    sum_u2: Vec<f64>,
    sum_v2: Vec<f64>,
    recirc_hits: Vec<f64>,
}

impl StatsAccumulator {
    /// Create zeroed accumulators for an nx by ny grid. Applies the same
    /// grid caps as the solver (nx and ny at most 512, nx times ny at most
    /// 262144) and stores one checked cell count used for allocation,
    /// sampling, and finalisation.
    pub fn new(nx: usize, ny: usize, start_step: u64, sample_every: u64) -> Result<Self, String> {
        if nx < 4 || ny < 4 {
            return Err(format!("stats: nx and ny must be >= 4, got {nx}x{ny}"));
        }
        if nx > 512 || ny > 512 {
            return Err("stats: nx and ny must be <= 512".to_string());
        }
        let cells = nx.checked_mul(ny).ok_or_else(|| {
            format!("stats: nx*ny overflows, got {nx}x{ny}")
        })?;
        if cells > 262144 {
            return Err("stats: nx*ny must be <= 262144".to_string());
        }
        if sample_every == 0 {
            return Err("stats: sample_every must be >= 1".to_string());
        }
        let n = cells;
        Ok(StatsAccumulator {
            start_step,
            sample_every,
            samples: 0,
            nx,
            ny,
            cells,
            sum_u: vec![0.0; n],
            sum_v: vec![0.0; n],
            sum_p: vec![0.0; n],
            sum_u2: vec![0.0; n],
            sum_v2: vec![0.0; n],
            recirc_hits: vec![0.0; n],
        })
    }

    /// Clear all sums and the sample count.
    pub fn reset(&mut self) {
        for v in self.sum_u.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_p.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_u2.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v2.iter_mut() {
            *v = 0.0;
        }
        for v in self.recirc_hits.iter_mut() {
            *v = 0.0;
        }
        self.samples = 0;
    }

    /// Sample one step when due. Solid cells contribute nothing.
    /// Panics on a slice length mismatch so a future caller passing a
    /// wrong sized field fails loudly instead of sampling silently.
    pub fn sample(&mut self, step: u64, rho: &[f32], u: &[f32], v: &[f32], solid: &[u8]) {
        if step < self.start_step {
            return;
        }
        if (step - self.start_step) % self.sample_every != 0 {
            return;
        }
        let n = self.cells;
        assert!(rho.len() == n, "stats: rho len {} must equal cells {n}", rho.len());
        assert!(u.len() == n, "stats: u len {} must equal cells {n}", u.len());
        assert!(v.len() == n, "stats: v len {} must equal cells {n}", v.len());
        assert!(solid.len() == n, "stats: solid len {} must equal cells {n}", solid.len());
        for k in 0..n {
            if solid[k] != 0 {
                continue;
            }
            let uu = u[k] as f64;
            let vv = v[k] as f64;
            let pp = CS2 * (rho[k] as f64 - 1.0);
            self.sum_u[k] += uu;
            self.sum_v[k] += vv;
            self.sum_p[k] += pp;
            self.sum_u2[k] += uu * uu;
            self.sum_v2[k] += vv * vv;
            if uu < 0.0 {
                self.recirc_hits[k] += 1.0;
            }
        }
        self.samples += 1;
    }

    /// Time mean fields with solid zero and finite clamp, sized for the
    /// WASM boundary. Zero samples returns correctly sized zero arrays so
    /// the consumer never sees a short buffer. Uses the same formulas as
    /// finalise (mean, variance floor, k) and forces solid cells to 0.
    /// Returns (mean_u, mean_v, tke, recirc_mask).
    pub fn fields_or_zeros(&self, solid: &[u8]) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let cells = self.cells;
        assert!(
            solid.len() == cells,
            "stats: solid len {} must equal cells {cells}",
            solid.len()
        );
        if self.samples == 0 {
            return (vec![0.0; cells], vec![0.0; cells], vec![0.0; cells], vec![0.0; cells]);
        }
        let fin = match self.finalise() {
            Ok(f) => f,
            Err(_) => {
                return (vec![0.0; cells], vec![0.0; cells], vec![0.0; cells], vec![0.0; cells]);
            }
        };
        let mut mean_u = fin.mean_u;
        let mut mean_v = fin.mean_v;
        let mut tke = fin.tke;
        let mut mask = fin.recirc_mask;
        for k in 0..cells {
            if solid[k] != 0 {
                mean_u[k] = 0.0;
                mean_v[k] = 0.0;
                tke[k] = 0.0;
                mask[k] = 0.0;
                continue;
            }
            if !mean_u[k].is_finite() {
                mean_u[k] = 0.0;
            }
            if !mean_v[k].is_finite() {
                mean_v[k] = 0.0;
            }
            if !tke[k].is_finite() || tke[k] < 0.0 {
                tke[k] = 0.0;
            }
            if !mask[k].is_finite() {
                mask[k] = 0.0;
            } else if mask[k] != 0.0 && mask[k] != 1.0 {
                mask[k] = if mask[k] > 0.5 { 1.0 } else { 0.0 };
            }
        }
        (mean_u, mean_v, tke, mask)
    }

    /// Full dataset mean channels with solid zero and finite clamp.
    /// Additive export for the native dataset runner. Returns
    /// (mean_u, mean_v, mean_p, tke, mean_omega, recirc_mask).
    /// mean_omega is the central difference vorticity of the mean field
    /// with the same stencil as the snapshot path. Zero samples returns
    /// six full length zero arrays. Solid cells read 0 on every channel.
    pub fn fields_or_zeros_full(
        &self,
        solid: &[u8],
        nx: usize,
        ny: usize,
        dx: f64,
        dy: f64,
    ) -> (Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>, Vec<f32>) {
        let cells = self.cells;
        assert!(
            solid.len() == cells,
            "stats: solid len {} must equal cells {cells}",
            solid.len()
        );
        assert!(
            nx * ny == cells,
            "stats: nx*ny must equal cells {cells}"
        );
        if self.samples == 0 {
            return (
                vec![0.0; cells],
                vec![0.0; cells],
                vec![0.0; cells],
                vec![0.0; cells],
                vec![0.0; cells],
                vec![0.0; cells],
            );
        }
        let fin = match self.finalise() {
            Ok(f) => f,
            Err(_) => {
                return (
                    vec![0.0; cells],
                    vec![0.0; cells],
                    vec![0.0; cells],
                    vec![0.0; cells],
                    vec![0.0; cells],
                    vec![0.0; cells],
                );
            }
        };
        let mut mean_u = fin.mean_u;
        let mut mean_v = fin.mean_v;
        let mut mean_p = fin.mean_p;
        let mut tke = fin.tke;
        let mut mask = fin.recirc_mask;
        for k in 0..cells {
            if solid[k] != 0 {
                mean_u[k] = 0.0;
                mean_v[k] = 0.0;
                mean_p[k] = 0.0;
                tke[k] = 0.0;
                mask[k] = 0.0;
                continue;
            }
            if !mean_u[k].is_finite() {
                mean_u[k] = 0.0;
            }
            if !mean_v[k].is_finite() {
                mean_v[k] = 0.0;
            }
            if !mean_p[k].is_finite() {
                mean_p[k] = 0.0;
            }
            if !tke[k].is_finite() || tke[k] < 0.0 {
                tke[k] = 0.0;
            }
            if !mask[k].is_finite() {
                mask[k] = 0.0;
            } else if mask[k] != 0.0 && mask[k] != 1.0 {
                mask[k] = if mask[k] > 0.5 { 1.0 } else { 0.0 };
            }
        }
        let mut mean_omega = vorticity_from_means(&mean_u, &mean_v, solid, nx, ny, dx, dy);
        for k in 0..cells {
            if solid[k] != 0 {
                mean_omega[k] = 0.0;
                continue;
            }
            if !mean_omega[k].is_finite() {
                mean_omega[k] = 0.0;
            }
        }
        (mean_u, mean_v, mean_p, tke, mean_omega, mask)
    }

    /// Global recirculation fraction for the stats report: fluid cells with
    /// time mean u < 0 divided by fluid cell count. Zero when there are no
    /// samples or no fluid cells. Pure and host testable.
    pub fn global_recirc_fraction(&self, solid: &[u8]) -> f64 {
        if self.samples == 0 {
            return 0.0;
        }
        let n = self.samples.max(1) as f64;
        let mut fluid = 0u64;
        let mut recirc = 0u64;
        for k in 0..self.cells {
            if k >= solid.len() || solid[k] != 0 {
                continue;
            }
            fluid += 1;
            if self.sum_u[k] / n < 0.0 {
                recirc += 1;
            }
        }
        if fluid == 0 {
            return 0.0;
        }
        let frac = recirc as f64 / fluid as f64;
        if frac.is_finite() {
            frac
        } else {
            0.0
        }
    }

    /// Finalise with n = max(samples, 1). Zero samples is an error.
    pub fn finalise(&self) -> Result<FinalStats, String> {
        if self.samples == 0 {
            return Err("stats: no samples accumulated".to_string());
        }
        let n = self.samples.max(1) as f64;
        let cells = self.cells;
        let mut mean_u = vec![0.0f32; cells];
        let mut mean_v = vec![0.0f32; cells];
        let mut mean_p = vec![0.0f32; cells];
        let mut rms_u = vec![0.0f32; cells];
        let mut rms_v = vec![0.0f32; cells];
        let mut tke = vec![0.0f32; cells];
        let mut recirc_fraction = vec![0.0f32; cells];
        let mut recirc_mask = vec![0.0f32; cells];
        for k in 0..cells {
            let mu = self.sum_u[k] / n;
            let mv = self.sum_v[k] / n;
            let mp = self.sum_p[k] / n;
            let var_u = (self.sum_u2[k] / n - mu * mu).max(0.0);
            let var_v = (self.sum_v2[k] / n - mv * mv).max(0.0);
            let ru = var_u.sqrt();
            let rv = var_v.sqrt();
            let kk = 0.5 * (var_u + var_v);
            mean_u[k] = mu as f32;
            mean_v[k] = mv as f32;
            mean_p[k] = mp as f32;
            rms_u[k] = ru as f32;
            rms_v[k] = rv as f32;
            tke[k] = kk as f32;
            recirc_fraction[k] = (self.recirc_hits[k] / n) as f32;
            recirc_mask[k] = if mu < 0.0 { 1.0 } else { 0.0 };
        }
        Ok(FinalStats {
            nx: self.nx,
            ny: self.ny,
            samples: self.samples,
            mean_u,
            mean_v,
            mean_p,
            rms_u,
            rms_v,
            tke,
            recirc_fraction,
            recirc_mask,
        })
    }
}

/// Central difference vorticity of a mean velocity field.
/// Same stencil as the snapshot path: one sided at domain edges,
/// physical dx and dy denominators, solid cells forced to 0.
pub fn vorticity_from_means(
    mean_u: &[f32],
    mean_v: &[f32],
    solid: &[u8],
    nx: usize,
    ny: usize,
    dx: f64,
    dy: f64,
) -> Vec<f32> {
    let n = nx * ny;
    assert!(mean_u.len() == n, "stats: mean_u len must equal nx*ny");
    assert!(mean_v.len() == n, "stats: mean_v len must equal nx*ny");
    assert!(solid.len() == n, "stats: solid len must equal nx*ny");
    let mut omega = vec![0.0f32; n];
    for j in 0..ny {
        for i in 0..nx {
            let k = j * nx + i;
            if solid[k] != 0 {
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
            let dvdx = (mean_v[j * nx + i_r] as f64 - mean_v[j * nx + i_l] as f64) / denom_x;
            let dudy = (mean_u[j_t * nx + i] as f64 - mean_u[j_b * nx + i] as f64) / denom_y;
            let w = dvdx - dudy;
            omega[k] = if w.is_finite() { w as f32 } else { 0.0 };
        }
    }
    omega
}

/// Time mean fields plus fluctuation energy and recirculation maps.
#[derive(Clone, Debug)]
pub struct FinalStats {
    pub nx: usize,
    pub ny: usize,
    pub samples: u64,
    pub mean_u: Vec<f32>,
    pub mean_v: Vec<f32>,
    pub mean_p: Vec<f32>,
    pub rms_u: Vec<f32>,
    pub rms_v: Vec<f32>,
    pub tke: Vec<f32>,
    pub recirc_fraction: Vec<f32>,
    pub recirc_mask: Vec<f32>,
}

/// Configuration for the phase averaged first harmonic fit. d_lat and
/// u_lattice set the physical Strouhal bounds 0.03 to 0.50 used to
/// freeze the shedding period. skip_cycles and min_cycles are retained
/// for API compatibility and no longer gate validity; the frozen window
/// needs at least 6 periods worth of samples.
#[derive(Clone, Copy, Debug)]
pub struct HarmonicConfig {
    pub d_lat: f64,
    pub u_lattice: f64,
    pub skip_cycles: u64,
    pub min_cycles: u64,
}

impl Default for HarmonicConfig {
    fn default() -> Self {
        HarmonicConfig {
            d_lat: 16.0,
            u_lattice: 0.08,
            skip_cycles: 2,
            min_cycles: 3,
        }
    }
}

/// Phase averaged first harmonic of u and v plus quality metadata.
/// Coefficient arrays use k = j * nx + i ordering, solid cells read
/// exactly 0. When valid is false all four arrays are exactly 0 but
/// explained_variance still reports the measured value (0 when no
/// period or no samples) so a weak harmonic stays visible in data
/// instead of being hidden as 0. reason is one of ok, no_period,
/// too_few_periods, low_explained, low_amplitude, non_finite,
/// not_shedding.
#[derive(Clone, Debug)]
pub struct HarmonicResult {
    pub u_cos: Vec<f32>,
    pub u_sin: Vec<f32>,
    pub v_cos: Vec<f32>,
    pub v_sin: Vec<f32>,
    pub explained_variance: f64,
    pub valid: bool,
    pub reason: String,
    pub cycles: u64,
    pub samples: u64,
    pub phase_ref_step: Option<u64>,
    pub mean_peak_interval: Option<f64>,
    pub interval_cv: Option<f64>,
}

impl HarmonicResult {
    /// All zero coefficients with valid false and the given length.
    /// reason defaults to not_shedding for the flag off path.
    pub fn zeros(cells: usize) -> Self {
        HarmonicResult {
            u_cos: vec![0.0; cells],
            u_sin: vec![0.0; cells],
            v_cos: vec![0.0; cells],
            v_sin: vec![0.0; cells],
            explained_variance: 0.0,
            valid: false,
            reason: "not_shedding".to_string(),
            cycles: 0,
            samples: 0,
            phase_ref_step: None,
            mean_peak_interval: None,
            interval_cv: None,
        }
    }
}

/// Strouhal locked least squares fit of u(t) = m + a cos(phi) + b sin(phi)
/// per fluid cell, same for v, with phi = 2 pi (t minus anchor) divided
/// by the frozen period. The period comes from the shared Cl Strouhal
/// estimator in forces.rs (strouhal_from_cl), frozen once a finite
/// Strouhal in 0.03 to 0.50 exists and two periods of steps exist after
/// the transient. The anchor is the lattice step of the global Cl
/// maximum since the transient at the freeze moment and never moves.
/// Field accumulation runs in sample on the existing stats cadence from
/// the freeze step onward. Spurious LES peaks cannot corrupt the fit
/// because no per cycle peak gating exists. All internal sums are f64.
#[derive(Clone, Debug)]
pub struct HarmonicAccumulator {
    cfg: HarmonicConfig,
    start_step: u64,
    sample_every: u64,
    cells: usize,
    cl_steps: Vec<u64>,
    cl_vals: Vec<f64>,
    frozen_period: Option<f64>,
    frozen_strouhal: Option<f64>,
    anchor_step: Option<u64>,
    freeze_step: Option<u64>,
    frozen_samples: u64,
    phase_ref_step: Option<u64>,
    sum_u_cos: Vec<f64>,
    sum_u_sin: Vec<f64>,
    sum_v_cos: Vec<f64>,
    sum_v_sin: Vec<f64>,
    sum_u: Vec<f64>,
    sum_v: Vec<f64>,
    sum_u2: Vec<f64>,
    sum_v2: Vec<f64>,
    gram_n: u64,
    gram_sc: f64,
    gram_ss: f64,
    gram_cc: f64,
    gram_cs: f64,
    gram_ss2: f64,
}

impl HarmonicAccumulator {
    /// Create zeroed accumulators with the same grid caps as the
    /// stats accumulator. d_lat and u_lattice must be positive finite.
    pub fn new(
        nx: usize,
        ny: usize,
        start_step: u64,
        sample_every: u64,
        cfg: HarmonicConfig,
    ) -> Result<Self, String> {
        if nx < 4 || ny < 4 {
            return Err(format!("harmonic: nx and ny must be >= 4, got {nx}x{ny}"));
        }
        if nx > 512 || ny > 512 {
            return Err("harmonic: nx and ny must be <= 512".to_string());
        }
        let cells = nx.checked_mul(ny).ok_or_else(|| {
            format!("harmonic: nx*ny overflows, got {nx}x{ny}")
        })?;
        if cells > 262144 {
            return Err("harmonic: nx*ny must be <= 262144".to_string());
        }
        if sample_every == 0 {
            return Err("harmonic: sample_every must be >= 1".to_string());
        }
        if !cfg.d_lat.is_finite() || cfg.d_lat <= 0.0 {
            return Err(format!("harmonic: d_lat must be positive, got {}", cfg.d_lat));
        }
        if !cfg.u_lattice.is_finite() || cfg.u_lattice <= 0.0 {
            return Err(format!(
                "harmonic: u_lattice must be positive, got {}",
                cfg.u_lattice
            ));
        }
        Ok(HarmonicAccumulator {
            cfg,
            start_step,
            sample_every,
            cells,
            cl_steps: Vec::new(),
            cl_vals: Vec::new(),
            frozen_period: None,
            frozen_strouhal: None,
            anchor_step: None,
            freeze_step: None,
            frozen_samples: 0,
            phase_ref_step: None,
            sum_u_cos: vec![0.0; cells],
            sum_u_sin: vec![0.0; cells],
            sum_v_cos: vec![0.0; cells],
            sum_v_sin: vec![0.0; cells],
            sum_u: vec![0.0; cells],
            sum_v: vec![0.0; cells],
            sum_u2: vec![0.0; cells],
            sum_v2: vec![0.0; cells],
            gram_n: 0,
            gram_sc: 0.0,
            gram_ss: 0.0,
            gram_cc: 0.0,
            gram_cs: 0.0,
            gram_ss2: 0.0,
        })
    }

    /// Clear every sum, Cl history, and the frozen period. Keeps
    /// config, grid, start step, and cadence.
    pub fn reset(&mut self) {
        self.cl_steps.clear();
        self.cl_vals.clear();
        self.frozen_period = None;
        self.frozen_strouhal = None;
        self.anchor_step = None;
        self.freeze_step = None;
        self.frozen_samples = 0;
        self.phase_ref_step = None;
        for v in self.sum_u_cos.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_u_sin.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v_cos.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v_sin.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_u.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_u2.iter_mut() {
            *v = 0.0;
        }
        for v in self.sum_v2.iter_mut() {
            *v = 0.0;
        }
        self.gram_n = 0;
        self.gram_sc = 0.0;
        self.gram_ss = 0.0;
        self.gram_cc = 0.0;
        self.gram_cs = 0.0;
        self.gram_ss2 = 0.0;
    }

    /// Whole periods in the frozen window, floor of frozen span over
    /// period. Zero before the freeze. Kept name for caller parity.
    pub fn committed_cycles(&self) -> u64 {
        match self.frozen_period {
            Some(p) if p > 0.0 && p.is_finite() => {
                ((self.frozen_samples as f64 * self.sample_every as f64) / p).floor().max(0.0) as u64
            }
            _ => 0,
        }
    }

    /// Frozen window sample count. Kept name for caller parity.
    pub fn committed_samples(&self) -> u64 {
        self.frozen_samples
    }

    /// Diagnostic peak intervals in steps, oldest first. Empty: the
    /// locked phase fit no longer gates on peaks, intervals are only
    /// recomputed as a diagnostic in finalise.
    pub fn committed_intervals(&self) -> &[f64] {
        &[]
    }

    /// Anchor step of phase zero, None before the freeze.
    pub fn phase_ref(&self) -> Option<u64> {
        self.phase_ref_step
    }

    /// Frozen shedding period in steps, None before the freeze.
    pub fn mean_peak_interval(&self) -> Option<f64> {
        self.frozen_period
    }

    /// Strouhal from the frozen period, None before the freeze or when
    /// the value is non finite.
    pub fn strouhal(&self) -> Option<f64> {
        self.frozen_strouhal.filter(|v| v.is_finite())
    }

    /// Anchor step of phase zero, None before the freeze.
    pub fn frozen_period(&self) -> Option<f64> {
        self.frozen_period
    }

    /// Freeze step, None before the freeze.
    pub fn freeze_step(&self) -> Option<u64> {
        self.freeze_step
    }

    /// Feed one lattice step of Cl. Call every step. Stores finite
    /// values at or after the start step for the shared Strouhal
    /// estimator. Non finite inputs are ignored.
    pub fn note_cl(&mut self, step: u64, cl: f64) {
        if !cl.is_finite() {
            return;
        }
        if step < self.start_step {
            return;
        }
        self.cl_steps.push(step);
        self.cl_vals.push(cl);
    }

    /// Sample one step when due on the stats cadence. Solid cells
    /// contribute nothing. Tries the Strouhal freeze when unfrozen,
    /// then accumulates into the frozen window from the freeze step
    /// onward. Panics on a slice length mismatch like the stats
    /// accumulator.
    pub fn sample(&mut self, step: u64, u: &[f32], v: &[f32], solid: &[u8]) {
        if step < self.start_step {
            return;
        }
        if (step - self.start_step) % self.sample_every != 0 {
            return;
        }
        let n = self.cells;
        assert!(u.len() == n, "harmonic: u len {} must equal cells {n}", u.len());
        assert!(v.len() == n, "harmonic: v len {} must equal cells {n}", v.len());
        assert!(solid.len() == n, "harmonic: solid len {} must equal cells {n}", solid.len());
        if self.frozen_period.is_none() {
            self.maybe_freeze(step);
        }
        let (period, anchor) = match (self.frozen_period, self.anchor_step) {
            (Some(p), Some(a)) if p.is_finite() && p > 0.0 => (p, a),
            _ => return,
        };
        if step < self.freeze_step.unwrap_or(step) {
            return;
        }
        let phi =
            2.0 * std::f64::consts::PI * (step as f64 - anchor as f64) / period;
        let c = phi.cos();
        let s = phi.sin();
        for k in 0..n {
            if solid[k] != 0 {
                continue;
            }
            let uu = u[k] as f64;
            let vv = v[k] as f64;
            self.sum_u_cos[k] += uu * c;
            self.sum_u_sin[k] += uu * s;
            self.sum_v_cos[k] += vv * c;
            self.sum_v_sin[k] += vv * s;
            self.sum_u[k] += uu;
            self.sum_v[k] += vv;
            self.sum_u2[k] += uu * uu;
            self.sum_v2[k] += vv * vv;
        }
        self.gram_n += 1;
        self.gram_sc += c;
        self.gram_ss += s;
        self.gram_cc += c * c;
        self.gram_cs += c * s;
        self.gram_ss2 += s * s;
        self.frozen_samples += 1;
    }

    /// Try to freeze the shedding period from the Cl history using the
    /// shared Strouhal estimator. Needs a finite Strouhal in 0.03 to
    /// 0.50 and at least two periods of steps after the transient.
    /// Robustness guards: at least 3 peaks (2 intervals) with interval
    /// coefficient of variation at most 0.12, so a spurious LES crest
    /// cannot freeze a biased period, and the estimate that also drops
    /// the last min_sep steps must agree within 4 percent, so a
    /// trailing partial crest cannot steer the freeze. Both guards
    /// auto relax as history grows: a single outlier inflates the CV
    /// and the window disagreement by about one over the peak count.
    /// The anchor is the step of the global Cl maximum since the
    /// transient over the full history and never moves afterwards.
    fn maybe_freeze(&mut self, step: u64) {
        if self.frozen_period.is_some() {
            return;
        }
        if self.cl_vals.len() < 16 {
            return;
        }
        // Same minimum peak separation as forces::strouhal_from_cl: a
        // peak within this distance of the history end is unconfirmed
        // and must not steer the freeze.
        let edge = (0.5 * self.cfg.d_lat / (0.2 * self.cfg.u_lattice)).round() as u64;
        let edge = edge.max(4);
        let mut b0 = self.cl_vals.len();
        let back_edge = step.saturating_sub(edge);
        while b0 > 0 && self.cl_steps[b0 - 1] > back_edge {
            b0 -= 1;
        }
        if b0 < 16 {
            return;
        }
        let confirmed = &self.cl_vals[..b0];
        let st_full = match crate::forces::strouhal_from_cl(
            &self.cl_vals,
            self.cfg.d_lat,
            self.cfg.u_lattice,
        ) {
            Ok(v) => v,
            Err(_) => return,
        };
        let st_trim = match crate::forces::strouhal_from_cl(
            confirmed,
            self.cfg.d_lat,
            self.cfg.u_lattice,
        ) {
            Ok(v) => v,
            Err(_) => return,
        };
        if !st_full.is_finite() || st_full < 0.03 || st_full > 0.50 {
            return;
        }
        let period = self.cfg.d_lat / (st_full * self.cfg.u_lattice);
        if !period.is_finite() || period <= 0.0 {
            return;
        }
        // Interval consistency on the full history: at least 3 peaks
        // with CV at most 0.12. A spurious crest inflates the spread
        // and blocks the freeze until dilution makes its bias harmless.
        let (_, cv) = match self.measured_interval_stats() {
            Some(v) => v,
            None => return,
        };
        if !cv.is_finite() || cv > 0.12 {
            return;
        }
        if !st_trim.is_finite() {
            return;
        }
        let period_trim = self.cfg.d_lat / (st_trim * self.cfg.u_lattice);
        if !period_trim.is_finite() || period_trim <= 0.0 {
            return;
        }
        if ((period - period_trim) / period).abs() > 0.04 {
            return;
        }
        let elapsed = step.saturating_sub(self.start_step) as f64;
        if elapsed < 2.0 * period {
            return;
        }
        let mut best = 0usize;
        for i in 1..self.cl_vals.len() {
            if self.cl_vals[i] > self.cl_vals[best] {
                best = i;
            }
        }
        let anchor = self.cl_steps[best];
        self.frozen_period = Some(period);
        self.frozen_strouhal = Some(st_full);
        self.anchor_step = Some(anchor);
        self.freeze_step = Some(step);
        self.phase_ref_step = Some(anchor);
    }

    /// Measured peak intervals in steps from the stored Cl history,
    /// using the same peak rule as forces::strouhal_from_cl. Returns
    /// (mean, coefficient of variation). Gates the freeze decision and
    /// reports the diagnostic CV, never gates validity.
    fn measured_interval_stats(&self) -> Option<(f64, f64)> {
        let n = self.cl_vals.len();
        if n < 16 {
            return None;
        }
        let mean: f64 = self.cl_vals.iter().sum::<f64>() / n as f64;
        let mut detrended = Vec::with_capacity(n);
        for v in &self.cl_vals {
            detrended.push(v - mean);
        }
        let rms = (detrended.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
        if !(rms > 0.0) || !rms.is_finite() {
            return None;
        }
        let threshold = 0.5 * rms;
        let min_sep = (0.5 * self.cfg.d_lat / (0.2 * self.cfg.u_lattice)).round() as usize;
        let min_sep = min_sep.max(4);
        let mut peaks: Vec<usize> = Vec::new();
        let mut last_peak: Option<usize> = None;
        for i in 1..(n - 1) {
            let v = detrended[i];
            if v > detrended[i - 1] && v >= detrended[i + 1] && v > threshold {
                if let Some(last) = last_peak {
                    if i - last < min_sep {
                        if v > detrended[last] {
                            peaks.pop();
                            peaks.push(i);
                            last_peak = Some(i);
                        }
                        continue;
                    }
                }
                peaks.push(i);
                last_peak = Some(i);
            }
        }
        if peaks.len() < 2 {
            return None;
        }
        let mut intervals: Vec<f64> = Vec::with_capacity(peaks.len() - 1);
        for w in 1..peaks.len() {
            let a = self.cl_steps[peaks[w - 1]] as f64;
            let b = self.cl_steps[peaks[w]] as f64;
            if b > a {
                intervals.push(b - a);
            }
        }
        if intervals.len() < 2 {
            return None;
        }
        let m: f64 = intervals.iter().sum::<f64>() / intervals.len() as f64;
        if !(m > 0.0) || !m.is_finite() {
            return None;
        }
        let mut var = 0.0;
        for x in &intervals {
            let d = x - m;
            var += d * d;
        }
        var /= intervals.len() as f64;
        let cv = var.max(0.0).sqrt() / m;
        if cv.is_finite() {
            Some((m, cv))
        } else {
            None
        }
    }

    /// Solve the shared 3x3 Gram system once and the per cell fits.
    /// Validity needs a frozen period, at least 6 frozen periods of
    /// samples, Strouhal in 0.03 to 0.50, explained variance at least
    /// 0.35, RMS amplitude over fluid cells at least 0.002 u_lattice,
    /// and finite coefficients. Any failed gate returns all zero
    /// coefficients with valid false, but explained_variance still
    /// reports the measured value (0 when no period or no samples) so
    /// a weak harmonic stays visible instead of being hidden as 0.
    /// reason is one of ok, no_period, too_few_periods, low_explained,
    /// low_amplitude, non_finite, not_shedding.
    pub fn finalise(&self, solid: &[u8]) -> HarmonicResult {
        let n = self.cells;
        assert!(
            solid.len() == n,
            "harmonic: solid len {} must equal cells {n}",
            solid.len()
        );
        let frozen = self.frozen_period;
        let diag_cv = self.measured_interval_stats().map(|(_, cv)| cv);
        let mut out = HarmonicResult {
            u_cos: vec![0.0; n],
            u_sin: vec![0.0; n],
            v_cos: vec![0.0; n],
            v_sin: vec![0.0; n],
            explained_variance: 0.0,
            valid: false,
            reason: "no_period".to_string(),
            cycles: self.committed_cycles(),
            samples: self.frozen_samples,
            phase_ref_step: self.phase_ref_step,
            mean_peak_interval: self.frozen_period,
            interval_cv: diag_cv,
        };
        let period = match frozen {
            Some(p) if p.is_finite() && p > 0.0 => p,
            _ => {
                let mut lo = f64::INFINITY;
                let mut hi = f64::NEG_INFINITY;
                for v in &self.cl_vals {
                    if *v < lo {
                        lo = *v;
                    }
                    if *v > hi {
                        hi = *v;
                    }
                }
                let range = if lo.is_finite() && hi.is_finite() { hi - lo } else { 0.0 };
                out.reason = if range < 1e-9 {
                    "not_shedding".to_string()
                } else {
                    "no_period".to_string()
                };
                return out;
            }
        };
        let strouhal = match self.frozen_strouhal {
            Some(v) => v,
            None => {
                out.reason = "no_period".to_string();
                return out;
            }
        };
        if !strouhal.is_finite() || strouhal < 0.03 || strouhal > 0.50 {
            out.reason = "no_period".to_string();
            return out;
        }
        let gram_n = self.gram_n as f64;
        if self.frozen_samples == 0 || gram_n < 1.0 {
            out.reason = "too_few_periods".to_string();
            return out;
        }
        let frozen_span = self.frozen_samples as f64 * self.sample_every as f64;
        let too_few = frozen_span < 6.0 * period - 1e-9;
        let sc = self.gram_sc;
        let ss = self.gram_ss;
        let cc = self.gram_cc;
        let cs = self.gram_cs;
        let qq = self.gram_ss2;
        let det = gram_n * (cc * qq - cs * cs)
            - sc * (sc * qq - cs * ss)
            + ss * (sc * cs - cc * ss);
        if !det.is_finite() || !(det > 1e-6 * gram_n * gram_n * gram_n) {
            out.reason = "non_finite".to_string();
            return out;
        }
        let inv01 = (cs * ss - sc * qq) / det;
        let inv02 = (sc * cs - cc * ss) / det;
        let inv11 = (gram_n * qq - ss * ss) / det;
        let inv12 = (ss * sc - gram_n * cs) / det;
        let inv22 = (gram_n * cc - sc * sc) / det;
        if !inv01.is_finite()
            || !inv02.is_finite()
            || !inv11.is_finite()
            || !inv12.is_finite()
            || !inv22.is_finite()
        {
            out.reason = "non_finite".to_string();
            return out;
        }
        let mut au = vec![0.0f64; n];
        let mut bu = vec![0.0f64; n];
        let mut av = vec![0.0f64; n];
        let mut bv = vec![0.0f64; n];
        for k in 0..n {
            if solid[k] != 0 {
                continue;
            }
            let su = self.sum_u[k];
            let suc = self.sum_u_cos[k];
            let sus = self.sum_u_sin[k];
            au[k] = inv01 * su + inv11 * suc + inv12 * sus;
            bu[k] = inv02 * su + inv12 * suc + inv22 * sus;
            let sv = self.sum_v[k];
            let svc = self.sum_v_cos[k];
            let svs = self.sum_v_sin[k];
            av[k] = inv01 * sv + inv11 * svc + inv12 * svs;
            bv[k] = inv02 * sv + inv12 * svc + inv22 * svs;
        }
        for k in 0..n {
            if solid[k] != 0 {
                continue;
            }
            if !au[k].is_finite() || !bu[k].is_finite() || !av[k].is_finite() || !bv[k].is_finite() {
                out.reason = "non_finite".to_string();
                return out;
            }
        }
        let mut num = 0.0;
        let mut den = 0.0;
        let mut sum_sq = 0.0;
        let mut fluid = 0u64;
        for k in 0..n {
            if solid[k] != 0 {
                continue;
            }
            fluid += 1;
            let mu = self.sum_u[k] / gram_n;
            let mv = self.sum_v[k] / gram_n;
            let var_u = (self.sum_u2[k] / gram_n - mu * mu).max(0.0);
            let var_v = (self.sum_v2[k] / gram_n - mv * mv).max(0.0);
            num += (au[k] * au[k] + bu[k] * bu[k] + av[k] * av[k] + bv[k] * bv[k]) / 4.0;
            den += (var_u + var_v) / 2.0;
            sum_sq += au[k] * au[k] + bu[k] * bu[k] + av[k] * av[k] + bv[k] * bv[k];
        }
        let explained = if den <= 1e-12 {
            0.0
        } else {
            (num / den).clamp(0.0, 1.0)
        };
        let explained = if explained.is_finite() { explained } else { 0.0 };
        out.explained_variance = explained;
        if too_few {
            out.reason = "too_few_periods".to_string();
            return out;
        }
        if explained < 0.35 {
            out.reason = "low_explained".to_string();
            return out;
        }
        let rms_amp = if fluid == 0 {
            0.0
        } else {
            (sum_sq / (2.0 * fluid as f64)).max(0.0).sqrt()
        };
        if !rms_amp.is_finite() {
            out.reason = "non_finite".to_string();
            return out;
        }
        if rms_amp < 0.002 * self.cfg.u_lattice {
            out.reason = "low_amplitude".to_string();
            return out;
        }
        for k in 0..n {
            if solid[k] != 0 {
                out.u_cos[k] = 0.0;
                out.u_sin[k] = 0.0;
                out.v_cos[k] = 0.0;
                out.v_sin[k] = 0.0;
                continue;
            }
            out.u_cos[k] = au[k] as f32;
            out.u_sin[k] = bu[k] as f32;
            out.v_cos[k] = av[k] as f32;
            out.v_sin[k] = bv[k] as f32;
        }
        out.explained_variance = explained;
        out.valid = true;
        out.reason = "ok".to_string();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finalise_matches_exact_formulas() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let rho = vec![1.0f32; n];
        let u = vec![0.1f32; n];
        let v = vec![0.0f32; n];
        let solid = vec![0u8; n];
        acc.sample(0, &rho, &u, &v, &solid);
        acc.sample(1, &rho, &u, &v, &solid);
        let fin = acc.finalise().unwrap();
        assert_eq!(fin.samples, 2);
        assert!((fin.mean_u[0] as f64 - 0.1).abs() < 1e-6);
        assert!(fin.rms_u[0] as f64 >= 0.0);
        assert!((fin.rms_u[0] as f64) < 1e-6);
        assert_eq!(fin.tke[0], 0.0);
        assert_eq!(fin.recirc_mask[0], 0.0);
    }

    #[test]
    fn variance_floor_prevents_nan() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let rho = vec![1.0f32; n];
        let u = vec![0.1f32; n];
        let v = vec![0.0f32; n];
        let solid = vec![0u8; n];
        acc.sample(0, &rho, &u, &v, &solid);
        let fin = acc.finalise().unwrap();
        assert!(fin.rms_u[0].is_finite());
        assert!(fin.tke[0].is_finite());
    }

    #[test]
    fn zero_samples_is_an_error() {
        let acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        assert!(acc.finalise().is_err());
    }

    #[test]
    fn grid_caps_match_solver() {
        assert!(StatsAccumulator::new(513, 8, 0, 1).is_err());
        assert!(StatsAccumulator::new(8, 513, 0, 1).is_err());
        assert!(StatsAccumulator::new(1024, 1024, 0, 1).is_err());
        assert!(StatsAccumulator::new(512, 512, 0, 1).is_ok());
    }

    #[test]
    #[should_panic(expected = "stats: rho len")]
    fn sample_panics_on_short_rho() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let short = vec![1.0f32; 15];
        let full = vec![0.0f32; 16];
        let solid = vec![0u8; 16];
        acc.sample(0, &short, &full, &full, &solid);
    }

    #[test]
    #[should_panic(expected = "stats: solid len")]
    fn sample_panics_on_short_solid() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let full = vec![1.0f32; 16];
        let short = vec![0u8; 4];
        acc.sample(0, &full, &full, &full, &short);
    }

    #[test]
    fn solid_cells_contribute_nothing() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let rho = vec![1.0f32; n];
        let u = vec![0.1f32; n];
        let v = vec![0.0f32; n];
        let mut solid = vec![0u8; n];
        for s in solid.iter_mut() {
            *s = 1;
        }
        acc.sample(0, &rho, &u, &v, &solid);
        let fin = acc.finalise().unwrap();
        assert_eq!(fin.mean_u[0], 0.0);
        assert_eq!(fin.recirc_mask[0], 0.0);
    }

    #[test]
    fn recirculation_flags_negative_mean() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let rho = vec![1.0f32; n];
        let u = vec![-0.05f32; n];
        let v = vec![0.0f32; n];
        let solid = vec![0u8; n];
        acc.sample(0, &rho, &u, &v, &solid);
        let fin = acc.finalise().unwrap();
        assert_eq!(fin.recirc_mask[0], 1.0);
        assert!((fin.recirc_fraction[0] - 1.0).abs() < 1e-6);
    }

    #[test]
    fn finalise_two_sample_hand_computed() {
        // Two samples, hand computed means, variances, pressure, recirc.
        // Cell 0: u 0.1, 0.3 gives mean 0.2, var 0.01, rms 0.1;
        // v 0.0, 0.2 gives mean 0.1, var 0.01, rms 0.1; tke 0.01.
        // rho 1.0, 1.06 gives gauge p 0.0, 0.02, mean 0.01.
        // Cell 1: u -0.1, 0.1 gives mean 0.0, var 0.01, fraction 0.5, mask 0.
        // Cell 2: u -0.1, -0.2 gives mean -0.15, var 0.0025, rms 0.05,
        // fraction 1.0, mask 1.
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let solid = vec![0u8; n];
        let mut rho0 = vec![1.0f32; n];
        let mut u0 = vec![0.0f32; n];
        let mut v0 = vec![0.0f32; n];
        rho0[0] = 1.0;
        u0[0] = 0.1;
        v0[0] = 0.0;
        u0[1] = -0.1;
        u0[2] = -0.1;
        let mut rho1 = vec![1.0f32; n];
        let mut u1 = vec![0.0f32; n];
        let mut v1 = vec![0.0f32; n];
        rho1[0] = 1.06;
        u1[0] = 0.3;
        v1[0] = 0.2;
        u1[1] = 0.1;
        u1[2] = -0.2;
        acc.sample(0, &rho0, &u0, &v0, &solid);
        acc.sample(1, &rho1, &u1, &v1, &solid);
        let fin = acc.finalise().unwrap();
        assert_eq!(fin.samples, 2);
        assert!((fin.mean_u[0] as f64 - 0.2).abs() < 1e-6);
        assert!((fin.mean_v[0] as f64 - 0.1).abs() < 1e-6);
        assert!((fin.rms_u[0] as f64 - 0.1).abs() < 1e-6);
        assert!((fin.rms_v[0] as f64 - 0.1).abs() < 1e-6);
        assert!((fin.tke[0] as f64 - 0.01).abs() < 1e-6);
        assert!((fin.mean_p[0] as f64 - 0.01).abs() < 1e-6);
        assert!((fin.recirc_fraction[0] as f64).abs() < 1e-6);
        assert_eq!(fin.recirc_mask[0], 0.0);
        assert!((fin.mean_u[1] as f64).abs() < 1e-6);
        assert!((fin.recirc_fraction[1] as f64 - 0.5).abs() < 1e-6);
        assert_eq!(fin.recirc_mask[1], 0.0);
        assert!((fin.mean_u[2] as f64 + 0.15).abs() < 1e-6);
        assert!((fin.rms_u[2] as f64 - 0.05).abs() < 1e-6);
        assert!((fin.recirc_fraction[2] as f64 - 1.0).abs() < 1e-6);
        assert_eq!(fin.recirc_mask[2], 1.0);
    }

    #[test]
    fn full_export_carries_mean_p_channel() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let solid = vec![0u8; n];
        let mut rho0 = vec![1.0f32; n];
        let mut u0 = vec![0.0f32; n];
        let mut v0 = vec![0.0f32; n];
        rho0[0] = 1.0;
        u0[0] = 0.1;
        let mut rho1 = vec![1.0f32; n];
        let mut u1 = vec![0.0f32; n];
        let mut v1 = vec![0.0f32; n];
        rho1[0] = 1.06;
        u1[0] = 0.3;
        v1[0] = 0.2;
        let _ = v0;
        acc.sample(0, &rho0, &u0, &v0, &solid);
        acc.sample(1, &rho1, &u1, &v1, &solid);
        let (_mu, _mv, mp, _k, _w, _m) = acc.fields_or_zeros_full(&solid, 4, 4, 0.02, 0.02);
        assert!((mp[0] as f64 - 0.01).abs() < 1e-6, "mean_p = {}", mp[0]);
    }

    #[test]
    fn full_export_omega_matches_shear() {
        // Solid body rotation style shear: u = a*y gives omega = -a.
        let nx = 8usize;
        let ny = 8usize;
        let n = nx * ny;
        let dx = 0.02;
        let dy = 0.02;
        let solid = vec![0u8; n];
        let mut mu = vec![0.0f32; n];
        let mv = vec![0.0f32; n];
        for j in 0..ny {
            for i in 0..nx {
                mu[j * nx + i] = (j as f32) * (dx as f32) * 2.0;
            }
        }
        let w = vorticity_from_means(&mu, &mv, &solid, nx, ny, dx, dy);
        assert_eq!(w.len(), n);
        // Interior cells see the exact shear, edges use one sided stencils
        // with the same spacing, so the whole field reads -2 within float
        // tolerance.
        for j in 1..(ny - 1) {
            for i in 1..(nx - 1) {
                let k = j * nx + i;
                assert!((w[k] as f64 + 2.0).abs() < 1e-4, "w = {} at {k}", w[k]);
            }
        }
    }

    #[test]
    fn full_export_solid_zero_and_zero_sample_zeros() {
        let mut acc = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let n = 16;
        let rho = vec![1.1f32; n];
        let u = vec![0.2f32; n];
        let v = vec![0.1f32; n];
        let mut solid = vec![0u8; n];
        solid[0] = 1;
        solid[5] = 1;
        acc.sample(0, &rho, &u, &v, &solid);
        let (mu, mv, mp, k, w, m) = acc.fields_or_zeros_full(&solid, 4, 4, 0.02, 0.02);
        for kdx in [0, 5] {
            assert_eq!(mu[kdx], 0.0);
            assert_eq!(mv[kdx], 0.0);
            assert_eq!(mp[kdx], 0.0);
            assert_eq!(k[kdx], 0.0);
            assert_eq!(w[kdx], 0.0);
            assert_eq!(m[kdx], 0.0);
        }
        assert!(mu[1].is_finite());
        assert!(w[1].is_finite());
        let fresh = StatsAccumulator::new(4, 4, 0, 1).unwrap();
        let (a, b, c, d, e, f) = fresh.fields_or_zeros_full(&solid, 4, 4, 0.02, 0.02);
        for arr in [&a, &b, &c, &d, &e, &f] {
            assert_eq!(arr.len(), n);
            for val in arr {
                assert_eq!(*val, 0.0);
            }
        }
    }

    fn harmonic_test_setup() -> (HarmonicConfig, usize, usize, f64) {
        // Strouhal 0.2 with D 16 and u 0.08 gives period 1000 steps,
        // inside the physical bounds 400 to 6666.
        let cfg = HarmonicConfig {
            d_lat: 16.0,
            u_lattice: 0.08,
            skip_cycles: 2,
            min_cycles: 3,
        };
        (cfg, 8, 8, 1000.0)
    }

    fn feed_harmonic_sine(
        acc: &mut HarmonicAccumulator,
        period: f64,
        steps: u64,
        amp_u: f64,
        amp_v: f64,
        phase_u: f64,
        phase_v: f64,
        amp_scale: impl Fn(u64) -> f64,
    ) {
        let nx = 8usize;
        let cells = nx * 8;
        let solid = vec![0u8; cells];
        let mean_u = 0.06;
        let mean_v = 0.005;
        for t in 0..=steps {
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            acc.note_cl(t, cl);
            if t % 10 != 0 {
                continue;
            }
            let scale = amp_scale(t);
            // Phase uses absolute lattice steps so the anchored fit
            // with anchor at the global Cl maximum recovers it.
            let phi = 2.0 * std::f64::consts::PI * t as f64 / period;
            let uval = (mean_u + scale * amp_u * (phi + phase_u).cos()) as f32;
            let vval = (mean_v + scale * amp_v * (phi + phase_v).cos()) as f32;
            let u = vec![uval; cells];
            let v = vec![vval; cells];
            acc.sample(t, &u, &v, &solid);
        }
    }

    fn feed_harmonic_noisy_cl(
        acc: &mut HarmonicAccumulator,
        period: f64,
        steps: u64,
        amp_u: f64,
        amp_v: f64,
        phase_u: f64,
        phase_v: f64,
    ) {
        // Deterministic uniform jitter at 20 percent of the 0.5 Cl
        // amplitude, modelling LES broadband noise. Spurious local
        // maxima abound, but they average out of the shared Strouhal
        // estimate instead of corrupting per cycle peak gating.
        let nx = 8usize;
        let cells = nx * 8;
        let solid = vec![0u8; cells];
        let mean_u = 0.06;
        let mean_v = 0.005;
        let mut rng: u64 = 0x12345678;
        for t in 0..=steps {
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let noise = ((rng >> 33) as f64 / (u32::MAX as f64) - 0.5) * 0.2;
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos() + noise;
            acc.note_cl(t, cl);
            if t % 10 != 0 {
                continue;
            }
            let phi = 2.0 * std::f64::consts::PI * t as f64 / period;
            let uval = (mean_u + amp_u * (phi + phase_u).cos()) as f32;
            let vval = (mean_v + amp_v * (phi + phase_v).cos()) as f32;
            let u = vec![uval; cells];
            let v = vec![vval; cells];
            acc.sample(t, &u, &v, &solid);
        }
    }

    #[test]
    fn harmonic_recovers_synthetic_first_mode() {
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let amp_u = 0.03;
        let amp_v = 0.02;
        let phase_u = 0.3;
        let phase_v = -0.5;
        feed_harmonic_sine(&mut acc, period, 9100, amp_u, amp_v, phase_u, phase_v, |_| 1.0);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "expected valid fit, reason {}", res.reason);
        assert_eq!(res.reason, "ok");
        assert_eq!(res.samples, 610, "samples = {}", res.samples);
        assert_eq!(res.cycles, 6);
        assert_eq!(res.phase_ref_step, Some(0));
        assert_eq!(res.mean_peak_interval, Some(1000.0));
        assert!(res.explained_variance > 0.99, "explained = {}", res.explained_variance);
        let exp_au = amp_u * phase_u.cos();
        let exp_bu = -amp_u * phase_u.sin();
        let exp_av = amp_v * phase_v.cos();
        let exp_bv = -amp_v * phase_v.sin();
        for k in [0, 7, 32, 63] {
            assert!((res.u_cos[k] as f64 - exp_au).abs() < 0.001, "u_cos {k} = {}", res.u_cos[k]);
            assert!((res.u_sin[k] as f64 - exp_bu).abs() < 0.001, "u_sin {k} = {}", res.u_sin[k]);
            assert!((res.v_cos[k] as f64 - exp_av).abs() < 0.001, "v_cos {k} = {}", res.v_cos[k]);
            assert!((res.v_sin[k] as f64 - exp_bv).abs() < 0.001, "v_sin {k} = {}", res.v_sin[k]);
        }
    }

    #[test]
    fn harmonic_noisy_cl_still_recovers_period() {
        // 20 percent additive noise on Cl: spurious peaks no longer
        // matter because the period comes from the shared Strouhal
        // estimator, not per cycle peak gating.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        feed_harmonic_noisy_cl(&mut acc, period, 9100, 0.03, 0.02, 0.3, -0.5);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "noisy Cl must stay valid, reason {}", res.reason);
        assert_eq!(res.reason, "ok");
        assert!(res.explained_variance > 0.9, "explained = {}", res.explained_variance);
    }

    #[test]
    fn harmonic_steady_signal_is_invalid_zeros() {
        let (cfg, nx, ny, _period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let cells = nx * ny;
        let solid = vec![0u8; cells];
        let u = vec![0.06f32; cells];
        let v = vec![0.0f32; cells];
        for t in 0..=4000u64 {
            acc.note_cl(t, 0.5);
            acc.sample(t, &u, &v, &solid);
        }
        let res = acc.finalise(&solid);
        assert!(!res.valid);
        assert!(res.reason == "no_period" || res.reason == "not_shedding", "reason = {}", res.reason);
        assert_eq!(res.explained_variance, 0.0);
        for arr in [&res.u_cos, &res.u_sin, &res.v_cos, &res.v_sin] {
            assert_eq!(arr.len(), cells);
            for val in arr {
                assert_eq!(*val, 0.0);
            }
        }
    }

    #[test]
    fn harmonic_too_few_periods_reports_reason() {
        // Freeze happens near step 2000, 4600 steps hold about 2.6
        // frozen periods, below the 6 period floor.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        feed_harmonic_sine(&mut acc, period, 4600, 0.03, 0.02, 0.3, -0.5, |_| 1.0);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(!res.valid, "short run must be invalid");
        assert_eq!(res.reason, "too_few_periods");
        for arr in [&res.u_cos, &res.u_sin, &res.v_cos, &res.v_sin] {
            for val in arr {
                assert_eq!(*val, 0.0);
            }
        }
    }

    #[test]
    fn harmonic_low_explained_keeps_variance_visible() {
        // Strong Cl at period 1000 but the field oscillates at period
        // 640, so the locked fit explains little variance. Bins stay
        // exact zero but explained_variance reports the weak harmonic.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let cells = nx * ny;
        let solid = vec![0u8; cells];
        let wrong = 640.0;
        for t in 0..=9100u64 {
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            acc.note_cl(t, cl);
            if t % 10 != 0 {
                continue;
            }
            let phi = 2.0 * std::f64::consts::PI * t as f64 / wrong;
            let uval = (0.06 + 0.03 * phi.cos()) as f32;
            let vval = (0.005 + 0.02 * phi.cos()) as f32;
            acc.sample(t, &vec![uval; cells], &vec![vval; cells], &solid);
        }
        let res = acc.finalise(&solid);
        assert!(!res.valid, "wrong frequency must be invalid");
        assert_eq!(res.reason, "low_explained");
        assert!(res.explained_variance > 0.0, "explained = {}", res.explained_variance);
        assert!(res.explained_variance < 0.35, "explained = {}", res.explained_variance);
        for arr in [&res.u_cos, &res.u_sin, &res.v_cos, &res.v_sin] {
            for val in arr {
                assert_eq!(*val, 0.0);
            }
        }
    }

    #[test]
    fn harmonic_prefreeze_amplitude_ignored() {
        // Double amplitude only before the freeze (first two periods)
        // is discarded with the pre freeze samples, so the fit still
        // recovers unit amplitude.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let amp_u = 0.03;
        let amp_v = 0.02;
        feed_harmonic_sine(&mut acc, period, 9100, amp_u, amp_v, 0.3, -0.5, |t| {
            if t < 2000 {
                2.0
            } else {
                1.0
            }
        });
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "reason = {}", res.reason);
        let exp_au = amp_u * 0.3f64.cos();
        let exp_bu = -amp_u * 0.3f64.sin();
        assert!((res.u_cos[0] as f64 - exp_au).abs() < 0.001, "u_cos = {}", res.u_cos[0]);
        assert!((res.u_sin[0] as f64 - exp_bu).abs() < 0.001, "u_sin = {}", res.u_sin[0]);
    }
}
