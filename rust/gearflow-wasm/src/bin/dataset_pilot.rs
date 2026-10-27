// Native Phase C dataset pilot runner. Calls LbmState directly with no
// WASM and no worker. Deterministic seed 42, sample_every 10. Writes raw
// little endian float32 bins plus a JSON sidecar per case and one manifest
// JSONL row per case. Zero new crates, std only plus the lib itself.

use gearflow_wasm::boundaries::{InletProfile, OutletKind};
use gearflow_wasm::lbm::{LbmConfig, LbmState};
use gearflow_wasm::types::{Domain, GeometrySpec, GridSpec, NacaParams, Xy};
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

fn build_grid(case: &PilotCase) -> GridSpec {
    let dx = case.width / (case.nx - 1) as f64;
    let height = dx * (case.ny - 1) as f64;
    let (x_min, x_max) = if case.body == "naca0012" || case.body == "naca2412" {
        let x_min = 0.5 - 0.3 * case.width;
        (x_min, x_min + case.width)
    } else {
        (0.0, case.width)
    };
    GridSpec {
        nx: case.nx,
        ny: case.ny,
        domain: Domain { x_min, x_max, y_min: -height / 2.0, y_max: height / 2.0 },
    }
}

fn build_geom(case: &PilotCase, grid: &GridSpec) -> GeometrySpec {
    let cx30 = grid.domain.x_min + 0.3 * case.width;
    match case.body {
        "cylinder" => GeometrySpec {
            kind: "cylinder".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: Some(0.2),
            center: Some(Xy { x: cx30, y: 0.0 }),
            width: None,
            height: None,
            polygon: None,
        },
        "block" => GeometrySpec {
            kind: "block".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(Xy { x: cx30, y: 0.0 }),
            width: Some(0.4),
            height: Some(0.4),
            polygon: None,
        },
        "naca0012" => GeometrySpec {
            kind: "naca4".to_string(),
            naca: Some(NacaParams { code: "0012".to_string(), m: 0.0, p: 0.0, t: 0.12 }),
            chord: 1.0,
            alpha_deg: case.alpha_deg,
            n_points: 60,
            radius: None,
            center: None,
            width: None,
            height: None,
            polygon: None,
        },
        "naca2412" => GeometrySpec {
            kind: "naca4".to_string(),
            naca: Some(NacaParams { code: "2412".to_string(), m: 0.02, p: 0.4, t: 0.12 }),
            chord: 1.0,
            alpha_deg: case.alpha_deg,
            n_points: 60,
            radius: None,
            center: None,
            width: None,
            height: None,
            polygon: None,
        },
        "duct" => GeometrySpec {
            // Plate length spans past the inlet and outlet so the wall
            // leading edge sits upstream of the inlet plane, mirroring the
            // Poiseuille validation fixture. A plate cut exactly at the
            // inlet plane puts a sharp corner on the Zou He column and the
            // run poisons at the first stability scan.
            kind: "duct".to_string(),
            naca: None,
            chord: 1.0,
            alpha_deg: 0.0,
            n_points: 64,
            radius: None,
            center: Some(Xy { x: grid.domain.x_min + case.width / 2.0, y: 0.0 }),
            width: Some(case.width + 2.0),
            height: Some(0.4),
            polygon: None,
        },
        _ => panic!("unknown pilot body"),
    }
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

struct CaseResult {
    row_json: String,
    console_line: String,
    ok: bool,
}

fn run_case(case: &PilotCase, out_root: &Path, transient: u64, window: u64) -> CaseResult {
    let grid = build_grid(case);
    let geom = build_geom(case, &grid);
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
    };
    let total = transient + window;
    let t0 = Instant::now();
    let mut st = match LbmState::new(&grid, &geom, &cfg) {
        Ok(s) => s,
        Err(e) => {
            let wall_s = t0.elapsed().as_secs_f64();
            let row = format!(
                "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"transient\":{},\"window\":{},\"samples\":0,\"status\":\"setup_error\",\"error\":\"{}\",\"wall_s\":{:.2}}}",
                esc(case.id), esc(case.body), case.re, case.u, case.nx, case.ny, case.width,
                case.alpha_deg, case.les, transient, window, esc(&e), wall_s
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
            "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"nx\":{},\"ny\":{},\"width\":{},\"alpha_deg\":{},\"les\":{},\"tau\":{},\"ma\":{},\"d_lat\":{},\"blockage\":{},\"transient\":{},\"window\":{},\"steps\":{},\"samples\":{},\"status\":\"diverged\",\"error\":\"{}\",\"wall_s\":{:.2},\"note\":\"{}\"}}",
            esc(case.id), esc(case.body), case.re, case.u, case.nx, case.ny, case.width,
            case.alpha_deg, case.les, fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
            transient, window, st.step, st.stats.samples, esc(&e), wall_s, esc(case.note)
        );
        return CaseResult { row_json: row, console_line: format!("{} DIVERGED at step {} ({}), wall {:.1}s", case.id, st.step, e, wall_s), ok: false };
    }
    let full = st.force_summary(transient);
    let mut tails: Vec<(u64, f64)> = Vec::new();
    let mut tt = transient;
    while tt < total {
        let s = st.force_summary(tt);
        tails.push((tt, s.mean_cd));
        tt += 4000;
    }
    let tails_json = tails.iter().map(|(a, c)| format!("[{a},{:.4}]", c)).collect::<Vec<_>>().join(",");
    let st_val = st.strouhal(transient).ok();
    let st_json = match st_val {
        Some(v) if v.is_finite() => format!("{v:.5}"),
        _ => "null".to_string(),
    };
    let samples = st.stats.samples;
    let (mu, mv, mp, tke, wm, rm) = st.stats_dataset_fields();
    let snap = st.snapshot();
    let case_dir = out_root.join(case.id);
    let _ = fs::create_dir_all(&case_dir);
    let files: [(&str, &Vec<f32>); 7] = [
        ("umean.f32", &mu),
        ("vmean.f32", &mv),
        ("pmean.f32", &mp),
        ("omegamean.f32", &wm),
        ("tke.f32", &tke),
        ("recirc.f32", &rm),
        ("obstacle.f32", &snap.obstacle),
    ];
    for (name, vals) in files {
        let _ = write_f32_le(&case_dir.join(name), vals);
    }
    let mut hash_input: Vec<u8> = Vec::new();
    for (_, vals) in files {
        for v in vals {
            hash_input.extend_from_slice(&v.to_le_bytes());
        }
    }
    let sha = sha256_hex(&hash_input);
    let dx = grid.domain.x_max - grid.domain.x_min;
    let _ = dx;
    let meta = format!(
        "{{\n  \"case_id\": \"{}\",\n  \"body\": \"{}\",\n  \"re\": {},\n  \"u_lattice\": {},\n  \"alpha_deg\": {},\n  \"les\": {},\n  \"nx\": {},\n  \"ny\": {},\n  \"x_min\": {:.6},\n  \"x_max\": {:.6},\n  \"y_min\": {:.6},\n  \"y_max\": {:.6},\n  \"transient\": {},\n  \"window\": {},\n  \"steps\": {},\n  \"samples\": {},\n  \"tau\": {},\n  \"ma\": {},\n  \"d_lat\": {},\n  \"blockage\": {},\n  \"cd_mean\": {:.4},\n  \"cl_mean\": {:.4},\n  \"cl_amp\": {:.4},\n  \"strouhal\": {},\n  \"wall_s\": {:.2},\n  \"sha256\": \"{}\",\n  \"note\": \"{}\"\n}}\n",
        esc(case.id), esc(case.body), case.re, case.u, case.alpha_deg, case.les,
        case.nx, case.ny, grid.domain.x_min, grid.domain.x_max, grid.domain.y_min, grid.domain.y_max,
        transient, window, st.step, samples,
        fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
        full.mean_cd, full.mean_cl, full.amplitude_cl, st_json, wall_s, sha, esc(case.note)
    );
    let _ = fs::write(case_dir.join("meta.json"), meta.as_bytes());
    let row = format!(
        "{{\"case_id\":\"{}\",\"body\":\"{}\",\"re\":{},\"u_lattice\":{},\"alpha_deg\":{},\"les\":{},\"nx\":{},\"ny\":{},\"width\":{},\"tau\":{},\"ma\":{},\"d_lat\":{},\"blockage\":{},\"transient\":{},\"window\":{},\"steps\":{},\"samples\":{},\"cd_mean\":{:.4},\"cl_mean\":{:.4},\"cl_amp\":{:.4},\"tail_cd_blocks\":[{}],\"strouhal\":{},\"status\":\"completed\",\"wall_s\":{:.2},\"sha256\":\"{}\",\"note\":\"{}\"}}",
        esc(case.id), esc(case.body), case.re, case.u, case.alpha_deg, case.les,
        case.nx, case.ny, case.width, fmt_f(tau), fmt_f(ma), fmt_f(d_lat), fmt_f(blockage),
        transient, window, st.step, samples,
        full.mean_cd, full.mean_cl, full.amplitude_cl, tails_json, st_json, wall_s, sha, esc(case.note)
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

fn print_usage() {
    eprintln!("dataset_pilot: native Phase C pilot sweep");
    eprintln!("usage: dataset_pilot [options]");
    eprintln!("options: out DIR, transient N, window N, only CASE_ID, list");
    eprintln!("defaults: out data/pilot, transient 8000, window 12000");
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut out = String::from("data/pilot");
    let mut transient = 8000u64;
    let mut window = 12000u64;
    let mut only: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "list" => {
                for c in pilot_cases() {
                    println!("{}", c.id);
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
            _ => {
                if args[i].starts_with("out=") {
                    out = args[i]["out=".len()..].to_string();
                } else if args[i].starts_with("only=") {
                    only = Some(args[i]["only=".len()..].to_string());
                }
            }
        }
        i += 1;
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
    let total_s = t0.elapsed().as_secs_f64();
    println!("dataset_pilot: {}/{} completed, manifest {}, total wall {:.1}s", ok_count, selected.len(), manifest_path.display(), total_s);
}
