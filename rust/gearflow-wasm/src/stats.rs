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
/// u_lattice set the physical Strouhal bounds 0.03 to 0.50 applied when
/// the measurement closes. skip_cycles is retained for API
/// compatibility and unused; min_cycles sets how many shedding periods
/// the dedicated fitting window must span.
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
            min_cycles: 4,
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
    /// Anchor step of phase zero: the Cl maximum of the fit window
    /// reduced modulo the period into the stats window, so it stays
    /// inside [transient, transient + window]. None when no fit ran.
    pub phase_ref_step: Option<u64>,
    pub mean_peak_interval: Option<f64>,
    pub interval_cv: Option<f64>,
    /// Fit-window mean turbulent kinetic energy over fluid cells: the
    /// mean of (var_u + var_v) / 2 over the fit window, the denominator
    /// of explained_variance. The fit-window counterpart of the
    /// shipped tke bin (which covers the stats window), so the two are
    /// directly comparable. 0.0 when no fit ran.
    pub harmonic_tke: f64,
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
            harmonic_tke: 0.0,
        }
    }
}

/// Strouhal locked least squares fit of u(t) = m + a cos(phi) + b sin(phi)
/// per fluid cell, same for v, with phi = 2 pi (t minus window start)
/// divided by the measured period. The run has three phases. Phase M
/// (measure): from start_step to the end of the main stats window the
/// accumulator only records Cl history via note_cl and sample stores
/// nothing, because the period is still unknown. Phase T (close): the
/// caller ends the main window and calls close_measurement, which
/// estimates Strouhal from the FULL Cl history with the shared
/// estimator in forces.rs (strouhal_from_cl), applies the robustness
/// guards, and resets every sum plus the Cl history so the fit and its
/// diagnostics describe only the new window. It returns the extra step
/// count H the caller must run. Phase D (fit): while the caller runs
/// those H extra steps sample accumulates on the existing stats cadence
/// re-anchored at the window start. Spurious LES peaks cannot corrupt
/// the fit because no per cycle peak gating exists. All internal sums
/// are f64. finalise rotates the fitted coefficients so phase zero sits
/// on the Cl maximum inside the fitting window.
#[derive(Clone, Debug)]
pub struct HarmonicAccumulator {
    cfg: HarmonicConfig,
    start_step: u64,
    sample_every: u64,
    cells: usize,
    cl_steps: Vec<u64>,
    cl_vals: Vec<f64>,
    closed: bool,
    close_reason: Option<String>,
    extra_steps: u64,
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
        if sample_every > 100000 {
            return Err("harmonic: sample_every must be <= 100000".to_string());
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
            closed: false,
            close_reason: None,
            extra_steps: 0,
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

    /// Clear every sum, Cl history, the measurement state, and the
    /// frozen period. Keeps config, grid, start step, and cadence.
    pub fn reset(&mut self) {
        self.cl_steps.clear();
        self.cl_vals.clear();
        self.closed = false;
        self.close_reason = None;
        self.extra_steps = 0;
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

    /// True once close_measurement has run, even when the guards failed
    /// and no fitting window was opened.
    pub fn measurement_closed(&self) -> bool {
        self.closed
    }

    /// Extra step count H returned by close_measurement. Zero before
    /// the close and when the guards failed.
    pub fn extra_steps(&self) -> u64 {
        self.extra_steps
    }

    /// Start of the dedicated fitting window, None before a successful
    /// close. The fit phase reference and the sampling cadence anchor.
    pub fn window_start(&self) -> Option<u64> {
        self.freeze_step
    }

    /// Record a failed close with the given reason and no extra steps.
    fn close_failed(&mut self, reason: &str) -> u64 {
        self.close_reason = Some(reason.to_string());
        self.extra_steps = 0;
        0
    }

    /// Env gated diagnostic for the harmonic close guards. Silent when
    /// unset or empty. Value "1" or "true" prints one stderr line with
    /// the history length, Cl range, peak count, mean interval, interval
    /// CV, full and trimmed Strouhal, relative period disagreement, and
    /// the guard name, and dumps nothing. Any other non-empty value
    /// prints the same line and also dumps the Cl series as
    /// `step value` lines to that path, but only when the value
    /// contains a directory separator, so a bare token like "0",
    /// "false", or "yes" can never create or truncate a file in the
    /// working directory. A failed dump reports one extra stderr line.
    /// Never changes the close decision, the manifest schema, or
    /// HarmonicResult.
    fn emit_close_diag(
        &self,
        close_step: u64,
        guard: &str,
        st_full: Option<f64>,
        st_trim: Option<f64>,
    ) {
        let dest = match std::env::var("GEARFLOW_DIAG_HARMONIC") {
            Ok(v) => v,
            Err(_) => return,
        };
        let path = dest.trim().to_string();
        if path.is_empty() {
            return;
        }
        let hist = self.cl_vals.len();
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
        if !lo.is_finite() {
            lo = f64::NAN;
        }
        if !hi.is_finite() {
            hi = f64::NAN;
        }
        let peaks = self.peak_indices().len();
        let (mean_iv, cv) = match self.measured_interval_stats() {
            Some((m, c, _)) => (m, c),
            None => (f64::NAN, f64::NAN),
        };
        let sf = st_full.unwrap_or(f64::NAN);
        let st = st_trim.unwrap_or(f64::NAN);
        let pf = if sf.is_finite() && sf != 0.0 {
            self.cfg.d_lat / (sf * self.cfg.u_lattice)
        } else {
            f64::NAN
        };
        let pt = if st.is_finite() && st != 0.0 {
            self.cfg.d_lat / (st * self.cfg.u_lattice)
        } else {
            f64::NAN
        };
        let rel = if pf.is_finite() && pt.is_finite() && pf != 0.0 {
            ((pf - pt) / pf).abs()
        } else {
            f64::NAN
        };
        eprintln!(
            "gearflow_diag_harmonic close_step={} guard={} hist={} cl_min={} cl_max={} peaks={} mean_interval={} interval_cv={} st_full={} st_trim={} rel_disagree={}",
            close_step, guard, hist, lo, hi, peaks, mean_iv, cv, sf, st, rel
        );
        let path = dest.trim().to_string();
        if path.is_empty() {
            return;
        }
        let dump = path != "1"
            && path != "true"
            && path.contains(std::path::MAIN_SEPARATOR);
        if !dump {
            return;
        }
        let mut buf = String::new();
        buf.reserve(hist.saturating_mul(32));
        for i in 0..hist {
            let s = self.cl_steps.get(i).copied().unwrap_or(0);
            let v = self.cl_vals.get(i).copied().unwrap_or(f64::NAN);
            buf.push_str(&format!("{} {}\n", s, v));
        }
        if let Some(parent) = std::path::Path::new(&path).parent() {
            if !parent.as_os_str().is_empty() {
                let _ = std::fs::create_dir_all(parent);
            }
        }
        if let Err(e) = std::fs::write(&path, buf) {
            eprintln!("gearflow_diag_harmonic: cl dump to {} failed: {}", path, e);
        }
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

    /// Frozen shedding period in steps, None before the close.
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

    /// Sample one step when due on the stats cadence re-anchored at the
    /// fitting window start. Solid cells contribute nothing. During the
    /// measurement phase this stores nothing: the period is unknown, so
    /// any accumulation would be wasted. After a successful close it
    /// accumulates into the fitting window from the window start
    /// onward. Panics on a slice length mismatch like the stats
    /// accumulator.
    pub fn sample(&mut self, step: u64, u: &[f32], v: &[f32], solid: &[u8]) {
        if step < self.start_step {
            return;
        }
        let n = self.cells;
        assert!(u.len() == n, "harmonic: u len {} must equal cells {n}", u.len());
        assert!(v.len() == n, "harmonic: v len {} must equal cells {n}", v.len());
        assert!(solid.len() == n, "harmonic: solid len {} must equal cells {n}", solid.len());
        if !self.closed {
            return;
        }
        let (period, anchor, origin) = match (self.frozen_period, self.anchor_step, self.freeze_step) {
            (Some(p), Some(a), Some(o)) if p.is_finite() && p > 0.0 => (p, a, o),
            _ => return,
        };
        if step < origin {
            return;
        }
        if (step - origin) % self.sample_every != 0 {
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

    /// Close the measurement phase at the end of the main stats window
    /// and open the dedicated fitting window. Estimates Strouhal from
    /// the FULL Cl history with the shared estimator, inside the same
    /// 0.03 to 0.50 bounds. Robustness guards: at least 4 peaks with
    /// interval coefficient of variation at most 0.12, so a spurious
    /// crest cannot steer the fit, and the estimate that also drops the
    /// last min_sep steps must agree within 4 percent, so a trailing
    /// partial crest cannot steer it. Both guards relax as history
    /// grows: one outlier inflates the CV and the window disagreement
    /// by about one over the peak count. On success computes
    /// P = d_lat / (St * u_lattice), takes N = 6 periods when
    /// 6P <= 12000 else N = floor(12000 / P), requires N >= 4, and
    /// returns H = ceil(N * P / sample_every) * sample_every capped at
    /// 12000 + sample_every. Rounding up, never down, makes the
    /// recorded cycle count come out at N. Every sum, the gram
    /// accumulators, and frozen_samples reset, the Cl history clears so
    /// diagnostics describe the fitting window only, and the fit phase
    /// reference records step. On any guard failure marks done with
    /// not_shedding when the Cl range is negligible else no_period (or
    /// too_few_periods when N < 4) and returns 0. Idempotent: a second
    /// call returns the stored extra count.
    pub fn close_measurement(&mut self, step: u64) -> u64 {
        if self.closed {
            return self.extra_steps;
        }
        self.closed = true;
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
        let negligible = range < 1e-9;
        if self.cl_vals.len() < 16 {
            self.emit_close_diag(step, "hist_short", None, None);
            return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
        }
        let st_full = match crate::forces::strouhal_from_cl(
            &self.cl_vals,
            self.cfg.d_lat,
            self.cfg.u_lattice,
        ) {
            Ok(v) => v,
            Err(_) => {
                self.emit_close_diag(step, "st_full_err", None, None);
                return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
            }
        };
        if !st_full.is_finite() || st_full < 0.03 || st_full > 0.50 {
            self.emit_close_diag(step, "st_full_bounds", Some(st_full), None);
            return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
        }
        let period = self.cfg.d_lat / (st_full * self.cfg.u_lattice);
        if !period.is_finite() || period <= 0.0 {
            self.emit_close_diag(step, "period_nonfinite", Some(st_full), None);
            return self.close_failed("no_period");
        }
        // Interval consistency on the full history: at least 4 peaks
        // with CV at most 0.12. A spurious crest inflates the spread
        // and blocks the close until dilution makes its bias harmless.
        if self.peak_indices().len() < 4 {
            self.emit_close_diag(step, "few_peaks", Some(st_full), None);
            return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
        }
        let cv = match self.measured_interval_stats() {
            Some((_, cv, _)) => cv,
            None => {
                self.emit_close_diag(step, "interval_stats_none", Some(st_full), None);
                return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
            }
        };
        if !cv.is_finite() || cv > 0.12 {
            self.emit_close_diag(step, "cv_high", Some(st_full), None);
            return self.close_failed(if negligible { "not_shedding" } else { "no_period" });
        }
        // Same minimum peak separation as forces::strouhal_from_cl: a
        // peak within this distance of the history end is unconfirmed
        // and must not steer the close.
        let edge = (0.5 * self.cfg.d_lat / (0.2 * self.cfg.u_lattice)).round() as u64;
        let edge = edge.max(4);
        let mut b0 = self.cl_vals.len();
        let back_edge = step.saturating_sub(edge);
        while b0 > 0 && self.cl_steps[b0 - 1] > back_edge {
            b0 -= 1;
        }
        if b0 < 16 {
            self.emit_close_diag(step, "trim_short", Some(st_full), None);
            return self.close_failed("no_period");
        }
        let confirmed = &self.cl_vals[..b0];
        let st_trim = match crate::forces::strouhal_from_cl(
            confirmed,
            self.cfg.d_lat,
            self.cfg.u_lattice,
        ) {
            Ok(v) => v,
            Err(_) => {
                self.emit_close_diag(step, "st_trim_err", Some(st_full), None);
                return self.close_failed("no_period");
            }
        };
        if !st_trim.is_finite() {
            self.emit_close_diag(step, "st_trim_nonfinite", Some(st_full), Some(st_trim));
            return self.close_failed("no_period");
        }
        let period_trim = self.cfg.d_lat / (st_trim * self.cfg.u_lattice);
        if !period_trim.is_finite() || period_trim <= 0.0 {
            self.emit_close_diag(step, "period_trim_nonfinite", Some(st_full), Some(st_trim));
            return self.close_failed("no_period");
        }
        if ((period - period_trim) / period).abs() > 0.04 {
            self.emit_close_diag(step, "period_disagree", Some(st_full), Some(st_trim));
            return self.close_failed("no_period");
        }
        let n_periods = if 6.0 * period <= 12000.0 {
            6
        } else {
            (12000.0 / period).floor() as u64
        };
        if n_periods < 4 {
            self.emit_close_diag(step, "too_few_periods", Some(st_full), Some(st_trim));
            return self.close_failed("too_few_periods");
        }
        let se = self.sample_every;
        let windows = (n_periods as f64 * period / se as f64).ceil().max(0.0) as u64;
        let h = windows.saturating_mul(se);
        let h = h.min(12000u64.saturating_add(se));
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
        self.frozen_samples = 0;
        self.emit_close_diag(step, "ok", Some(st_full), Some(st_trim));
        self.cl_steps.clear();
        self.cl_vals.clear();
        self.frozen_period = Some(period);
        self.frozen_strouhal = Some(st_full);
        self.anchor_step = Some(step);
        self.freeze_step = Some(step);
        self.phase_ref_step = None;
        self.extra_steps = h;
        h
    }

    /// Peak indices into the stored Cl history, using the same peak
    /// rule as forces::strouhal_from_cl. Shared by the close guards and
    /// the interval diagnostics.
    fn peak_indices(&self) -> Vec<usize> {
        let n = self.cl_vals.len();
        if n < 16 {
            return Vec::new();
        }
        let mean: f64 = self.cl_vals.iter().sum::<f64>() / n as f64;
        let mut detrended = Vec::with_capacity(n);
        for v in &self.cl_vals {
            detrended.push(v - mean);
        }
        let rms = (detrended.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
        if !(rms > 0.0) || !rms.is_finite() {
            return Vec::new();
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
        peaks
    }

    /// Rotation that moves phase zero from the window start to the Cl
    /// maximum inside the fitting window, reported wrapped into the
    /// stats window. Returns (theta, wrapped): theta is the unwrapped
    /// 2 pi (step_max minus window start) / period, identical to
    /// before, so the rotated coefficients are unchanged; wrapped is
    /// start_step plus the remainder of (step_max minus start_step)
    /// modulo the period, so it lands in
    /// [start_step, start_step + period) on a congruent crest and only
    /// the recorded step changes. Falls back to start_step for the
    /// report when the crest precedes it or the remainder is not
    /// finite non-negative. None when no window is open, the fit
    /// window holds no Cl history, or the period is not finite
    /// positive, in which case finalise keeps the window start frame.
    fn fit_peak_theta(&self, period: f64) -> Option<(f64, u64)> {
        let anchor = self.anchor_step?;
        if self.cl_vals.is_empty() {
            return None;
        }
        if !(period.is_finite() && period > 0.0) {
            return None;
        }
        let mut best = 0usize;
        for i in 1..self.cl_vals.len() {
            if self.cl_vals[i] > self.cl_vals[best] {
                best = i;
            }
        }
        let step_max = self.cl_steps[best];
        let theta =
            2.0 * std::f64::consts::PI * step_max.saturating_sub(anchor) as f64 / period;
        if !theta.is_finite() {
            return None;
        }
        let start = self.start_step;
        let wrapped = if step_max >= start {
            let rem = (step_max - start) as f64 % period;
            if rem.is_finite() && rem >= 0.0 {
                start.saturating_add(rem as u64)
            } else {
                start
            }
        } else {
            start
        };
        Some((theta, wrapped))
    }

    /// Measured peak intervals in steps from the stored Cl history,
    /// using the same peak rule as forces::strouhal_from_cl, with two
    /// missed crest repairs before the spread is measured. One missed
    /// crest in a long window is normal LES amplitude modulation at
    /// Reynolds numbers above 500, and it takes two shapes. A single
    /// interval near an integer multiple of the median means crests
    /// were never detected inside it, so splitting it into
    /// k = round(x / median) equal parts restores the missing periods:
    /// sum preserved, count rises by k minus one. An adjacent short
    /// and long pair summing near twice the median means the boundary
    /// between two real periods was misplaced, so replacing both
    /// members with half their sum restores both values: sum preserved
    /// and count unchanged, so the mean is untouched and only the CV
    /// drops. A pair is only repairable when its sum is within 10
    /// percent of twice the median and at least one member deviates
    /// from the median by more than 25 percent; two nominal intervals
    /// always sum near twice the median, so the anomaly condition is
    /// what distinguishes a misplaced boundary from ordinary
    /// cycle-to-cycle variation. The walk evaluates the fixed
    /// non-overlapping partition stepping by two from the left, so
    /// pair boundaries sit at even indices, and the rarity cap counts
    /// the repairable pairs first: the repair applies only when that
    /// count is at most max(1, intervals.len() / 7). A single
    /// misplaced boundary in a long window is repaired, while a global
    /// alternating rhythm such as period doubling has every pair
    /// anomaly bearing, exceeds the cap, and is left alone so the CV
    /// gate still rejects it. No blanket claim is made for other aperiodic wakes: an irregularity rare enough to pass the
    /// cap still relies on the downstream explained-variance gate.
    /// Returns (mean, coefficient of variation, peak count). Gates the
    /// close decision and reports the diagnostic CV, never gates
    /// validity.
    fn measured_interval_stats(&self) -> Option<(f64, f64, usize)> {
        let peaks = self.peak_indices();
        if peaks.len() < 3 {
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
        let mut sorted = intervals.clone();
        sorted.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
        let median = if sorted.len() % 2 == 1 {
            sorted[sorted.len() / 2]
        } else {
            0.5 * (sorted[sorted.len() / 2 - 1] + sorted[sorted.len() / 2])
        };
        if !(median > 0.0) || !median.is_finite() {
            return None;
        }
        let mut repaired: Vec<f64> = Vec::with_capacity(intervals.len() + 2);
        for x in &intervals {
            if *x > 1.6 * median {
                let k = (*x / median).round() as usize;
                let k = k.max(2);
                for _ in 0..k {
                    repaired.push(*x / k as f64);
                }
            } else {
                repaired.push(*x);
            }
        }
        let twice = 2.0 * median;
        let mut hits: Vec<usize> = Vec::new();
        let mut i = 0;
        while i + 1 < repaired.len() {
            let pair = repaired[i] + repaired[i + 1];
            let in_band = ((pair - twice) / twice).abs() <= 0.10;
            let anomalous = ((repaired[i] - median) / median).abs() > 0.25
                || ((repaired[i + 1] - median) / median).abs() > 0.25;
            if in_band && anomalous {
                hits.push(i);
            }
            i += 2;
        }
        if hits.len() <= (intervals.len() / 7).max(1) {
            for i in hits {
                let half = 0.5 * (repaired[i] + repaired[i + 1]);
                repaired[i] = half;
                repaired[i + 1] = half;
            }
        }
        let m: f64 = repaired.iter().sum::<f64>() / repaired.len() as f64;
        if !(m > 0.0) || !m.is_finite() {
            return None;
        }
        let mut var = 0.0;
        for x in &repaired {
            let d = x - m;
            var += d * d;
        }
        var /= repaired.len() as f64;
        let cv = var.max(0.0).sqrt() / m;
        if cv.is_finite() {
            Some((m, cv, peaks.len()))
        } else {
            None
        }
    }

    /// Solve the shared 3x3 Gram system once and the per cell fits.
    /// Validity needs a closed measurement with a frozen period, at
    /// least min_cycles frozen periods of samples, Strouhal in 0.03 to
    /// 0.50, explained variance at least 0.35, RMS amplitude over fluid
    /// cells at least 0.002 u_lattice, and finite coefficients. Before
    /// the coefficients are written they rotate so phase zero sits on
    /// the Cl maximum inside the fitting window, and phase_ref_step
    /// records that maximum reduced modulo the period into the stats
    /// window, so it stays inside [transient, transient + window].
    /// The rotation preserves the amplitude hypot per cell, so the
    /// gates read identically either way. Any
    /// failed gate returns all zero coefficients with valid false, but
    /// explained_variance still reports the measured value (0 when no
    /// period or no samples) so a weak harmonic stays visible instead
    /// of being hidden as 0.
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
        let diag_cv = self.measured_interval_stats().map(|(_, cv, _)| cv);
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
            harmonic_tke: 0.0,
            mean_peak_interval: self.frozen_period,
            interval_cv: diag_cv,
        };
        let period = match frozen {
            Some(p) if p.is_finite() && p > 0.0 => p,
            _ => {
                if let Some(reason) = self.close_reason.clone() {
                    out.reason = reason;
                    return out;
                }
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
        let too_few = frozen_span < self.cfg.min_cycles as f64 * period - 1e-9;
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
        let fit_tke = if fluid == 0 {
            0.0
        } else {
            den / fluid as f64
        };
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
        // Anchor phase zero at the Cl maximum inside the fitting
        // window. Rotation preserves hypot per cell, so the explained
        // variance and amplitude gates above read the same either way.
        let (theta, peak_step) = match self.fit_peak_theta(period) {
            Some(v) => (v.0, Some(v.1)),
            None => (0.0, self.anchor_step),
        };
        let (cos_t, sin_t) = (theta.cos(), theta.sin());
        out.phase_ref_step = peak_step;
        for k in 0..n {
            if solid[k] != 0 {
                out.u_cos[k] = 0.0;
                out.u_sin[k] = 0.0;
                out.v_cos[k] = 0.0;
                out.v_sin[k] = 0.0;
                continue;
            }
            out.u_cos[k] = (au[k] * cos_t + bu[k] * sin_t) as f32;
            out.u_sin[k] = (-au[k] * sin_t + bu[k] * cos_t) as f32;
            out.v_cos[k] = (av[k] * cos_t + bv[k] * sin_t) as f32;
            out.v_sin[k] = (-av[k] * sin_t + bv[k] * cos_t) as f32;
        }
        out.explained_variance = explained;
        out.harmonic_tke = fit_tke;
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
            min_cycles: 4,
        };
        (cfg, 8, 8, 1000.0)
    }

    /// Feed Cl history for the measurement phase only. Field samples
    /// are meaningless before the close, so none are taken here.
    fn feed_measurement_cl(acc: &mut HarmonicAccumulator, period: f64, steps: u64) {
        for t in 0..=steps {
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            acc.note_cl(t, cl);
        }
    }

    /// Feed measurement Cl with deterministic uniform jitter at 20
    /// percent of the 0.5 amplitude, modelling LES broadband noise.
    /// Spurious local maxima abound, but they average out of the
    /// shared Strouhal estimate instead of corrupting per cycle peak
    /// gating.
    fn feed_noisy_measurement_cl(acc: &mut HarmonicAccumulator, period: f64, steps: u64) {
        let mut rng: u64 = 0x12345678;
        for t in 0..=steps {
            rng = rng
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let noise = ((rng >> 33) as f64 / (u32::MAX as f64) - 0.5) * 0.2;
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos() + noise;
            acc.note_cl(t, cl);
        }
    }

    /// Run the dedicated fit window after a successful close: note Cl
    /// every step and sample the first harmonic field on the window
    /// anchored cadence. Phase is measured from the window start,
    /// matching the accumulator frame.
    fn feed_fit_window(
        acc: &mut HarmonicAccumulator,
        period: f64,
        window_start: u64,
        extra: u64,
        amp_u: f64,
        amp_v: f64,
        phase_u: f64,
        phase_v: f64,
    ) {
        let cells = 64usize;
        let solid = vec![0u8; cells];
        let mean_u = 0.06;
        let mean_v = 0.005;
        for t in (window_start + 1)..=(window_start + extra) {
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            acc.note_cl(t, cl);
            if (t - window_start) % 10 != 0 {
                continue;
            }
            let phi = 2.0 * std::f64::consts::PI * (t - window_start) as f64 / period;
            let uval = (mean_u + amp_u * (phi + phase_u).cos()) as f32;
            let vval = (mean_v + amp_v * (phi + phase_v).cos()) as f32;
            acc.sample(t, &vec![uval; cells], &vec![vval; cells], &solid);
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
        let measure = 12000u64;
        feed_measurement_cl(&mut acc, period, measure);
        assert_eq!(acc.committed_samples(), 0, "measurement stores no samples");
        let extra = acc.close_measurement(measure);
        assert_eq!(extra, 6000, "extra = {extra}");
        assert_eq!(acc.window_start(), Some(measure));
        feed_fit_window(&mut acc, period, measure, extra, amp_u, amp_v, phase_u, phase_v);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "expected valid fit, reason {}", res.reason);
        assert_eq!(res.reason, "ok");
        assert_eq!(res.samples, 600, "samples = {}", res.samples);
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
    fn harmonic_fit_tke_matches_analytic_variance() {
        // Fit window holds u = 0.06 + 0.03 cos and v = 0.005 + 0.02 cos
        // over whole periods, so per cell var_u = 0.03^2 / 2 and var_v
        // = 0.02^2 / 2, and harmonic_tke must equal their half mean over
        // the all-fluid grid.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        feed_measurement_cl(&mut acc, period, 12000);
        let extra = acc.close_measurement(12000);
        assert!(extra > 0, "close must open a fit window");
        feed_fit_window(&mut acc, period, 12000, extra, 0.03, 0.02, 0.3, -0.5);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "expected valid fit, reason {}", res.reason);
        let expected = (0.03 * 0.03 / 2.0 + 0.02 * 0.02 / 2.0) / 2.0;
        assert!(
            (res.harmonic_tke - expected).abs() < 1e-6,
            "harmonic_tke = {}, expected {expected}",
            res.harmonic_tke
        );
    }

    #[test]
    fn harmonic_tke_zero_without_fit_window() {
        // Constant Cl never closes a measurement, so finalise has no
        // fit window and harmonic_tke must read exactly 0.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        for t in 0..=2000u64 {
            acc.note_cl(t, 0.0);
        }
        let extra = acc.close_measurement(2000);
        assert_eq!(extra, 0, "constant Cl must not open a fit window");
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(!res.valid, "constant Cl must stay invalid");
        assert_eq!(res.harmonic_tke, 0.0, "no fit window means zero tke");
        assert_eq!(HarmonicResult::zeros(nx * ny).harmonic_tke, 0.0);
    }

    #[test]
    fn harmonic_noisy_cl_still_recovers_period() {
        // 20 percent additive noise on Cl: spurious peaks no longer
        // matter because the period comes from the shared Strouhal
        // estimator over the full window, not per cycle peak gating.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let measure = 12000u64;
        feed_noisy_measurement_cl(&mut acc, period, measure);
        let extra = acc.close_measurement(measure);
        assert!(extra > 0, "noisy close must open a fit window");
        feed_fit_window(&mut acc, period, measure, extra, 0.03, 0.02, 0.3, -0.5);
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
        for t in 0..=4000u64 {
            acc.note_cl(t, 0.5);
        }
        let extra = acc.close_measurement(4000);
        assert_eq!(extra, 0, "constant Cl opens no fit window");
        let res = acc.finalise(&solid);
        assert!(!res.valid);
        assert_eq!(res.reason, "not_shedding", "reason = {}", res.reason);
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
        // Period 3500 steps: St 0.057 sits inside the physical bounds,
        // the close guards pass on a 20000 step history, but N would be
        // floor(12000 / 3500) = 3, below the 4 period floor.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let period = 3500.0;
        feed_measurement_cl(&mut acc, period, 20000);
        let extra = acc.close_measurement(20000);
        assert_eq!(extra, 0, "extra = {extra}");
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(!res.valid, "long period run must be invalid");
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
        let measure = 12000u64;
        feed_measurement_cl(&mut acc, period, measure);
        let extra = acc.close_measurement(measure);
        assert!(extra > 0, "close must open a fit window");
        let wrong = 640.0;
        for t in (measure + 1)..=(measure + extra) {
            let cl = 0.5 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            acc.note_cl(t, cl);
            if (t - measure) % 10 != 0 {
                continue;
            }
            let phi = 2.0 * std::f64::consts::PI * (t - measure) as f64 / wrong;
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
    fn harmonic_measurement_samples_ignored() {
        // Field samples fed during the measurement phase are ignored:
        // double amplitude garbage before the close cannot leak into a
        // fit that only spans the dedicated window.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let cells = nx * ny;
        let solid = vec![0u8; cells];
        let amp_u = 0.03;
        let amp_v = 0.02;
        let measure = 12000u64;
        feed_measurement_cl(&mut acc, period, measure);
        let big_u = vec![10.0f32; cells];
        let big_v = vec![-10.0f32; cells];
        for t in (0..=measure).step_by(10) {
            acc.sample(t, &big_u, &big_v, &solid);
        }
        assert_eq!(acc.committed_samples(), 0, "pre close samples must be dropped");
        let extra = acc.close_measurement(measure);
        assert_eq!(extra, 6000, "extra = {extra}");
        feed_fit_window(&mut acc, period, measure, extra, amp_u, amp_v, 0.3, -0.5);
        let res = acc.finalise(&solid);
        assert!(res.valid, "reason = {}", res.reason);
        let exp_au = amp_u * 0.3f64.cos();
        let exp_bu = -amp_u * 0.3f64.sin();
        assert!((res.u_cos[0] as f64 - exp_au).abs() < 0.001, "u_cos = {}", res.u_cos[0]);
        assert!((res.u_sin[0] as f64 - exp_bu).abs() < 0.001, "u_sin = {}", res.u_sin[0]);
    }

    #[test]
    fn harmonic_biased_early_history_recovers_true_period() {
        // Cl wobbles at period 597 for the first two wobble periods at
        // 10 percent amplitude, modelling an unsaturated early wake,
        // then settles into full amplitude shedding at period 845. The
        // full window measurement dilutes the early wobble below the
        // peak threshold, so St lands within 1 percent of truth where
        // an early freeze would have committed the biased period.
        let cfg = HarmonicConfig {
            d_lat: 16.0,
            u_lattice: 0.08,
            skip_cycles: 2,
            min_cycles: 4,
        };
        let mut acc = HarmonicAccumulator::new(8, 8, 0, 10, cfg).unwrap();
        let true_period = 845.0;
        let wobble = 597.0;
        let wobble_steps = (2.0 * wobble) as u64;
        let cont = 2.0 * std::f64::consts::PI * wobble_steps as f64 / wobble;
        let measure = 12000u64;
        for t in 0..=measure {
            let cl = if t < wobble_steps {
                0.05 * (2.0 * std::f64::consts::PI * t as f64 / wobble).cos()
            } else {
                0.5 * (2.0 * std::f64::consts::PI * (t - wobble_steps) as f64 / true_period
                    + cont)
                    .cos()
            };
            acc.note_cl(t, cl);
        }
        let extra = acc.close_measurement(measure);
        let truth = 16.0 / (true_period * 0.08);
        let st = acc.strouhal().expect("close must report Strouhal");
        assert!((st - truth).abs() / truth < 0.01, "st = {st}, truth = {truth}");
        // N = 6 since 6 * 845 = 5070 <= 12000, and H rounds up to the
        // cadence without overshooting a whole extra sample.
        assert_eq!(extra % 10, 0, "extra = {extra}");
        assert!((extra as i64 - 5070).abs() <= 10, "extra = {extra}");
        feed_fit_window(&mut acc, true_period, measure, extra, 0.03, 0.02, 0.3, -0.5);
        let solid = vec![0u8; 64];
        let res = acc.finalise(&solid);
        assert!(res.valid, "reason = {}", res.reason);
        assert!(res.explained_variance > 0.95, "explained = {}", res.explained_variance);
        assert_eq!(res.cycles, 6, "cycles = {}", res.cycles);
        assert_eq!(res.samples, extra / 10, "samples = {}", res.samples);
    }

    #[test]
    fn harmonic_phase_anchor_at_cl_maximum() {
        // The close step is not aligned to the period, so the peak
        // rotation is nontrivial. phase_ref must be the step of a Cl
        // maximum, and the rotated coefficients must reproduce
        // u(t) = A cos(2 pi (t minus phase_ref) / P).
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let measure = 11500u64;
        feed_measurement_cl(&mut acc, period, measure);
        let extra = acc.close_measurement(measure);
        assert_eq!(extra, 6000, "extra = {extra}");
        // Field in phase with Cl: u(t) = 0.06 + 0.03 cos(2 pi t / P).
        // The window frame needs phase_u = pi to cancel the half
        // period offset of the 11500 close step.
        feed_fit_window(
            &mut acc,
            period,
            measure,
            extra,
            0.03,
            0.02,
            std::f64::consts::PI,
            0.0,
        );
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "reason = {}", res.reason);
        let peak = res.phase_ref_step.expect("phase ref must be set");
        // Cl(t) = 0.5 cos(2 pi t / P) peaks exactly at multiples of P.
        assert_eq!(peak % 1000, 0, "peak = {peak}");
        // The window start sits half a period past a Cl maximum, so
        // the peak rotation by theta = pi maps the window frame fit
        // back onto the in phase cosine.
        let amp = 0.03;
        assert!((res.u_cos[0] as f64 - amp).abs() < 0.001, "u_cos = {}", res.u_cos[0]);
        assert!(res.u_sin[0].abs() < 0.001, "u_sin = {}", res.u_sin[0]);
        for t in [measure + 1, 12000, 12123, 12500, 13750, 17000, measure + extra] {
            let dt = t as i64 - peak as i64;
            let phi = 2.0 * std::f64::consts::PI * dt as f64 / period;
            let recon = 0.06 + res.u_cos[0] as f64 * phi.cos() + res.u_sin[0] as f64 * phi.sin();
            let truth = 0.06 + 0.03 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            assert!((recon - truth).abs() < 1e-6, "t = {t}: recon = {recon}, truth = {truth}");
        }
    }

    #[test]
    fn harmonic_phase_ref_wraps_into_stats_window() {
        // Nonzero start_step with the fit crest thirteen periods past
        // it: the reported reference must land in
        // [start_step, start_step + period) on a Cl crest, and the
        // rotated coefficients must still reproduce the analytic
        // signal at times inside and past the stats window.
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let start = 8000u64;
        let mut acc = HarmonicAccumulator::new(nx, ny, start, 10, cfg).unwrap();
        let measure = start + 12000;
        feed_measurement_cl(&mut acc, period, measure);
        let extra = acc.close_measurement(measure);
        assert_eq!(extra, 6000, "extra = {extra}");
        feed_fit_window(&mut acc, period, measure, extra, 0.03, 0.02, 0.0, 0.0);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "expected valid fit, reason {}", res.reason);
        let peak = res.phase_ref_step.expect("phase ref must be set");
        assert!(
            peak >= start && ((peak - start) as f64) < period,
            "peak {peak} must lie in [{start}, {})",
            start as f64 + period
        );
        assert_eq!(peak % 1000, 0, "peak = {peak}");
        for t in [start, start + 500, measure, measure + 1, 21000, 25555, measure + extra] {
            let dt = t as i64 - peak as i64;
            let phi = 2.0 * std::f64::consts::PI * dt as f64 / period;
            let recon = 0.06 + res.u_cos[0] as f64 * phi.cos() + res.u_sin[0] as f64 * phi.sin();
            let truth = 0.06 + 0.03 * (2.0 * std::f64::consts::PI * t as f64 / period).cos();
            assert!((recon - truth).abs() < 1e-6, "t = {t}: recon = {recon}, truth = {truth}");
        }
    }

    #[test]
    fn harmonic_close_is_idempotent() {
        let (cfg, nx, ny, period) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        feed_measurement_cl(&mut acc, period, 12000);
        let first = acc.close_measurement(12000);
        assert_eq!(first, 6000);
        assert!(acc.measurement_closed());
        let second = acc.close_measurement(12000);
        assert_eq!(second, first, "second close must return the stored count");
    }

    #[test]
    fn harmonic_phase_ref_wrap_survives_many_periods() {
        // Start far from zero with a non-round period, so the fit
        // crest sits about fifteen periods past the stats start. The
        // reported reference must still land in
        // [start_step, start_step + period) on a crest multiple.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let start = 100u64;
        let period = 845.0;
        let mut acc = HarmonicAccumulator::new(nx, ny, start, 10, cfg).unwrap();
        let measure = start + 12000;
        feed_measurement_cl(&mut acc, period, measure);
        let extra = acc.close_measurement(measure);
        assert!(extra > 0, "close must open a fit window, extra = {extra}");
        feed_fit_window(&mut acc, period, measure, extra, 0.03, 0.02, 0.3, -0.5);
        let solid = vec![0u8; nx * ny];
        let res = acc.finalise(&solid);
        assert!(res.valid, "expected valid fit, reason {}", res.reason);
        let peak = res.phase_ref_step.expect("phase ref must be set");
        assert!(
            peak >= start && ((peak - start) as f64) < period,
            "peak {peak} must lie in [{start}, {})",
            start as f64 + period
        );
        assert_eq!(peak % 845, 0, "peak = {peak}");
    }

    /// Feed a spike train Cl whose detected peaks sit exactly at the
    /// cumulative sums of the given intervals. Isolated unit spikes on
    /// a zero background satisfy the shared peak rule exactly, so the
    /// interval list under test is the interval list measured.
    fn feed_spike_train_cl(acc: &mut HarmonicAccumulator, intervals: &[u64]) {
        let mut peak = 1000u64;
        let mut peaks: Vec<u64> = Vec::with_capacity(intervals.len() + 1);
        peaks.push(peak);
        for x in intervals {
            peak += x;
            peaks.push(peak);
        }
        let end = peak + 1000;
        for t in 0..=end {
            let cl = if peaks.contains(&t) { 2.0 } else { 0.0 };
            acc.note_cl(t, cl);
        }
    }

    #[test]
    fn harmonic_misplaced_boundary_pair_passes_cv_guard() {
        // Measured Re 700 series: fourteen intervals, mean exactly 829,
        // median 848, one misplaced period boundary giving the 615 and
        // 1095 pair. Only that pair is repairable (615 sits 27.5
        // percent below the median, 1095 sits 29.1 percent above, every
        // other member is within 25 percent), so exactly one pair
        // averages in place to 855 and 855. The mean stays exactly 829,
        // the interval count is unchanged, and the CV drops to about
        // 0.0765, inside the 0.12 cap. The expected list pins down that
        // the unrepairable neighbours are left untouched.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let intervals = [
            891u64, 925, 615, 1095, 707, 793, 877, 779, 888, 848, 848, 859, 735, 746,
        ];
        feed_spike_train_cl(&mut acc, &intervals);
        let (mean, cv, count) = acc
            .measured_interval_stats()
            .expect("spike train must yield interval stats");
        assert_eq!(count, intervals.len() + 1, "peak count = {count}");
        assert!((mean - 829.0).abs() < 1e-9, "repaired mean {mean} must stay exactly 829");
        let span = intervals.iter().sum::<u64>() as f64;
        assert!(
            (mean * intervals.len() as f64 - span).abs() < 1e-9,
            "span {span} and count must be preserved, mean = {mean}"
        );
        let expected = [
            891.0f64, 925.0, 855.0, 855.0, 707.0, 793.0, 877.0, 779.0, 888.0, 848.0, 848.0,
            859.0, 735.0, 746.0,
        ];
        let exp_mean = expected.iter().sum::<f64>() / expected.len() as f64;
        let exp_var =
            expected.iter().map(|x| (x - exp_mean) * (x - exp_mean)).sum::<f64>() / expected.len() as f64;
        let exp_cv = exp_var.max(0.0).sqrt() / exp_mean;
        assert!(
            (cv - exp_cv).abs() < 1e-12,
            "repaired CV {cv} must match single-pair repair {exp_cv}"
        );
        assert!(cv <= 0.12, "repaired CV {cv} must pass the 0.12 cap");
    }

    #[test]
    fn harmonic_clean_double_gap_is_split_into_two_periods() {
        // One fully missed crest leaves a single 1710 gap near twice
        // the 855 median. The repair must split it into two nominal
        // intervals, giving the 855 mean and a zero spread.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let intervals = [855u64, 855, 855, 855, 855, 855, 1710, 855, 855, 855, 855, 855];
        feed_spike_train_cl(&mut acc, &intervals);
        let (mean, cv, _) = acc
            .measured_interval_stats()
            .expect("spike train must yield interval stats");
        assert!((mean - 855.0).abs() < 1e-9, "repaired mean {mean} must equal 855");
        assert!(cv < 1e-12, "repaired CV {cv} must vanish");
    }

    #[test]
    fn harmonic_aperiodic_wake_still_fails_cv_guard() {
        // Blocked short then long intervals spanning 0.68 to 1.33
        // times the nominal period with no dominant rhythm. Short
        // pairs and long pairs both fall outside the 10 percent pair
        // band around twice the median and no interval reaches 1.6
        // times the median, so neither repair engages and the CV must
        // stay above the 0.12 cap.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let intervals = [
            600u64, 640, 680, 720, 760, 800, 980, 1020, 1060, 1100, 1140, 1180,
        ];
        feed_spike_train_cl(&mut acc, &intervals);
        let (_, cv, _) = acc
            .measured_interval_stats()
            .expect("spike train must yield interval stats");
        assert!(cv > 0.12, "aperiodic CV {cv} must still fail the 0.12 cap");
    }

    #[test]
    fn harmonic_period_doubled_wake_still_fails_cv_guard() {
        // Fourteen intervals alternating 600 and 1200 about the 900
        // median. Every member deviates 33 percent, so all seven
        // non-overlapping pairs are anomaly bearing and sum to exactly
        // twice the median; the count exceeds the cap of two, the pair
        // repair is blocked, and the CV must stay above the 0.12 cap.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let intervals = [
            600u64, 1200, 600, 1200, 600, 1200, 600, 1200, 600, 1200, 600, 1200, 600, 1200,
        ];
        feed_spike_train_cl(&mut acc, &intervals);
        let (mean, cv, count) = acc
            .measured_interval_stats()
            .expect("spike train must yield interval stats");
        assert_eq!(count, intervals.len() + 1, "peak count = {count}");
        assert!((mean - 900.0).abs() < 1e-9, "mean {mean} must equal 900");
        assert!(cv > 0.12, "period-doubled CV {cv} must still fail the 0.12 cap");
    }

    #[test]
    fn harmonic_all_regular_intervals_need_no_repair() {
        // Fourteen regular intervals near the 899 median with every
        // member inside 25 percent of it. No interval reaches 1.6 times
        // the median and no pair is anomaly bearing, so neither repair
        // engages and the reported CV must equal the raw CV exactly.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let mut acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let intervals = [
            880u64, 900, 920, 890, 910, 885, 915, 895, 905, 888, 912, 898, 902, 894,
        ];
        feed_spike_train_cl(&mut acc, &intervals);
        let (mean, cv, _) = acc
            .measured_interval_stats()
            .expect("spike train must yield interval stats");
        let raw: Vec<f64> = intervals.iter().map(|x| *x as f64).collect();
        let raw_mean = raw.iter().sum::<f64>() / raw.len() as f64;
        let raw_var =
            raw.iter().map(|x| (x - raw_mean) * (x - raw_mean)).sum::<f64>() / raw.len() as f64;
        let raw_cv = raw_var.max(0.0).sqrt() / raw_mean;
        assert!((mean - raw_mean).abs() < 1e-12, "mean {mean} must equal raw {raw_mean}");
        assert!((cv - raw_cv).abs() < 1e-12, "CV {cv} must equal raw {raw_cv}");
    }

    #[test]
    fn harmonic_huge_sample_every_fails_cleanly() {
        // A gigantic cadence must be rejected at construction with a
        // clear error, never wrap the H arithmetic. The boundary value
        // itself stays accepted.
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let err = HarmonicAccumulator::new(nx, ny, 0, 100001, cfg)
            .expect_err("cadence over 100000 must fail");
        assert!(err.contains("sample_every"), "error = {err}");
        assert!(HarmonicAccumulator::new(nx, ny, 0, 100000, cfg).is_ok());
        assert!(HarmonicAccumulator::new(nx, ny, 0, 1, cfg).is_ok());
    }

    #[test]
    fn harmonic_diag_bare_tokens_create_no_file() {
        // "0", "false", and bare words must print only the stderr line
        // and never create or truncate a file. Runs the token checks
        // sequentially in one test so parallel tests cannot race the
        // process-global variable. Saves and restores the prior value.
        let key = "GEARFLOW_DIAG_HARMONIC";
        let saved = std::env::var(key).ok();
        let (cfg, nx, ny, _) = harmonic_test_setup();
        let acc = HarmonicAccumulator::new(nx, ny, 0, 10, cfg).unwrap();
        let cwd = std::env::current_dir().expect("cwd must be readable");
        for token in ["0", "false", "yes", "1", "true"] {
            let probe = cwd.join(token);
            let _ = std::fs::remove_file(&probe);
            std::env::set_var(key, token);
            acc.emit_close_diag(0, "diag_probe", None, None);
            assert!(
                !probe.exists(),
                "token {token:?} must not create {}",
                probe.display()
            );
            let _ = std::fs::remove_file(&probe);
        }
        std::env::remove_var(key);
        acc.emit_close_diag(0, "diag_probe_unset", None, None);
        let dir = std::env::temp_dir().join(format!("gearflow_diag_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let dump = dir.join("cl.txt");
        let _ = std::fs::remove_file(&dump);
        std::env::set_var(key, dump.to_string_lossy().as_ref());
        acc.emit_close_diag(0, "diag_probe_dump", None, None);
        assert!(dump.exists(), "separator path must still dump");
        let _ = std::fs::remove_file(&dump);
        match saved {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
    }
}
