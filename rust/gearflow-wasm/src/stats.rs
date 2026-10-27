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
}
