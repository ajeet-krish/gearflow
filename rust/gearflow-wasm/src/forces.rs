// Momentum exchange forces, Cd and Cl normalisation, history, Strouhal.
// Stationary walls so no moving wall correction term. f64 accumulation.
// Pure math, no wasm-bindgen, host testable.

use crate::lattice::{CX, CY};

/// Maximum retained force history samples. Sizing: the fastest supported
/// case (D_lat 4 cells, u_lattice 0.12) has a shedding period near
/// T = D / (St u) = 4 / (0.165 * 0.12) = 202 steps, so 100 shedding periods
/// need about 20200 samples at sample_every 1. The ring keeps the newest
/// 32768 samples (well above that), summaries and Strouhal use only the
/// retained window, and older samples fall off with wraparound.
pub const FORCE_HISTORY_CAP: usize = 32768;

/// Force accumulator with a step indexed history ring.
#[derive(Clone, Debug)]
pub struct ForceAccumulator {
    pub fx: f64,
    pub fy: f64,
    pub ref_cd: f64,
    pub ref_cl: f64,
    pub u_lattice: f64,
    pub cd: f64,
    pub cl: f64,
    steps: Vec<u64>,
    cd_hist: Vec<f64>,
    cl_hist: Vec<f64>,
}

impl ForceAccumulator {
    /// Create with lattice reference lengths and inlet speed.
    pub fn new(ref_cd: f64, ref_cl: f64, u_lattice: f64) -> Result<Self, String> {
        if !ref_cd.is_finite() || ref_cd <= 0.0 {
            return Err(format!("forces: ref_cd must be positive, got {ref_cd}"));
        }
        if !ref_cl.is_finite() || ref_cl <= 0.0 {
            return Err(format!("forces: ref_cl must be positive, got {ref_cl}"));
        }
        if !u_lattice.is_finite() || u_lattice <= 0.0 {
            return Err(format!("forces: u_lattice must be positive, got {u_lattice}"));
        }
        Ok(ForceAccumulator {
            fx: 0.0,
            fy: 0.0,
            ref_cd,
            ref_cl,
            u_lattice,
            cd: 0.0,
            cl: 0.0,
            steps: Vec::new(),
            cd_hist: Vec::new(),
            cl_hist: Vec::new(),
        })
    }

    /// Clear the running step force without touching history.
    pub fn begin_step(&mut self) {
        self.fx = 0.0;
        self.fy = 0.0;
    }

    /// Add one bounce back link contribution.
    /// inc is opp[d], f_star_inc is the post collision population at the
    /// fluid node along inc.
    pub fn add_link(&mut self, inc: usize, f_star_inc: f64) {
        assert!(inc < 9, "forces: add_link direction must be 0..9");
        if !f_star_inc.is_finite() {
            return;
        }
        let dfx = 2.0 * CX[inc] as f64 * f_star_inc;
        let dfy = 2.0 * CY[inc] as f64 * f_star_inc;
        self.fx += dfx;
        self.fy += dfy;
    }

    /// Normalise the accumulated step force. rho_ref is 1.
    pub fn normalise_step(&mut self) {
        let denom_cd = self.u_lattice * self.u_lattice * self.ref_cd;
        let denom_cl = self.u_lattice * self.u_lattice * self.ref_cl;
        if denom_cd > 0.0 {
            self.cd = 2.0 * self.fx / denom_cd;
        } else {
            self.cd = 0.0;
        }
        if denom_cl > 0.0 {
            self.cl = 2.0 * self.fy / denom_cl;
        } else {
            self.cl = 0.0;
        }
        if !self.cd.is_finite() {
            self.cd = 0.0;
        }
        if !self.cl.is_finite() {
            self.cl = 0.0;
        }
    }

    /// Append the current normalised coefficients to the history.
    /// True bounded ring: when full, the oldest sample falls off so the
    /// history holds the last FORCE_HISTORY_CAP samples with wraparound.
    /// Summaries and Strouhal therefore use only the retained window.
    pub fn push_history(&mut self, step: u64) {
        if self.steps.len() >= FORCE_HISTORY_CAP {
            let overflow = self.steps.len() + 1 - FORCE_HISTORY_CAP;
            self.steps.drain(..overflow);
            self.cd_hist.drain(..overflow);
            self.cl_hist.drain(..overflow);
        }
        self.steps.push(step);
        self.cd_hist.push(self.cd);
        self.cl_hist.push(self.cl);
    }

    /// History slices.
    pub fn cd_history(&self) -> &[f64] {
        &self.cd_hist
    }

    /// History slices.
    pub fn cl_history(&self) -> &[f64] {
        &self.cl_hist
    }

    /// Step numbers for the history.
    pub fn history_steps(&self) -> &[u64] {
        &self.steps
    }

    /// Number of history entries.
    pub fn history_len(&self) -> usize {
        self.steps.len()
    }

    /// Clear history and the running force.
    pub fn reset(&mut self) {
        self.fx = 0.0;
        self.fy = 0.0;
        self.cd = 0.0;
        self.cl = 0.0;
        self.steps.clear();
        self.cd_hist.clear();
        self.cl_hist.clear();
    }

    /// Mean Cd and Cl over entries with step >= from_step.
    pub fn summary(&self, from_step: u64) -> ForceSummary {
        let mut n = 0usize;
        let mut sum_cd = 0.0;
        let mut sum_cl = 0.0;
        let mut sum_cl2 = 0.0;
        let mut min_cl = f64::INFINITY;
        let mut max_cl = f64::NEG_INFINITY;
        for i in 0..self.steps.len() {
            if self.steps[i] < from_step {
                continue;
            }
            let cd = self.cd_hist[i];
            let cl = self.cl_hist[i];
            if !cd.is_finite() || !cl.is_finite() {
                continue;
            }
            n += 1;
            sum_cd += cd;
            sum_cl += cl;
            sum_cl2 += cl * cl;
            if cl < min_cl {
                min_cl = cl;
            }
            if cl > max_cl {
                max_cl = cl;
            }
        }
        if n == 0 {
            return ForceSummary {
                count: 0,
                mean_cd: 0.0,
                mean_cl: 0.0,
                rms_cl: 0.0,
                amplitude_cl: 0.0,
            };
        }
        let mean_cd = sum_cd / n as f64;
        let mean_cl = sum_cl / n as f64;
        let var = (sum_cl2 / n as f64 - mean_cl * mean_cl).max(0.0);
        ForceSummary {
            count: n,
            mean_cd,
            mean_cl,
            rms_cl: var.sqrt(),
            amplitude_cl: if min_cl.is_finite() && max_cl.is_finite() {
                0.5 * (max_cl - min_cl)
            } else {
                0.0
            },
        }
    }
}

/// Time mean force summary over a window.
#[derive(Clone, Copy, Debug)]
pub struct ForceSummary {
    pub count: usize,
    pub mean_cd: f64,
    pub mean_cl: f64,
    pub rms_cl: f64,
    pub amplitude_cl: f64,
}

/// Measure Strouhal by peak counting on a detrended Cl trace.
/// min separation is 0.5 D_lat / (0.2 u_lattice) steps.
/// Returns Err for constant signals with no usable peaks.
pub fn strouhal_from_cl(cl: &[f64], d_lat: f64, u_lattice: f64) -> Result<f64, String> {
    if cl.len() < 16 {
        return Err("forces: cl history too short for Strouhal".to_string());
    }
    if !d_lat.is_finite() || d_lat <= 0.0 {
        return Err(format!("forces: d_lat must be positive, got {d_lat}"));
    }
    if !u_lattice.is_finite() || u_lattice <= 0.0 {
        return Err(format!("forces: u_lattice must be positive, got {u_lattice}"));
    }
    for v in cl {
        if !v.is_finite() {
            return Err("forces: non-finite cl in Strouhal window".to_string());
        }
    }
    let n = cl.len();
    let mean: f64 = cl.iter().sum::<f64>() / n as f64;
    let mut detrended = Vec::with_capacity(n);
    for v in cl {
        detrended.push(v - mean);
    }
    let rms = (detrended.iter().map(|v| v * v).sum::<f64>() / n as f64).sqrt();
    if !(rms > 0.0) || !rms.is_finite() {
        return Err("forces: constant cl signal, no Strouhal".to_string());
    }
    let threshold = 0.5 * rms;
    let min_sep = (0.5 * d_lat / (0.2 * u_lattice)).round() as usize;
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
        return Err("forces: too few Cl peaks for Strouhal".to_string());
    }
    let mut intervals: Vec<f64> = Vec::with_capacity(peaks.len() - 1);
    for w in 1..peaks.len() {
        intervals.push((peaks[w] - peaks[w - 1]) as f64);
    }
    let mean_interval: f64 = intervals.iter().sum::<f64>() / intervals.len() as f64;
    if !(mean_interval > 0.0) {
        return Err("forces: degenerate peak spacing".to_string());
    }
    Ok(d_lat / (mean_interval * u_lattice))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalisation_matches_blueprint() {
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.fx = 0.5 * 0.08 * 0.08 * 16.0;
        acc.fy = 0.0;
        acc.normalise_step();
        assert!((acc.cd - 1.0).abs() < 1e-12, "cd = {}", acc.cd);
    }

    #[test]
    fn west_fluid_contributes_positive_drag() {
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.begin_step();
        acc.add_link(1, 0.1);
        assert!(acc.fx > 0.0);
    }

    #[test]
    fn momentum_exchange_pins_factor_two_all_cardinals() {
        // dF = 2 c[inc] f_star, exact for each cardinal incidence.
        let fstar = 0.1;
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.begin_step();
        acc.add_link(1, fstar);
        assert!((acc.fx - 0.2).abs() < 1e-12, "fx = {}", acc.fx);
        assert!(acc.fy.abs() < 1e-12, "fy = {}", acc.fy);
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.begin_step();
        acc.add_link(3, fstar);
        assert!((acc.fx + 0.2).abs() < 1e-12, "fx = {}", acc.fx);
        assert!(acc.fy.abs() < 1e-12);
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.begin_step();
        acc.add_link(2, fstar);
        assert!(acc.fx.abs() < 1e-12);
        assert!((acc.fy - 0.2).abs() < 1e-12, "fy = {}", acc.fy);
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        acc.begin_step();
        acc.add_link(4, fstar);
        assert!(acc.fx.abs() < 1e-12);
        assert!((acc.fy + 0.2).abs() < 1e-12, "fy = {}", acc.fy);
    }

    #[test]
    fn strouhal_recovers_synthetic_sine() {
        let st_true = 0.165;
        let d_lat = 16.0;
        let u = 0.08;
        let period = d_lat / (st_true * u);
        let n = (period * 12.0) as usize;
        let mut cl = Vec::with_capacity(n);
        for i in 0..n {
            cl.push((2.0 * std::f64::consts::PI * i as f64 / period).sin());
        }
        let st = strouhal_from_cl(&cl, d_lat, u).unwrap();
        assert!((st - st_true).abs() < 0.001, "st = {st}");
    }

    #[test]
    fn strouhal_rejects_constant_signal() {
        let cl = vec![0.5; 512];
        assert!(strouhal_from_cl(&cl, 16.0, 0.08).is_err());
    }

    #[test]
    fn history_ring_keeps_last_cap_samples() {
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        let total = (FORCE_HISTORY_CAP + 500) as u64;
        for step in 1..=total {
            acc.cd = step as f64;
            acc.cl = -(step as f64);
            acc.push_history(step);
        }
        assert!(acc.history_len() <= FORCE_HISTORY_CAP);
        assert_eq!(acc.history_len(), FORCE_HISTORY_CAP);
        assert_eq!(acc.history_steps()[0], total - FORCE_HISTORY_CAP as u64 + 1);
        assert_eq!(*acc.history_steps().last().unwrap(), total);
        // Summary over the retained window only: mean of the last N steps.
        let summary = acc.summary(total - FORCE_HISTORY_CAP as u64 + 1);
        assert_eq!(summary.count, FORCE_HISTORY_CAP);
        let first = (total - FORCE_HISTORY_CAP as u64 + 1) as f64;
        let last = total as f64;
        assert!((summary.mean_cd - (first + last) / 2.0).abs() < 1e-6);
    }

    #[test]
    fn history_ring_single_overflow_drops_oldest() {
        let mut acc = ForceAccumulator::new(16.0, 16.0, 0.08).unwrap();
        for step in 1..=(FORCE_HISTORY_CAP as u64) {
            acc.cd = step as f64;
            acc.push_history(step);
        }
        assert_eq!(acc.history_len(), FORCE_HISTORY_CAP);
        acc.cd = 1.0e9;
        acc.push_history(FORCE_HISTORY_CAP as u64 + 1);
        assert_eq!(acc.history_len(), FORCE_HISTORY_CAP);
        assert_eq!(acc.history_steps()[0], 2);
        assert!((acc.cd_history()[FORCE_HISTORY_CAP - 1] - 1.0e9).abs() < 1e-12);
    }
}
