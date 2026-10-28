# Modal LBM Sweep and v3 Training Runbook (sweep01)

## QUESTIONS FOR USER
- Q1: Confirm the exact volume get path for sweep workers on your Modal account, since only the volume name (gearflow-sweep) and mount (/sweep) are pinned in code.

## 0 Preconditions (do these first, in this order)
| # | Check | How |
|---|-------|-----|
| 1 | Modal profile authenticated locally | `modal profile list` shows your profile, agents never run this |
| 2 | No secrets in the repo | `grep -r API_KEY . --exclude-dir=.git` returns nothing sensitive, keys live in env only |
| 3 | Python env via uv | `uv sync` passes in `training/` |
| 4 | Rust release binary builds | `cargo build --locked --release --manifest-path rust/gearflow-wasm/Cargo.toml --bin dataset_pilot` passes |
| 5 | Spec generated but not yet uploaded | `data/sweep/sweep01/cases.jsonl` exists, no upload yet |

Agents never run Modal commands. Every command below is yours, by hand, from the repo root.

## 1 Spec
```sh
uv run --project training python training/make_sweep_spec_v2.py sweep01
```
Expected output: 71 cases (BGK 12, LES 12, airfoil 47) plus min tau 0.505407 at `naca0012_a00_re1200_airfoil`. The generator refuses to write if any row breaches the 0.505 tau floor. Bluff rows use 160 by 128 over width 4.0 with transient 8000. Airfoil rows use 384 by 192 over width 2.55 with transient 16000. Window is 12000 everywhere. Alpha 12 is excluded everywhere. Output path: `data/sweep/sweep01/cases.jsonl`. Two LES cells are removed by design after divergence was confirmed: `cyl_r020_a00_re100_les` (diverges near step 4800, also at lower drive near step 6272) and `block_040_a00_re200_les` (diverges near step 4470).

## 2a Upload analytic plus spec (before sweep, dry run first)
```sh
uv run --project training python training/modal_upload.py --sweep-id sweep01 --dry-run
uv run --project training python training/modal_upload.py --sweep-id sweep01
```
All or nothing plan: analytic `manifest.jsonl` plus `train/` shards, and sweep `manifest.jsonl` plus `cases/`. Any validation error yields zero entries. Measured totals: analytic about 1.5 GB, sweep 71 cases at an estimated 70 to 90 MB depending on grid mix. Analytic samples carry recirculation on channel 5 with harmonic channels 6 through 9 set to zero. On volume conflict, rerun with force enabled (see section 11).

## 2b Upload LBM only (after merge plus gate, before finetune, dry run first)
```sh
uv run --project training python training/modal_upload.py --sweep-id sweep01 --only lbm --dry-run
uv run --project training python training/modal_upload.py --sweep-id sweep01 --only lbm
```
```sh
uv run --project training python training/modal_upload.py --sweep-id sweep01 --kind lbm --dry-run
uv run --project training python training/modal_upload.py --sweep-id sweep01 --kind lbm
```
This step uploads only `data/lbm/<sweep_id>/` after merge and gate. It requires `merge_report.json` status ok and validates bins plus sha. Run it after sections 4 and 5 pass and before section 7. The kind form above is equivalent to the only form. Dry run first every time.

## 3 Sweep (paid CPU)
```sh
uv run --project training modal run training/modal_sweep.py --sweep-id sweep01
```
Expected wall time from measured local runs: 18s per 160 by 128 case and 68s per 384 by 192 case, so 71 cases across 16 containers is roughly 5 to 9 minutes plus a one time Rust image build. Each case runs on its own container (4 vCPU, 4096 MiB, 1800s timeout). Diverged cases are recorded as data, never retried, never substituted.

## 4 Download and merge
```sh
modal volume get gearflow-sweep runs/sweep01/workers data/sweep/sweep01/workers
uv run --project training python training/merge_sweep.py sweep01
```
Merge is fail closed: on any missing id, sha or size mismatch, non finite value, or conflicting duplicate rows, no manifest and no cases are written. Only `merge_report.json` is written and the process exits 2. On success, outputs land at `data/lbm/sweep01/` with `manifest.jsonl` in spec order, `cases/`, and `merge_report.json`. Diverged and `setup_error` rows are expected and preserved verbatim.

## 5 Gate (spend no GPU before this passes)
```sh
uv run --project training python training/verify_lbm_dataset.py data/lbm/sweep01
```
Report goes to a temp dir by default and the sweep directory is never modified. To choose the report location, use the out option with a directory value (see script help). Floors are enforced in code. Exit 0 means train approved and requires no data failures, no adapter failures, valid count at least 20, and median explained at least 0.45. Floor shortfall returns exit 2 with status needs more harmonics. Adapter failure precedence for exit 3 is kept. Read `harmonic_valid_count` and `harmonic_valid_median_explained` in `verify_report.json`. Header range is V0 to V8. The v3 cache verifier accepts sha versions 1, 2, and 3 through merge bin order.

## 6 Pretrain only
```sh
uv run --project training modal run training/modal_train.py --action pretrain
```
Expected 20 to 40 minutes on A10G. Artifacts land under `training/checkpoints/v3/<run_id>/pretrain/` with `best.pt`, `norm.json`, `run_log.json`. Before continuing, check `run_log.json`: status is ok, `bestComposite` trends down across epochs, `gpuActual` is recorded, sample counts match the analytic split.

## 7 Fine tune only
```sh
uv run --project training modal run training/modal_train.py --action finetune
```
Guard fails closed without a pretrain checkpoint for the same run id. Defaults are 200 epochs at batch 8. The harmonic capability flag requires at least 8 valid harmonic train cases plus at least one completed epoch.

## 8 Export and goldens
```sh
uv run --project training python training/export_onnx.py --arch unet-v3 --run-id <run_id>
uv run --project training python training/make_golden.py --arch unet-v3 --run-id <run_id>
```
Export writes `public/surrogate/v3/model.onnx` plus a `norm.json` byte copy plus `model.json`. Acceptance: spatial and aux ONNX parity below 1e-4, plus app level gates of velocity RMSE at or below 0.10, Cp 0.15, vorticity 0.25, recirculation IoU at least 0.75, Strouhal within 10 percent on at least 80 percent of valid held out cases.

## 9 Cost and kill switches
| Step | Measured wall time | Estimated cost |
|------|--------------------|----------------|
| Sweep (71 cases, 16 containers) | 5 to 9 min plus image build | Low CPU, well under $5 |
| Pretrain (A10G) | 20 to 40 min | Single GPU job |
| Fine tune (A10G) | 10 to 20 min | Single GPU job, shorter than pretrain |
| Total | Under 90 min GPU plus sweep | Target under $20 against the $100 credit |

Kill switches: stop before step 3 if the dry run plan reports validation errors. Stop before step 6 if the gate exit is not 0 or harmonic coverage is thin (see section 5). Stop after pretrain if validation loss is not improving. Never retry a diverged case automatically.

## 10 Oct 30 checkpoint and cut rule
All six must hold, else fall back to steady only with the v3 bundle flagged harmonic capable false. Gate exit 0 already implies items 2 and 3, they stay listed as explicit checks:
1. Gate exit 0 on `data/lbm/sweep01`.
2. Harmonic valid count at least 20.
3. Median explained variance on valid cases at least 0.45.
4. Pretrain `run_log.json` shows improving validation composite.
5. Fine tune completed for the same run id.
6. Export parity below 1e-4 and all app level gates in section 8 pass.

## 11 Troubleshooting
| Symptom | Fix |
|---------|-----|
| Tau floor error (`lbm: tau ... at or below floor`) | Reduce `u_lattice` or refine grid. Per body caps: bluff BGK u 0.06 to Re 100, bluff LES u 0.08 to Re 700, airfoil u 0.08 to Re 700 and u 0.12 at Re 1200 |
| Unknown body `naca4412` | Spec and validator use body `naca4` with `naca_code` 4412. Case ids keep the `naca4412` prefix for readability |
| Volume upload conflict | Rerun step 2a with force enabled. Dry run first to confirm the plan |
| Gate adapter failure on divergence check | Denoised native RMS divergence gate is 0.05. Legit LES means sit near 0.01 after smoothing, a u/v mapping error sits near 0.3. A failure names the case id plus `possible u/v field mapping error` |
| `harmonic_reason` values | From `rust/gearflow-wasm/src/stats.rs`: `ok`, `no_period`, `too_few_periods`, `low_explained`, `low_amplitude`, `non_finite`, `not_shedding`. Diverged and setup rows carry `not_shedding` |
