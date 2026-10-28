// Native Phase C dataset pilot runner. Calls LbmState directly with no
// WASM and no worker. Deterministic seed 42, sample_every 10. Writes raw
// little endian float32 bins plus a JSON sidecar per case and one manifest
// JSONL row per case. Zero new crates, std only plus the lib itself.
//
// C-2 extension: optional `cases` spec file (CaseSpecV1 JSON lines) plus
// `manifest_out` fragment arg for the Modal sweep. Spec rows use sha v3
// over twelve bins in order umean, vmean, pmean, omegamean, tke, recirc,
// obstacle, sdf, ucos, usin, vcos, vsin. Pilot rows keep sha v1 over the
// first seven bins. Every row carries sha_version, ref_length, and
// substitutes_for. The eighth bin sdf.f32 comes from the same SDF grid
// that builds the solid mask. The four harmonic bins carry the phase
// averaged first harmonic of u and v in lattice velocity units.

use gearflow_wasm::boundaries::{InletProfile, OutletKind};
use gearflow_wasm::geometry::build_polygons;
use gearflow_wasm::lbm::{LbmConfig, LbmState};
use gearflow_wasm::sdf::build_sdf_grid;
use gearflow_wasm::stats::HarmonicResult;
use gearflow_wasm::types::{CircleDef, Domain, GeometrySpec, GridSpec, NacaParams, Xy};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Clone, Copy)]
struct PilotCase {
    id: &'static str,
    body: &'static str,
    re: f64,
    u: f64,
    nx: usize,
    ny: usize,
    width: f64,
    les: bool,
    alpha_deg: f64,
    note: &'static str,
}

fn pilot_cases() -> Vec<PilotCase> {
    vec![
        PilotCase { id: "cyl_r020_re020", body: "cylinder", re: 20.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "cylinder radius 0.2 steady" },
        PilotCase { id: "cyl_r020_re040", body: "cylinder", re: 40.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "cylinder radius 0.2 steady" },
        PilotCase { id: "cyl_r020_re100", body: "cylinder", re: 100.0, u: 0.08, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "cylinder radius 0.2 shedding, confined tunnel" },
        PilotCase { id: "cyl_r020_re060", body: "cylinder", re: 60.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "substitute for diverged cyl_r020_re100, lower Re" },
        PilotCase { id: "block_040_re040", body: "block", re: 40.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "square block 0.4 by 0.4" },
        PilotCase { id: "block_040_re100", body: "block", re: 100.0, u: 0.08, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "square block 0.4 by 0.4 shedding" },
        PilotCase { id: "block_040_re060", body: "block", re: 60.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "substitute for diverged block_040_re100, lower Re" },
        PilotCase { id: "naca0012_a00_re100", body: "naca0012", re: 100.0, u: 0.06, nx: 256, ny: 128, width: 2.55, les: true, alpha_deg: 0.0, note: "LES stabilised, thin body low tau" },
        PilotCase { id: "naca0012_a04_re100", body: "naca0012", re: 100.0, u: 0.06, nx: 256, ny: 128, width: 2.55, les: true, alpha_deg: 4.0, note: "LES stabilised" },
        PilotCase { id: "naca0012_a06_re100", body: "naca0012", re: 100.0, u: 0.06, nx: 256, ny: 128, width: 2.55, les: true, alpha_deg: 6.0, note: "LES stabilised" },
        PilotCase { id: "naca2412_a06_re100", body: "naca2412", re: 100.0, u: 0.06, nx: 256, ny: 128, width: 2.55, les: true, alpha_deg: 6.0, note: "LES stabilised, cambered" },
        PilotCase { id: "duct_h040_re040", body: "duct", re: 40.0, u: 0.06, nx: 160, ny: 128, width: 4.0, les: false, alpha_deg: 0.0, note: "channel gap 0.4, parabolic inlet" },
    ]
}

fn pilot_ref_length(id: &str, body: &str) -> f64 {
    if body == "cylinder" {
        0.4
    } else if body == "block" {
        0.4
    } else if body == "duct" {
        0.4
    } else if body.starts_with("naca") {
        1.0
    } else {
        let _ = id;
        1.0
    }
}

fn pilot_substitutes_for(id: &str) -> Option<String> {
    match id {
        "cyl_r020_re060" => Some("cyl_r020_re100".to_string()),
        "block_040_re060" => Some("block_040_re100".to_string()),
        _ => None,
    }
}

/// Unified run case for pilot and spec paths. sha_version 1 means the
/// legacy seven bin hash, sha_version 2 covers eight bins with sdf last,
/// sha_version 3 covers twelve bins with the four harmonic bins last.
#[derive(Clone, Debug)]
struct ResolvedCase {
    id: String,
    body: String,
    re: f64,
    u: f64,
    alpha_deg: f64,
    les: bool,
    nx: usize,
    ny: usize,
    width: f64,
    radius: Option<f64>,
    block_width: Option<f64>,
    block_height: Option<f64>,
    naca_code: Option<String>,
    ref_length: f64,
    transient: u64,
    window: u64,
    substitutes_for: Option<String>,
    note: String,
    sha_version: u8,
}

fn resolved_from_pilot(p: &PilotCase, transient: u64, window: u64) -> ResolvedCase {
    ResolvedCase {
        id: p.id.to_string(),
        body: p.body.to_string(),
        re: p.re,
        u: p.u,
        alpha_deg: p.alpha_deg,
        les: p.les,
        nx: p.nx,
        ny: p.ny,
        width: p.width,
        radius: None,
        block_width: None,
        block_height: None,
        naca_code: None,
        ref_length: pilot_ref_length(p.id, p.body),
        transient,
        window,
        substitutes_for: pilot_substitutes_for(p.id),
        note: p.note.to_string(),
        sha_version: 1,
    }
}

fn naca_params_from_code(code: &str) -> Result<NacaParams, String> {
    if code.len() != 4 || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(format!("cases: naca_code must be 4 digits, got {code:?}"));
    }
    let d: Vec<u32> = code.chars().map(|c| c.to_digit(10).unwrap()).collect();
    let m = d[0] as f64 / 100.0;
    let p = if m == 0.0 { 0.0 } else { d[1] as f64 / 10.0 };
    let t = (d[2] * 10 + d[3]) as f64 / 100.0;
    Ok(NacaParams { code: code.to_string(), m, p, t })
}

fn get_str(v: &serde_json::Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("cases: missing string field {key:?}"))
}

fn get_f64(v: &serde_json::Value, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| format!("cases: missing numeric field {key:?}"))
}

fn get_usize(v: &serde_json::Value, key: &str) -> Result<usize, String> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .map(|n| n as usize)
        .ok_or_else(|| format!("cases: missing integer field {key:?}"))
}

fn get_u64(v: &serde_json::Value, key: &str) -> Result<u64, String> {
    v.get(key)
        .and_then(|x| x.as_u64())
        .ok_or_else(|| format!("cases: missing integer field {key:?}"))
}

fn get_bool(v: &serde_json::Value, key: &str) -> Result<bool, String> {
    v.get(key)
        .and_then(|x| x.as_bool())
        .ok_or_else(|| format!("cases: missing boolean field {key:?}"))
}

fn get_opt_f64(v: &serde_json::Value, key: &str) -> Result<Option<f64>, String> {
    match v.get(key) {
        None => Ok(None),
        Some(serde_json::Value::Null) => Ok(None),
        Some(x) => x
            .as_f64()
            .map(Some)
            .ok_or_else(|| format!("cases: field {key:?} must be a number or null")),
    }
}

fn get_opt_str(v: &serde_json::Value, key: &str) -> Result<Option<String>, String> {
    match v.get(key) {
        None => Ok(None),
        Some(serde_json::Value::Null) => Ok(None),
        Some(x) => x
            .as_str()
            .map(|s| Some(s.to_string()))
            .ok_or_else(|| format!("cases: field {key:?} must be a string or null")),
    }
}

/// Parse one CaseSpecV1 JSON line. Required keys: case_id, body, re,
/// u_lattice, alpha_deg, les, nx, ny, domain_width, ref_length,
/// transient, window, note. Nullable keys default to null when absent:
/// radius, width, height, naca_code, substitutes_for.
fn parse_spec_line(line: &str) -> Result<ResolvedCase, String> {
    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| format!("cases: bad JSON line: {e}"))?;
    let id = get_str(&v, "case_id")?;
    let body = get_str(&v, "body")?;
    if id.is_empty() || body.is_empty() {
        return Err("cases: case_id and body must be non-empty".to_string());
    }
    let re = get_f64(&v, "re")?;
    let u = get_f64(&v, "u_lattice")?;
    let alpha_deg = get_f64(&v, "alpha_deg")?;
    let les = get_bool(&v, "les")?;
    let nx = get_usize(&v, "nx")?;
    let ny = get_usize(&v, "ny")?;
    let width = get_f64(&v, "domain_width")?;
    let ref_length = get_f64(&v, "ref_length")?;
    let transient = get_u64(&v, "transient")?;
    let window = get_u64(&v, "window")?;
    let note = get_str(&v, "note")?;
    if !re.is_finite() || re <= 0.0 {
        return Err(format!("cases: re must be positive finite, got {re}"));
    }
    if !(0.02..=0.12).contains(&u) {
        return Err(format!("cases: u_lattice {u} outside [0.02, 0.12]"));
    }
    if nx < 4 || ny < 4 || nx > 512 || ny > 512 || nx * ny > 262144 {
        return Err(format!("cases: bad grid {nx}x{ny}"));
    }
    if !ref_length.is_finite() || ref_length <= 0.0 {
        return Err("cases: ref_length must be positive finite".to_string());
    }
    let radius = get_opt_f64(&v, "radius")?;
    let block_width = get_opt_f64(&v, "width")?;
    let block_height = get_opt_f64(&v, "height")?;
    let naca_code = get_opt_str(&v, "naca_code")?;
    let substitutes_for = get_opt_str(&v, "substitutes_for")?;
    Ok(ResolvedCase {
        id,
        body,
        re,
        u,
        alpha_deg,
        les,
        nx,
        ny,
        width,
        radius,
        block_width,
        block_height,
        naca_code,
        ref_length,
        transient,
        window,
        substitutes_for,
        note,
        sha_version: 3,
    })
}

fn load_spec_file(path: &str) -> Result<Vec<ResolvedCase>, String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("cases: cannot read {path}: {e}"))?;
    let mut out: Vec<ResolvedCase> = Vec::new();
    for (n, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let c = parse_spec_line(line)
            .map_err(|e| format!("cases: line {}: {e}", n + 1))?;
        if out.iter().any(|x| x.id == c.id) {
            return Err(format!("cases: duplicate case_id {:?}", c.id));
        }
        out.push(c);
    }
    if out.is_empty() {
        return Err("cases: spec file holds no cases".to_string());
    }
    Ok(out)
}

fn build_grid_for(nx: usize, ny: usize, width: f64, body: &str) -> GridSpec {
    let dx = width / (nx - 1) as f64;
    let height = dx * (ny - 1) as f64;
    let (x_min, x_max) = if body == "naca0012" || body == "naca2412" || body == "naca4" {
        let x_min = 0.5 - 0.3 * width;
        (x_min, x_min + width)
    } else {
        (0.0, width)
    };
    GridSpec {
        nx,
        ny,
        domain: Domain { x_min, x_max, y_min: -height / 2.0, y_max: height / 2.0 },
    }
}

fn build_geom_for(case: &ResolvedCase, grid: &GridSpec) -> Result<GeometrySpec, String> {
    let cx30 = grid.domain.x_min + 0.3 * case.width;
    match case.body.as_str() {
        "cylinder" => Ok(GeometrySpec {
            kind: "cylinder".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: Some(case.radius.unwrap_or(0.2)),
            center: Some(Xy { x: cx30, y: 0.0 }),
            width: None,
            height: None,
            polygon: None,
        }),
        "block" => Ok(GeometrySpec {
            kind: "block".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(Xy { x: cx30, y: 0.0 }),
            width: Some(case.block_width.unwrap_or(0.4)),
            height: Some(case.block_height.unwrap_or(0.4)),
            polygon: None,
        }),
        "naca0012" | "naca2412" | "naca4" => {
            let code = if let Some(c) = case.naca_code.clone() {
                c
            } else if case.body.starts_with("naca") && case.body.len() == 8 {
                case.body[4..].to_string()
            } else {
                return Err("cases: naca body needs naca_code".to_string());
            };
            Ok(GeometrySpec {
                kind: "naca4".to_string(),
                naca: Some(naca_params_from_code(&code)?),
                chord: 1.0,
                alpha_deg: case.alpha_deg,
                n_points: 60,
                radius: None,
                center: None,
                width: None,
                height: None,
                polygon: None,
            })
        }
        "duct" => Ok(GeometrySpec {
            kind: "duct".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(Xy { x: grid.domain.x_min + case.width / 2.0, y: 0.0 }),
            width: Some(case.block_width.unwrap_or(case.width + 2.0)),
            height: Some(case.block_height.unwrap_or(0.4)),
            polygon: None,
        }),
        "orifice" => Ok(GeometrySpec {
            kind: "orifice".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(Xy { x: cx30, y: 0.0 }),
            width: Some(case.block_width.unwrap_or(0.1)),
            height: Some(case.block_height.unwrap_or(0.4)),
            polygon: None,
        }),
        _ => Err(format!("cases: unknown body {:?}", case.body)),
    }
}

/// SDF grid from the same polygons plus circles that build the mask, so
/// the sdf.f32 bin matches the obstacle channel cell for cell.
fn sdf_for_case(grid: &GridSpec, geom: &GeometrySpec) -> Result<Vec<f32>, String> {
    let polygons = build_polygons(geom)?;
    let mut circles: Vec<CircleDef> = Vec::new();
    if geom.kind == "cylinder" {
        let c = geom.center.unwrap_or(Xy { x: 0.5, y: 0.0 });
        circles.push(CircleDef { x: c.x, y: c.y, r: geom.radius.unwrap_or(0.25) });
    }
    let (sdf, _obstacle) = build_sdf_grid(&polygons, grid.nx, grid.ny, grid.domain, &circles)?;
    Ok(sdf)
}

fn write_f32_le(path: &Path, vals: &[f32]) -> std::io::Result<()> {
    let mut bytes = Vec::with_capacity(vals.len() * 4);
    for v in vals {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    fs::write(path, bytes)
}

// Minimal SHA256 over bytes, FIPS 180-4, std only. Used for the manifest
// content hash so rows can be matched to bins without new crates.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0x00);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([chunk[4 * i], chunk[4 * i + 1], chunk[4 * i + 2], chunk[4 * i + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = String::with_capacity(64);
    for v in h {
        out.push_str(&format!("{v:08x}"));
    }
    out
}

fn esc(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn fmt_f(x: f64) -> String {
    if x.is_finite() {
        format!("{x:.6}")
    } else {
        "null".to_string()
    }
}

fn json_opt_str(v: &Option<String>) -> String {
    match v {
        None => "null".to_string(),
        Some(s) => format!("\"{}\"", esc(s)),
    }
}

struct CaseResult {
    row_json: String,
    console_line: String,
    ok: bool,
}

fn run_resolved_case(case: &ResolvedCase, out_root: &Path) -> CaseResult {
    let grid = build_grid_for(case.nx, case.ny, case.width, &case.body);
    let geom = match build_geom_for(case, &grid) {
        Ok(g) => g,
        Err(e) => {
            let wall_s = 0.0;
            let row = format!(
                "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"transient\":{},\"window\":{},\"samples\":0,\"status\":\"setup_error\",\"error\":\"{}\",\"wall_s\":{:.2},\"sha_version\":{},\"ref_length\":{},\"substitutes_for\":{},\"strouhal\":null,\"shedding_freq_per_step\":null,\"explained_variance\":0,\"phase_ref_step\":null,\"harmonic_valid\":false,\"harmonic_cycles\":0,\"harmonic_samples\":0,\"harmonic_reason\":\"not_shedding\"}}",
                esc(&case.id), esc(&case.body), case.re, case.u, case.nx, case.ny, case.width,
                case.alpha_deg, case.les, case.transient, case.window, esc(&e), wall_s,
                case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for)
            );
            return CaseResult { row_json: row, console_line: format!("{} setup_error: {}", case.id, e), ok: false };
        }
    };
    let transient = case.transient;
    let window = case.window;
    let inlet = if case.body == "duct" { InletProfile::Parabolic } else { InletProfile::Uniform };
    let cfg = LbmConfig {
        u_lattice: case.u,
        re: case.re,
        cs_smag: 0.17,
        les_enabled: case.les,
        inlet,
        outlet: OutletKind::Convective,
        stats_start_step: transient,
        sample_every: 10,
        seed: 42,
        max_steps_per_call: 2048,
        harmonic: case.sha_version >= 3,
    };
    let total = transient + window;
    let t0 = Instant::now();
    let mut st = match LbmState::new(&grid, &geom, &cfg) {
        Ok(s) => s,
        Err(e) => {
            let wall_s = t0.elapsed().as_secs_f64();
            let row = format!(
                "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"transient\":{},\"window\":{},\"samples\":0,\"status\":\"setup_error\",\"error\":\"{}\",\"wall_s\":{:.2},\"sha_version\":{},\"ref_length\":{},\"substitutes_for\":{},\"strouhal\":null,\"shedding_freq_per_step\":null,\"explained_variance\":0,\"phase_ref_step\":null,\"harmonic_valid\":false,\"harmonic_cycles\":0,\"harmonic_samples\":0,\"harmonic_reason\":\"not_shedding\"}}",
                esc(&case.id), esc(&case.body), case.re, case.u, case.nx, case.ny, case.width,
                case.alpha_deg, case.les, transient, window, esc(&e), wall_s,
                case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for)
            );
            return CaseResult { row_json: row, console_line: format!("{} setup_error: {}", case.id, e), ok: false };
        }
    };
    let tau = st.params.tau;
    let ma = st.params.ma;
    let d_lat = st.params.d_lat;
    let blockage = st.params.blockage;
    let mut done = 0u64;
    let mut diverged: Option<String> = None;
    while done < total {
        let want = (total - done).min(2048);
        match st.run_steps(want) {
            Ok(rep) => {
                done += rep.steps_done;
                if rep.steps_done == 0 {
                    break;
                }
            }
            Err(e) => {
                diverged = Some(e);
                break;
            }
        }
    }
    let wall_s = t0.elapsed().as_secs_f64();
    if let Some(e) = diverged {
        let row = format!(
            "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"tau\":{},\"ma\":{},\"d_lat\":{},\"blockage\":{},\"transient\":{},\"window\":{},\"steps\":{},\"samples\":{},\"status\":\"diverged\",\"error\":\"{}\",\"wall_s\":{:.2},\"sha_version\":{},\"ref_length\":{},\"substitutes_for\":{},\"strouhal\":null,\"shedding_freq_per_step\":null,\"explained_variance\":0,\"phase_ref_step\":null,\"harmonic_valid\":false,\"harmonic_cycles\":0,\"harmonic_samples\":0,\"harmonic_reason\":\"not_shedding\",\"note\":\"{}\"}}",
            esc(&case.id), esc(&case.body), case.re, case.u, case.nx, case.ny, case.width,
            case.alpha_deg, case.les, fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
            transient, window, st.step, st.stats.samples, esc(&e), wall_s,
            case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for), esc(&case.note)
        );
        return CaseResult { row_json: row, console_line: format!("{} DIVERGED at step {} ({}), wall {:.1}s", case.id, st.step, e, wall_s), ok: false };
    }
    let full = st.force_summary(transient);
    if std::env::var("GEARFLOW_DUMP_CL").is_ok() {
        let mut txt = String::new();
        let hs = st.force.history_steps();
        let hc = st.force.cl_history();
        for (s, c) in hs.iter().zip(hc.iter()) {
            txt.push_str(&format!("{s} {c:.6}\n"));
        }
        let _ = fs::write(format!("/tmp/harmfix/cl_{}.txt", case.id), txt);
    }
    let mut tails: Vec<(u64, f64)> = Vec::new();
    let mut tt = transient;
    while tt < total {
        let s = st.force_summary(tt);
        tails.push((tt, s.mean_cd));
        tt += 4000;
    }
    let tails_json = tails.iter().map(|(a, c)| format!("[{a},{c:.4}]")).collect::<Vec<_>>().join(",");
    let st_val = st.strouhal(transient).ok();
    let st_json = match st_val {
        Some(v) if v.is_finite() => format!("{v:.5}"),
        _ => "null".to_string(),
    };
    let samples = st.stats.samples;
    let v3 = case.sha_version >= 3;
    // v3 adds the four harmonic bins after the existing eight. The
    // pilot path keeps the legacy six channel call so the eight bin
    // prefix stays byte identical.
    let (mu, mv, mp, tke, wm, rm, harm) = if v3 {
        st.stats_dataset_fields_v3()
    } else {
        let (a, b, c, d, e, f) = st.stats_dataset_fields();
        (a, b, c, d, e, f, HarmonicResult::zeros(case.nx * case.ny))
    };
    let shed_json = match st_val {
        Some(v) if v.is_finite() => {
            let shed = v * case.u / d_lat;
            if shed.is_finite() {
                format!("{shed:.6}")
            } else {
                "null".to_string()
            }
        }
        _ => "null".to_string(),
    };
    let phase_json = match harm.phase_ref_step {
        Some(s) => format!("{s}"),
        None => "null".to_string(),
    };
    let harm_valid_json = if harm.valid { "true" } else { "false" };
    let harm_reason = harm.reason.clone();
    let snap = st.snapshot();
    let sdf = match sdf_for_case(&grid, &geom) {
        Ok(s) => s,
        Err(e) => {
            let row = format!(
                "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"transient\":{},\"window\":{},\"samples\":{},\"status\":\"setup_error\",\"error\":\"sdf: {}\",\"wall_s\":{:.2},\"sha_version\":{},\"ref_length\":{},\"substitutes_for\":{},\"strouhal\":null,\"shedding_freq_per_step\":null,\"explained_variance\":0,\"phase_ref_step\":null,\"harmonic_valid\":false,\"harmonic_cycles\":0,\"harmonic_samples\":0,\"harmonic_reason\":\"not_shedding\"}}",
                esc(&case.id), esc(&case.body), case.re, case.u, case.nx, case.ny, case.width,
                case.alpha_deg, case.les, transient, window, samples, esc(&e), wall_s,
                case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for)
            );
            return CaseResult { row_json: row, console_line: format!("{} setup_error: sdf: {}", case.id, e), ok: false };
        }
    };
    let case_dir = out_root.join(&case.id);
    let _ = fs::create_dir_all(&case_dir);
    let base_files: [(&str, &Vec<f32>); 8] = [
        ("umean.f32", &mu),
        ("vmean.f32", &mv),
        ("pmean.f32", &mp),
        ("omegamean.f32", &wm),
        ("tke.f32", &tke),
        ("recirc.f32", &rm),
        ("obstacle.f32", &snap.obstacle),
        ("sdf.f32", &sdf),
    ];
    for (name, vals) in base_files.iter() {
        let _ = write_f32_le(&case_dir.join(name), vals);
    }
    if v3 {
        let harm_files: [(&str, &Vec<f32>); 4] = [
            ("ucos.f32", &harm.u_cos),
            ("usin.f32", &harm.u_sin),
            ("vcos.f32", &harm.v_cos),
            ("vsin.f32", &harm.v_sin),
        ];
        for (name, vals) in harm_files.iter() {
            let _ = write_f32_le(&case_dir.join(name), vals);
        }
    }
    let hash_bins: Vec<&Vec<f32>> = if v3 {
        vec![
            &mu, &mv, &mp, &wm, &tke, &rm, &snap.obstacle, &sdf,
            &harm.u_cos, &harm.u_sin, &harm.v_cos, &harm.v_sin,
        ]
    } else if case.sha_version >= 2 {
        vec![&mu, &mv, &mp, &wm, &tke, &rm, &snap.obstacle, &sdf]
    } else {
        vec![&mu, &mv, &mp, &wm, &tke, &rm, &snap.obstacle]
    };
    let mut hash_input: Vec<u8> = Vec::new();
    for vals in hash_bins {
        for v in vals.iter() {
            hash_input.extend_from_slice(&v.to_le_bytes());
        }
    }
    let sha = sha256_hex(&hash_input);
    let meta = format!(
        "{{\n  \"case_id\": \"{}\",\n  \"body\": \"{}\",\n  \"re\": {},\n  \"u_lattice\": {},\n  \"alpha_deg\": {},\n  \"les\": {},\n  \"nx\": {},\n  \"ny\": {},\n  \"x_min\": {:.6},\n  \"x_max\": {:.6},\n  \"y_min\": {:.6},\n  \"y_max\": {:.6},\n  \"transient\": {},\n  \"window\": {},\n  \"steps\": {},\n  \"samples\": {},\n  \"tau\": {},\n  \"ma\": {},\n  \"d_lat\": {},\n  \"blockage\": {},\n  \"cd_mean\": {:.4},\n  \"cl_mean\": {:.4},\n  \"cl_amp\": {:.4},\n  \"strouhal\": {},\n  \"shedding_freq_per_step\": {},\n  \"explained_variance\": {:.6},\n  \"phase_ref_step\": {},\n  \"harmonic_valid\": {},\n  \"harmonic_cycles\": {},\n  \"harmonic_samples\": {},\n  \"harmonic_reason\": \"{}\",\n  \"wall_s\": {:.2},\n  \"sha256\": \"{}\",\n  \"sha_version\": {},\n  \"ref_length\": {},\n  \"substitutes_for\": {},\n  \"note\": \"{}\"\n}}\n",
        esc(&case.id), esc(&case.body), case.re, case.u, case.alpha_deg, case.les,
        case.nx, case.ny, grid.domain.x_min, grid.domain.x_max, grid.domain.y_min, grid.domain.y_max,
        transient, window, st.step, samples,
        fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
        full.mean_cd, full.mean_cl, full.amplitude_cl, st_json, shed_json, harm.explained_variance,
        phase_json, harm_valid_json, harm.cycles, harm.samples, esc(&harm_reason), wall_s, sha,
        case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for), esc(&case.note)
    );
    let _ = fs::write(case_dir.join("meta.json"), meta.as_bytes());
    let row = format!(
        "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"alpha_deg\":{},\"les\":{},\"nx\":{},\"ny\":{},\"width\":{},\"tau\":{},\"ma\":{},\"d_lat\":{},\"blockage\":{},\"transient\":{},\"window\":{},\"steps\":{},\"samples\":{},\"cd_mean\":{:.4},\"cl_mean\":{:.4},\"cl_amp\":{:.4},\"tail_cd_blocks\":[{}],\"strouhal\":{},\"shedding_freq_per_step\":{},\"explained_variance\":{:.6},\"phase_ref_step\":{},\"harmonic_valid\":{},\"harmonic_cycles\":{},\"harmonic_samples\":{},\"harmonic_reason\":\"{}\",\"status\":\"completed\",\"wall_s\":{:.2},\"sha256\":\"{}\",\"sha_version\":{},\"ref_length\":{},\"substitutes_for\":{},\"note\":\"{}\"}}",
        esc(&case.id), esc(&case.body), case.re, case.u, case.alpha_deg, case.les,
        case.nx, case.ny, case.width, fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
        transient, window, st.step, samples,
        full.mean_cd, full.mean_cl, full.amplitude_cl, tails_json, st_json, shed_json,
        harm.explained_variance, phase_json, harm_valid_json, harm.cycles, harm.samples, esc(&harm_reason),
        wall_s, sha,
        case.sha_version, case.ref_length, json_opt_str(&case.substitutes_for), esc(&case.note)
    );
    let st_txt = match st_val {
        Some(v) => format!("{v:.5}"),
        None => "null".to_string(),
    };
    let line = format!(
        "{} completed: Cd {:.4} Cl {:.4} amp {:.3} St {} tau {:.4} D_lat {:.2} B {:.2}pct samples {} wall {:.1}s",
        case.id, full.mean_cd, full.mean_cl, full.amplitude_cl, st_txt, tau, d_lat,
        blockage * 100.0, samples, wall_s
    );
    CaseResult { row_json: row, console_line: line, ok: true }
}

fn run_case(case: &PilotCase, out_root: &Path, transient: u64, window: u64) -> CaseResult {
    let resolved = resolved_from_pilot(case, transient, window);
    run_resolved_case(&resolved, out_root)
}

fn print_usage() {
    eprintln!("dataset_pilot: native Phase C pilot sweep");
    eprintln!("usage: dataset_pilot [options]");
    eprintln!("options: out DIR, transient N, window N, only CASE_ID, list, cases FILE, manifest_out FILE");
    eprintln!("defaults: out data/pilot, transient 8000, window 12000");
    eprintln!("cases: CaseSpecV1 JSON lines (case_id, body, re, u_lattice, alpha_deg, les, nx, ny, domain_width, radius/width/height/naca_code or null, ref_length, transient, window, substitutes_for or null, note)");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut out = String::from("data/pilot");
    let mut transient = 8000u64;
    let mut window = 12000u64;
    let mut only: Option<String> = None;
    let mut cases_path: Option<String> = None;
    let mut manifest_out: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "list" => {
                if let Some(ref p) = cases_path {
                    match load_spec_file(p) {
                        Ok(cs) => {
                            for c in cs {
                                println!("{}", c.id);
                            }
                        }
                        Err(e) => {
                            eprintln!("dataset_pilot: {e}");
                            std::process::exit(2);
                        }
                    }
                } else {
                    for c in pilot_cases() {
                        println!("{}", c.id);
                    }
                }
                return;
            }
            "help" => {
                print_usage();
                return;
            }
            "out" => {
                i += 1;
                if i < args.len() {
                    out = args[i].clone();
                }
            }
            "transient" => {
                i += 1;
                if i < args.len() {
                    transient = args[i].parse().unwrap_or(8000);
                }
            }
            "window" => {
                i += 1;
                if i < args.len() {
                    window = args[i].parse().unwrap_or(12000);
                }
            }
            "only" => {
                i += 1;
                if i < args.len() {
                    only = Some(args[i].clone());
                }
            }
            "cases" => {
                i += 1;
                if i < args.len() {
                    cases_path = Some(args[i].clone());
                }
            }
            "manifest_out" => {
                i += 1;
                if i < args.len() {
                    manifest_out = Some(args[i].clone());
                }
            }
            _ => {
                if args[i].starts_with("out=") {
                    out = args[i]["out=".len()..].to_string();
                } else if args[i].starts_with("only=") {
                    only = Some(args[i]["only=".len()..].to_string());
                } else if args[i].starts_with("cases=") {
                    cases_path = Some(args[i]["cases=".len()..].to_string());
                } else if args[i].starts_with("manifest_out=") {
                    manifest_out = Some(args[i]["manifest_out=".len()..].to_string());
                } else if args[i].starts_with("transient=") {
                    transient = args[i]["transient=".len()..].parse().unwrap_or(8000);
                } else if args[i].starts_with("window=") {
                    window = args[i]["window=".len()..].parse().unwrap_or(12000);
                }
            }
        }
        i += 1;
    }
    if let Some(spec_path) = cases_path {
        let all = match load_spec_file(&spec_path) {
            Ok(cs) => cs,
            Err(e) => {
                eprintln!("dataset_pilot: {e}");
                std::process::exit(2);
            }
        };
        let selected: Vec<ResolvedCase> = match &only {
            Some(id) => all.into_iter().filter(|c| &c.id == id).collect(),
            None => all,
        };
        if selected.is_empty() {
            eprintln!("dataset_pilot: no matching cases");
            std::process::exit(2);
        }
        let out_root = PathBuf::from(&out);
        let _ = fs::create_dir_all(&out_root);
        println!("dataset_pilot: {} spec cases out {} spec {}", selected.len(), out, spec_path);
        let t0 = Instant::now();
        let mut rows: Vec<String> = Vec::new();
        let mut ok_count = 0usize;
        for case in &selected {
            let res = run_resolved_case(case, &out_root);
            println!("{}", res.console_line);
            if res.ok {
                ok_count += 1;
            }
            rows.push(res.row_json);
        }
        let manifest = rows.join("\n") + "\n";
        let manifest_path = out_root.join("manifest.jsonl");
        if let Err(e) = fs::write(&manifest_path, manifest.as_bytes()) {
            eprintln!("dataset_pilot: manifest write failed: {e}");
            std::process::exit(1);
        }
        if let Some(frag) = manifest_out {
            if let Err(e) = fs::write(&frag, manifest.as_bytes()) {
                eprintln!("dataset_pilot: manifest_out write failed: {e}");
                std::process::exit(1);
            }
        }
        let total_s = t0.elapsed().as_secs_f64();
        println!("dataset_pilot: {ok_count}/{} completed, manifest {}, total wall {:.1}s", selected.len(), manifest_path.display(), total_s);
        return;
    }
    let all = pilot_cases();
    let selected: Vec<PilotCase> = match &only {
        Some(id) => all.into_iter().filter(|c| c.id == id.as_str()).collect(),
        None => all,
    };
    if selected.is_empty() {
        eprintln!("dataset_pilot: no matching cases");
        std::process::exit(2);
    }
    let out_root = PathBuf::from(&out);
    let _ = fs::create_dir_all(&out_root);
    println!("dataset_pilot: {} cases, transient {} window {} out {}", selected.len(), transient, window, out);
    let t0 = Instant::now();
    let mut rows: Vec<String> = Vec::new();
    let mut ok_count = 0usize;
    for case in &selected {
        let res = run_case(case, &out_root, transient, window);
        println!("{}", res.console_line);
        if res.ok {
            ok_count += 1;
        }
        rows.push(res.row_json);
    }
    let manifest = rows.join("\n") + "\n";
    let manifest_path = out_root.join("manifest.jsonl");
    if let Err(e) = fs::write(&manifest_path, manifest.as_bytes()) {
        eprintln!("dataset_pilot: manifest write failed: {e}");
        std::process::exit(1);
    }
    if let Some(frag) = manifest_out {
        if let Err(e) = fs::write(&frag, manifest.as_bytes()) {
            eprintln!("dataset_pilot: manifest_out write failed: {e}");
            std::process::exit(1);
        }
    }
    let total_s = t0.elapsed().as_secs_f64();
    println!("dataset_pilot: {ok_count}/{} completed, manifest {}, total wall {:.1}s", selected.len(), manifest_path.display(), total_s);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_line() -> String {
        "{\"case_id\":\"cyl_r020_re020\",\"body\":\"cylinder\",\"re\":20.0,\"u_lattice\":0.06,\"alpha_deg\":0.0,\"les\":false,\"nx\":160,\"ny\":128,\"domain_width\":4.0,\"radius\":0.2,\"width\":null,\"height\":null,\"naca_code\":null,\"ref_length\":0.4,\"transient\":8000,\"window\":12000,\"substitutes_for\":null,\"note\":\"probe\"}".to_string()
    }

    #[test]
    fn spec_parses_all_fields() {
        let c = parse_spec_line(&spec_line()).unwrap();
        assert_eq!(c.id, "cyl_r020_re020");
        assert_eq!(c.body, "cylinder");
        assert!((c.re - 20.0).abs() < 1e-12);
        assert!((c.u - 0.06).abs() < 1e-12);
        assert_eq!(c.nx, 160);
        assert_eq!(c.ny, 128);
        assert!((c.width - 4.0).abs() < 1e-12);
        assert_eq!(c.radius, Some(0.2));
        assert_eq!(c.block_width, None);
        assert_eq!(c.naca_code, None);
        assert!((c.ref_length - 0.4).abs() < 1e-12);
        assert_eq!(c.transient, 8000);
        assert_eq!(c.window, 12000);
        assert_eq!(c.substitutes_for, None);
        assert_eq!(c.sha_version, 3);
    }

    #[test]
    fn spec_rejects_bad_json_and_bad_values() {
        assert!(parse_spec_line("not json").is_err());
        assert!(parse_spec_line("{\"case_id\":\"x\"}").is_err());
        let bad_u = spec_line().replace("0.06", "0.5");
        assert!(parse_spec_line(&bad_u).is_err());
        let bad_grid = spec_line().replace("\"nx\":160", "\"nx\":2");
        assert!(parse_spec_line(&bad_grid).is_err());
    }

    #[test]
    fn spec_substitute_and_naca_code_parse() {
        let line = "{\"case_id\":\"cyl_r020_re060\",\"body\":\"cylinder\",\"re\":60.0,\"u_lattice\":0.06,\"alpha_deg\":0.0,\"les\":false,\"nx\":160,\"ny\":128,\"domain_width\":4.0,\"radius\":0.2,\"width\":null,\"height\":null,\"naca_code\":null,\"ref_length\":0.4,\"transient\":8000,\"window\":12000,\"substitutes_for\":\"cyl_r020_re100\",\"note\":\"sub\"}";
        let c = parse_spec_line(line).unwrap();
        assert_eq!(c.substitutes_for, Some("cyl_r020_re100".to_string()));
        let naca = naca_params_from_code("2412").unwrap();
        assert!((naca.m - 0.02).abs() < 1e-12);
        assert!((naca.p - 0.4).abs() < 1e-12);
        assert!((naca.t - 0.12).abs() < 1e-12);
        assert!(naca_params_from_code("12").is_err());
    }

    #[test]
    fn sdf_bin_matches_mask_length() {
        let case = parse_spec_line(&spec_line()).unwrap();
        let grid = build_grid_for(case.nx, case.ny, case.width, &case.body);
        let geom = build_geom_for(&case, &grid).unwrap();
        let sdf = sdf_for_case(&grid, &geom).unwrap();
        assert_eq!(sdf.len(), case.nx * case.ny);
        assert!(sdf.iter().all(|v| v.is_finite()));
        assert!(sdf.iter().any(|v| *v < 0.0));
        assert!(sdf.iter().any(|v| *v > 0.0));
    }

    #[test]
    fn runner_v3_contract_twelve_bins_and_meta() {
        // Short steady cylinder case: 300 steps on a 48 by 40 grid.
        // Harmonic stays invalid on a steady run, but the export still
        // carries twelve bins, typed meta fields, and a sha v3 that
        // recomputes from the bins in order.
        let case = ResolvedCase {
            id: "contract_small".to_string(),
            body: "cylinder".to_string(),
            re: 20.0,
            u: 0.06,
            alpha_deg: 0.0,
            les: false,
            nx: 48,
            ny: 40,
            width: 2.0,
            radius: Some(0.2),
            block_width: None,
            block_height: None,
            naca_code: None,
            ref_length: 0.4,
            transient: 100,
            window: 200,
            substitutes_for: None,
            note: "contract probe".to_string(),
            sha_version: 3,
        };
        let out_root = std::env::temp_dir()
            .join(format!("gearflow_contract_{}", std::process::id()));
        let _ = fs::create_dir_all(&out_root);
        let res = run_resolved_case(&case, &out_root);
        assert!(res.ok, "console: {}", res.console_line);
        let dir = out_root.join(&case.id);
        let names = [
            "umean.f32",
            "vmean.f32",
            "pmean.f32",
            "omegamean.f32",
            "tke.f32",
            "recirc.f32",
            "obstacle.f32",
            "sdf.f32",
            "ucos.f32",
            "usin.f32",
            "vcos.f32",
            "vsin.f32",
        ];
        let cells = case.nx * case.ny;
        let mut hash_input: Vec<u8> = Vec::new();
        let mut bins: Vec<Vec<f32>> = Vec::new();
        for nm in names {
            let bytes = fs::read(dir.join(nm)).unwrap_or_else(|_| panic!("missing bin {nm}"));
            assert_eq!(bytes.len(), cells * 4, "size {nm}");
            hash_input.extend_from_slice(&bytes);
            let mut vals = Vec::with_capacity(cells);
            for chunk in bytes.chunks_exact(4) {
                vals.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
            }
            bins.push(vals);
        }
        // Solid cells read exactly zero on the harmonic bins.
        let obstacle = &bins[6];
        for (k, harm) in [&bins[8], &bins[9], &bins[10], &bins[11]].iter().enumerate() {
            for (kk, val) in harm.iter().enumerate() {
                assert!(val.is_finite(), "harm {k} nonfinite at {kk}");
                if obstacle[kk] > 0.5 {
                    assert_eq!(*val, 0.0, "harm {k} nonzero on solid at {kk}");
                }
            }
        }
        let meta_text = fs::read_to_string(dir.join("meta.json")).unwrap();
        let meta: serde_json::Value = serde_json::from_str(&meta_text).unwrap();
        let sha_hex = sha256_hex(&hash_input);
        assert_eq!(meta["sha_version"], serde_json::json!(3));
        assert_eq!(meta["sha256"], serde_json::json!(sha_hex));
        assert!(meta["strouhal"].is_null() || meta["strouhal"].is_number());
        assert!(meta["shedding_freq_per_step"].is_null() || meta["shedding_freq_per_step"].is_number());
        assert!(meta["explained_variance"].is_number());
        assert!(meta["phase_ref_step"].is_null() || meta["phase_ref_step"].is_u64());
        assert!(meta["harmonic_valid"].is_boolean());
        assert!(meta["harmonic_cycles"].is_u64());
        assert!(meta["harmonic_samples"].is_u64());
        assert!(meta["harmonic_reason"].is_string());
        let row: serde_json::Value = serde_json::from_str(&res.row_json).unwrap();
        assert_eq!(row["sha_version"], serde_json::json!(3));
        assert_eq!(row["sha256"], serde_json::json!(sha_hex));
        assert_eq!(row["harmonic_valid"], serde_json::json!(false));
        assert!(row["harmonic_cycles"].is_u64());
        assert!(row["harmonic_samples"].is_u64());
        assert!(row["harmonic_reason"].is_string());
        assert!(row["explained_variance"].is_number());
        assert!(row["phase_ref_step"].is_null() || row["phase_ref_step"].is_u64());
        let _ = fs::remove_dir_all(&out_root);
    }
}
