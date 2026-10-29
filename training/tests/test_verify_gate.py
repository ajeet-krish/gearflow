"""Gate tests for training/verify_lbm_dataset.py with tiny fabricated sweeps."""

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from merge_sweep import recompute_sha
from verify_lbm_dataset import (
    EXIT_ADAPTER,
    EXIT_DATA,
    EXIT_OK,
    main as verify_main,
    v2_check_trends,
)

NX = 16
NY = 16
U_LATTICE = 0.06


class SweepBuilder:
    def __init__(self, root: Path):
        self.sweep = root / "sweep"
        self.rows: list[dict] = []

    def add_case(
        self,
        case_id: str,
        body: str,
        re: float,
        alpha: float,
        cd_mean: float,
        sdf_flip: bool = False,
        tamper: bool = False,
        nonbinary_mask: bool = False,
        substitutes_for: str | None = None,
        substitute: bool | None = None,
        radius: float | None = None,
        width: float | None = None,
        height: float | None = None,
        naca_code: str | None = None,
        ref_length: float = 0.4,
    ) -> None:
        case_dir = self.sweep / "cases" / case_id
        case_dir.mkdir(parents=True, exist_ok=True)
        yy, xx = np.mgrid[0:NY, 0:NX]
        dist = np.sqrt((xx - NX // 2) ** 2 + (yy - NY // 2) ** 2)
        obstacle = (dist**2 < 9).astype(np.float32)
        if nonbinary_mask:
            obstacle[0, 0] = 0.5
        fluid = 1.0 - (obstacle > 0.5).astype(np.float32)
        umean = (np.full((NY, NX), U_LATTICE, np.float32) * fluid).astype(np.float32)
        zeros = np.zeros((NY, NX), np.float32)
        pmean = (np.full((NY, NX), 1e-4, np.float32) * fluid).astype(np.float32)
        sdf = (dist - 3.0).astype(np.float32)
        if sdf_flip:
            sdf = -sdf
        bins = {
            "umean": umean,
            "vmean": zeros,
            "pmean": pmean,
            "omegamean": zeros.copy(),
            "tke": zeros.copy(),
            "recirc": zeros.copy(),
            "obstacle": obstacle,
            "sdf": sdf,
        }
        for name, arr in bins.items():
            arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
        sha = recompute_sha(case_dir, 2)
        if tamper:
            with open(case_dir / "umean.f32", "r+b") as handle:
                handle.seek(0)
                handle.write(b"\x00\x00\x80\x3f")
        row: dict = {
            "case_id": case_id,
            "body": body,
            "re": re,
            "u_lattice": U_LATTICE,
            "alpha_deg": alpha,
            "les": False,
            "nx": NX,
            "ny": NY,
            "domain_width": 4.0,
            "radius": radius,
            "width": width,
            "height": height,
            "naca_code": naca_code,
            "ref_length": ref_length,
            "transient": 20,
            "window": 30,
            "substitutes_for": substitutes_for,
            "note": "fabricated",
            "sha_version": 2,
            "sha256": sha,
            "status": "completed",
            "cd_mean": cd_mean,
            "cl_mean": 0.0,
            "cl_amp": 0.0,
            "strouhal": None,
            "tail_cd_blocks": [],
        }
        if substitute is not None:
            row["substitute"] = substitute
        self.rows.append(row)

    def add_ghost(self, case_id: str) -> None:
        self.rows.append(
            {
                "case_id": case_id,
                "body": "block",
                "re": 40.0,
                "u_lattice": U_LATTICE,
                "alpha_deg": 0.0,
                "les": False,
                "nx": NX,
                "ny": NY,
                "domain_width": 4.0,
                "radius": None,
                "width": None,
                "height": None,
                "naca_code": None,
                "ref_length": 0.4,
                "transient": 20,
                "window": 30,
                "substitutes_for": None,
                "note": "ghost",
                "sha_version": 2,
                "sha256": "0" * 64,
                "status": "completed",
                "cd_mean": 2.0,
                "cl_mean": 0.0,
                "cl_amp": 0.0,
                "strouhal": None,
                "tail_cd_blocks": [],
            }
        )

    def finalize(self) -> Path:
        with open(self.sweep / "manifest.jsonl", "w") as handle:
            for row in self.rows:
                handle.write(json.dumps(row) + "\n")
        return self.sweep


def _pass_sweep(root: Path) -> Path:
    builder = SweepBuilder(root)
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_case("block_r040", "block", 40.0, 0.0, 2.3447)
    builder.add_case("naca0012_a04", "naca0012", 100.0, 4.0, 0.2058)
    return builder.finalize()


def _snapshot(root: Path) -> dict[str, str]:
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in root.rglob("*")
        if p.is_file()
    }


def _report(out: Path) -> dict:
    return json.loads((out / "verify_report.json").read_text())


def _write_v3_bins(
    sweep: Path,
    case_id: str,
    amp: float = 0.01,
    tke_val: float = 1e-4,
    zero_bins: bool = False,
    solid_break: bool = False,
    nonfinite: bool = False,
) -> str:
    case_dir = sweep / "cases" / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    yy, xx = np.mgrid[0:NY, 0:NX]
    dist = np.sqrt((xx - NX // 2) ** 2 + (yy - NY // 2) ** 2)
    obstacle = (dist**2 < 9).astype(np.float32)
    fluid = (1.0 - (obstacle > 0.5).astype(np.float32)).astype(np.float32)
    umean = (np.full((NY, NX), U_LATTICE, np.float32) * fluid).astype(np.float32)
    zeros = np.zeros((NY, NX), np.float32)
    pmean = (np.full((NY, NX), 1e-4, np.float32) * fluid).astype(np.float32)
    tke = (np.full((NY, NX), tke_val, np.float32) * fluid).astype(np.float32)
    sdf = (dist - 3.0).astype(np.float32)
    if zero_bins:
        ucos = zeros.copy()
        usin = zeros.copy()
        vcos = zeros.copy()
        vsin = zeros.copy()
    else:
        ucos = (np.full((NY, NX), amp, np.float32) * fluid).astype(np.float32)
        usin = zeros.copy()
        vcos = zeros.copy()
        vsin = zeros.copy()
    if solid_break:
        ucos[obstacle > 0.5] = np.float32(amp if amp != 0.0 else 0.01)
    if nonfinite:
        ucos[0, 0] = np.float32("inf")
    bins = {
        "umean": umean,
        "vmean": zeros,
        "pmean": pmean,
        "omegamean": zeros.copy(),
        "tke": tke,
        "recirc": zeros.copy(),
        "obstacle": obstacle,
        "sdf": sdf,
        "ucos": ucos,
        "usin": usin,
        "vcos": vcos,
        "vsin": vsin,
    }
    for name, arr in bins.items():
        arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
    return recompute_sha(case_dir, 3)


def _v3_row(
    case_id: str,
    sha: str,
    body: str = "cylinder",
    re: float = 40.0,
    cd_mean: float = 2.0618,
    valid: bool = True,
    explained: float = 0.25,
    strouhal: float | None = 0.15,
    shedding: float | None = 0.01,
    phase: int | None = 25,
    cycles: int = 5,
    samples: int = 200,
    harmonic_tke: float | None = 1e-4,
) -> dict:
    return {
        "case_id": case_id,
        "body": body,
        "re": re,
        "u_lattice": U_LATTICE,
        "alpha_deg": 0.0,
        "les": False,
        "nx": NX,
        "ny": NY,
        "domain_width": 4.0,
        "radius": None,
        "width": None,
        "height": None,
        "naca_code": None,
        "ref_length": 0.4,
        "transient": 20,
        "window": 30,
        "substitutes_for": None,
        "note": "fabricated v3",
        "sha_version": 3,
        "sha256": sha,
        "status": "completed",
        "cd_mean": cd_mean,
        "cl_mean": 0.0,
        "cl_amp": 0.0,
        "strouhal": strouhal,
        "shedding_freq_per_step": shedding,
        "harmonic_valid": valid,
        "explained_variance": explained,
        "phase_ref_step": phase,
        "harmonic_cycles": cycles,
        "harmonic_samples": samples,
        "harmonic_tke": harmonic_tke,
        "tail_cd_blocks": [],
    }


def test_gate_pass_reports_approved(tmp_path: Path) -> None:
    sweep = _pass_sweep(tmp_path / "data")
    out = tmp_path / "out"
    before = _snapshot(sweep)
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    assert _snapshot(sweep) == before
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["gate"]["data_failures"] == []
    assert report["gate"]["adapter_failures"] == []
    assert report["v0_manifest"]["sha_ok"] == 4
    assert set(report["v3_splits"]["train"]).isdisjoint(report["v3_splits"]["val"])
    assert len(report["v3_splits"]["train"]) + len(report["v3_splits"]["val"]) == 4
    families = {p["family"] for p in report["v5_previews"]["previews"]}
    assert families == {"cylinder", "block", "naca0012"}
    for preview in report["v5_previews"]["previews"]:
        assert (out / preview["file"]).is_file()
        assert preview["vmin"] == preview["vmax"] or preview["vmin"] < preview["vmax"]
    assert report["v5_previews"]["fixed_colorbars"]["meanU"] == [0.0, 1.5]
    assert report["v6_coverage"]["extrapolation_risk"] is True


def test_gate_sha_mismatch_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618, tamper=True)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "DATA_FAILURE"
    assert any("sha256 mismatch" in f for f in report["gate"]["data_failures"])


def test_gate_sdf_sign_flip_is_adapter_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_case("block_r040", "block", 40.0, 0.0, 2.3447, sdf_flip=True)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert report["status"] == "ADAPTER_FAILURE"
    assert any("SDF sign" in f for f in report["gate"]["adapter_failures"])


def test_gate_missing_id_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_ghost("ghost_case")
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "DATA_FAILURE"
    assert any("ghost_case" in f for f in report["gate"]["data_failures"])


def test_gate_substitute_unflagged_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_case(
        "cyl_r060_sub",
        "cylinder",
        60.0,
        0.0,
        1.7770,
        substitutes_for="cyl_r100",
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    code = verify_main([str(sweep), "--out", str(out)])
    assert code in (EXIT_DATA, EXIT_ADAPTER)
    assert code == EXIT_DATA
    report = _report(out)
    assert any("substitute unflagged" in f for f in report["gate"]["data_failures"])


def test_gate_trend_violation_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 1.0)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 5.0)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert any("rises with Re" in f for f in report["gate"]["data_failures"])


def test_gate_nonbinary_mask_is_adapter_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618, nonbinary_mask=True)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert any("mask not binary" in f for f in report["gate"]["adapter_failures"])


def test_gate_out_dir_inside_sweep_refused(tmp_path: Path) -> None:
    sweep = _pass_sweep(tmp_path / "data")
    code = verify_main([str(sweep), "--out", str(sweep / "inner")])
    assert code == EXIT_DATA


def test_gate_mixed_failure_prefers_adapter(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_case("block_r040", "block", 40.0, 0.0, 2.3447, sdf_flip=True)
    builder.add_ghost("ghost_case")
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert report["status"] == "ADAPTER_FAILURE"
    assert report["exit_code"] == EXIT_ADAPTER
    assert any("ghost_case" in f for f in report["gate"]["data_failures"])
    assert any("SDF sign" in f for f in report["gate"]["adapter_failures"])


def _add_flat_v1_case(
    sweep: Path, case_id: str, body: str, re: float, cd_mean: float
) -> None:
    case_dir = sweep / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    yy, xx = np.mgrid[0:NY, 0:NX]
    dist = np.sqrt((xx - NX // 2) ** 2 + (yy - NY // 2) ** 2)
    obstacle = (dist**2 < 9).astype(np.float32)
    fluid = 1.0 - (obstacle > 0.5).astype(np.float32)
    umean = (np.full((NY, NX), U_LATTICE, np.float32) * fluid).astype(np.float32)
    zeros = np.zeros((NY, NX), np.float32)
    pmean = (np.full((NY, NX), 1e-4, np.float32) * fluid).astype(np.float32)
    bins = {
        "umean": umean,
        "vmean": zeros,
        "pmean": pmean,
        "omegamean": zeros.copy(),
        "tke": zeros.copy(),
        "recirc": zeros.copy(),
        "obstacle": obstacle,
    }
    for name, arr in bins.items():
        arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
    sha = recompute_sha(case_dir, 1)
    row = {
        "case_id": case_id,
        "body": body,
        "re": re,
        "u_lattice": U_LATTICE,
        "alpha_deg": 0.0,
        "les": False,
        "nx": NX,
        "ny": NY,
        "status": "completed",
        "cd_mean": cd_mean,
        "sha256": sha,
    }
    manifest = sweep / "manifest.jsonl"
    with open(manifest, "a") as handle:
        handle.write(json.dumps(row) + "\n")


def test_gate_flat_pilot_style_compat_warnings(tmp_path: Path) -> None:
    sweep = tmp_path / "flat"
    sweep.mkdir(parents=True, exist_ok=True)
    (sweep / "manifest.jsonl").write_text("")
    _add_flat_v1_case(sweep, "cyl_r020", "cylinder", 20.0, 2.7720)
    _add_flat_v1_case(sweep, "cyl_r040", "cylinder", 40.0, 2.0618)
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["gate"]["data_failures"] == []
    warnings = report["gate"]["warnings"]
    assert any("compat default ref_length" in w and "cyl_r020" in w for w in warnings)
    assert any("compat default sha_version" in w for w in warnings)
    assert any("compat default substitutes_for" in w for w in warnings)
    assert any(
        "compat default domain_width" in w and "cyl_r020" in w for w in warnings
    )


def test_gate_diverged_without_bins_not_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.rows.append(
        {
            "case_id": "cyl_r100_gone",
            "body": "cylinder",
            "re": 100.0,
            "u_lattice": U_LATTICE,
            "alpha_deg": 0.0,
            "nx": NX,
            "ny": NY,
            "status": "diverged",
            "error": "lbm: diverged",
        }
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    joined = "\n".join(report["gate"]["data_failures"])
    assert "cyl_r100_gone" not in joined
    assert "missing case dir" not in joined
    assert "missing bin" not in joined


def test_gate_missing_ref_length_v2_fails(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    sweep = builder.finalize()
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    for row in rows:
        if row["case_id"] == "cyl_r040":
            del row["ref_length"]
    with open(sweep / "manifest.jsonl", "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "DATA_FAILURE"
    assert any("cyl_r040" in f and "ref_length" in f for f in report["gate"]["data_failures"])


def test_gate_split_matches_training_split(tmp_path: Path) -> None:
    from dataset_v2 import split_completed_rows

    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.add_case("block_r040", "block", 40.0, 0.0, 2.3447)
    builder.add_case("naca0012_a04", "naca0012", 100.0, 4.0, 0.2058)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    train_ids, val_ids = split_completed_rows(builder.rows)
    assert report["v3_splits"]["train"] == train_ids
    assert report["v3_splits"]["val"] == val_ids


def test_native_div_rms_uniform_flow_is_clean() -> None:
    from verify_lbm_dataset import _native_div_rms

    fluid = np.ones((16, 16), dtype=bool)
    u_norm = np.ones((16, 16), dtype=np.float32)
    v_norm = np.zeros((16, 16), dtype=np.float32)
    rms, count, iters = _native_div_rms(u_norm, v_norm, fluid, 0.25)
    assert count > 0
    assert iters >= 1
    assert rms < 0.01


def test_native_div_rms_shear_flow_is_dirty() -> None:
    from verify_lbm_dataset import _native_div_rms

    yy, xx = np.mgrid[0:16, 0:16]
    u_norm = xx.astype(np.float32) * 2.0
    v_norm = np.zeros((16, 16), dtype=np.float32)
    fluid = np.ones((16, 16), dtype=bool)
    rms, count, _ = _native_div_rms(u_norm, v_norm, fluid, 0.25)
    assert count > 0
    assert rms >= 0.01


def _add_duct_narrow_channel_case(sweep: Path) -> None:
    case_id = "duct_narrow"
    case_dir = sweep / "cases" / case_id
    case_dir.mkdir(parents=True, exist_ok=True)
    obstacle = np.ones((NY, NX), dtype=np.float32)
    obstacle[7:9, :] = 0.0
    fluid = (obstacle < 0.5).astype(np.float32)
    umean = (np.ones((NY, NX), np.float32) * np.float32(U_LATTICE)) * fluid
    zeros = np.zeros((NY, NX), np.float32)
    pmean = (np.full((NY, NX), 0.05, np.float32)) * fluid
    sdf = np.where(obstacle > 0.5, -1.0, 1.0).astype(np.float32)
    bins = {
        "umean": umean,
        "vmean": zeros,
        "pmean": pmean,
        "omegamean": zeros.copy(),
        "tke": zeros.copy(),
        "recirc": zeros.copy(),
        "obstacle": obstacle,
        "sdf": sdf,
    }
    for name, arr in bins.items():
        arr.astype(np.float32).tofile(case_dir / f"{name}.f32")
    sha = recompute_sha(case_dir, 2)
    row = {
        "case_id": case_id,
        "body": "duct",
        "re": 40.0,
        "u_lattice": U_LATTICE,
        "alpha_deg": 0.0,
        "les": False,
        "nx": NX,
        "ny": NY,
        "domain_width": 4.0,
        "radius": None,
        "width": None,
        "height": None,
        "naca_code": None,
        "ref_length": 0.4,
        "transient": 20,
        "window": 30,
        "substitutes_for": None,
        "note": "narrow duct",
        "sha_version": 2,
        "sha256": sha,
        "status": "completed",
        "cd_mean": 7.3499,
        "cl_mean": 0.0,
        "cl_amp": 0.0,
        "strouhal": None,
        "tail_cd_blocks": [],
    }
    with open(sweep / "manifest.jsonl", "a") as handle:
        handle.write(json.dumps(row) + "\n")


def test_gate_duct_divergence_and_cp_exempt(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    sweep = builder.finalize()
    _add_duct_narrow_channel_case(sweep)
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["gate"]["adapter_failures"] == []
    warnings = "\n".join(report["gate"]["warnings"])
    assert "duct_narrow" in warnings
    assert "exempt by design" in warnings
    assert "duct divergence exempt by design" in warnings
    assert "duct Cp saturation" in warnings
    assert "adapter clip" in warnings
    assert "duct_narrow" in report["v1_physics"]["cases"]
    duct_case = report["v1_physics"]["cases"]["duct_narrow"]
    assert duct_case["div_grid"] == "native"
    assert duct_case["div_exempt"] is True


def test_gate_non_duct_native_divergence_still_fails(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    sweep = builder.finalize()
    case_dir = sweep / "cases" / "cyl_r040"
    umean = np.fromfile(case_dir / "umean.f32", dtype=np.float32).reshape(NY, NX)
    yy, xx = np.mgrid[0:NY, 0:NX]
    divergent = (xx.astype(np.float32) * 2.0 * np.float32(U_LATTICE)).astype(np.float32)
    fluid = (np.fromfile(case_dir / "obstacle.f32", dtype=np.float32).reshape(NY, NX) < 0.5)
    divergent = (divergent * fluid).astype(np.float32)
    divergent.astype(np.float32).tofile(case_dir / "umean.f32")
    sha = recompute_sha(case_dir, 2)
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    for row in rows:
        if row["case_id"] == "cyl_r040":
            row["sha256"] = sha
    with open(sweep / "manifest.jsonl", "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert any("native RMS divergence" in f for f in report["gate"]["adapter_failures"])


def test_gate_v2_missing_substitutes_for_warns(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    sweep = builder.finalize()
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    for row in rows:
        if row["case_id"] == "cyl_r040":
            del row["substitutes_for"]
    with open(sweep / "manifest.jsonl", "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    warnings = report["gate"]["warnings"]
    assert any(
        "compat default substitutes_for" in w and "cyl_r040" in w for w in warnings
    )


def test_gate_v3_valid_passes_with_recomputed(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_v3", amp=0.01, tke_val=1e-4)
    builder.rows.append(_v3_row("cyl_r040_v3", sha, re=40.0, cd_mean=2.0618))
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["v8_harmonic"]["n_valid"] == 1
    assert report["v8_harmonic"]["harmonic_valid_count"] == 1
    entry = report["v8_harmonic"]["cases"]["cyl_r040_v3"]
    assert abs(entry["recomputed_explained_variance"] - 0.25) < 1e-6
    assert entry["clip_saturation"] == 0.0


def test_gate_v3_zero_amplitude_valid_true_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_zero", zero_bins=True)
    builder.rows.append(
        _v3_row("cyl_r040_zero", sha, re=40.0, cd_mean=2.0618, explained=0.0)
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "DATA_FAILURE"
    assert any(
        "zero amplitude" in f and "valid" in f for f in report["gate"]["data_failures"]
    )


def test_gate_v3_tampered_explained_is_adapter_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_tamper", amp=0.01, tke_val=1e-4)
    builder.rows.append(
        _v3_row("cyl_r040_tamper", sha, re=40.0, cd_mean=2.0618, explained=0.9)
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert any(
        "explained_variance" in f for f in report["gate"]["adapter_failures"]
    )


def test_gate_v3_identity_holds_exactly(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_exact", amp=0.02, tke_val=4e-4)
    builder.rows.append(
        _v3_row(
            "cyl_r040_exact",
            sha,
            re=40.0,
            cd_mean=2.0618,
            explained=0.25,
            harmonic_tke=4e-4,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    entry = report["v8_harmonic"]["cases"]["cyl_r040_exact"]
    assert abs(entry["recomputed_explained_variance"] - 0.25) < 1e-6


def test_gate_v3_wrong_harmonic_tke_is_adapter_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_wrongtke", amp=0.01, tke_val=1e-4)
    builder.rows.append(
        _v3_row(
            "cyl_r040_wrongtke",
            sha,
            re=40.0,
            cd_mean=2.0618,
            explained=0.25,
            harmonic_tke=2e-4,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert any(
        "explained_variance" in f and "cyl_r040_wrongtke" in f
        for f in report["gate"]["adapter_failures"]
    )


def test_gate_v3_null_harmonic_tke_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_notke", amp=0.01, tke_val=1e-4)
    builder.rows.append(
        _v3_row(
            "cyl_r040_notke",
            sha,
            re=40.0,
            cd_mean=2.0618,
            explained=0.25,
            harmonic_tke=None,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert any(
        "harmonic_tke" in f and "cyl_r040_notke" in f
        for f in report["gate"]["data_failures"]
    )


def test_gate_v3_stationarity_drift_warns_only(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_drift", amp=0.01, tke_val=1e-4)
    builder.rows.append(
        _v3_row(
            "cyl_r040_drift",
            sha,
            re=40.0,
            cd_mean=2.0618,
            explained=0.25 / 1.4,
            harmonic_tke=1.4e-4,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["gate"]["data_failures"] == []
    assert report["gate"]["adapter_failures"] == []
    assert any(
        "stationarity" in w and "cyl_r040_drift" in w
        for w in report["gate"]["warnings"]
    )


def test_gate_v3_below_floor_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_small", amp=1e-5, tke_val=1e-4)
    builder.rows.append(
        _v3_row("cyl_r040_small", sha, re=40.0, cd_mean=2.0618, explained=2.5e-07)
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert any(
        "zero amplitude" in f for f in report["gate"]["data_failures"]
    )


def test_gate_v3_invalid_nonzero_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_inv", amp=0.01, tke_val=1e-4)
    builder.rows.append(
        _v3_row(
            "cyl_r040_inv",
            sha,
            re=40.0,
            cd_mean=2.0618,
            valid=False,
            explained=0.0,
            strouhal=None,
            shedding=None,
            phase=None,
            cycles=0,
            samples=0,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert any(
        "nonzero" in f and "invalid" in f for f in report["gate"]["data_failures"]
    )


def test_gate_v3_harmonic_solid_break_is_data_failure(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_solid", amp=0.01, solid_break=True)
    builder.rows.append(_v3_row("cyl_r040_solid", sha, re=40.0, cd_mean=2.0618))
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert any(
        "solid" in f and "harmonic contract" in f
        for f in report["gate"]["data_failures"]
    )


def test_gate_v3_diverged_and_setup_error_with_defaults_pass(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    builder.rows.append(
        {
            "case_id": "cyl_r060_gone",
            "body": "cylinder",
            "re": 60.0,
            "u_lattice": U_LATTICE,
            "alpha_deg": 0.0,
            "status": "diverged",
            "error": "lbm: diverged",
            "sha_version": 3,
            "harmonic_valid": False,
            "explained_variance": 0,
            "phase_ref_step": None,
            "harmonic_cycles": 0,
            "harmonic_samples": 0,
        }
    )
    builder.rows.append(
        {
            "case_id": "cyl_r080_setup",
            "body": "cylinder",
            "re": 80.0,
            "u_lattice": U_LATTICE,
            "alpha_deg": 0.0,
            "status": "setup_error",
            "error": "lbm: setup",
            "sha_version": 3,
            "harmonic_valid": False,
            "explained_variance": 0,
            "phase_ref_step": None,
            "harmonic_cycles": 0,
            "harmonic_samples": 0,
        }
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"


def test_gate_v3_invalid_zero_bins_pass(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    sweep = builder.sweep
    sha = _write_v3_bins(sweep, "cyl_r040_off", zero_bins=True)
    builder.rows.append(
        _v3_row(
            "cyl_r040_off",
            sha,
            re=40.0,
            cd_mean=2.0618,
            valid=False,
            explained=0.0,
            strouhal=None,
            shedding=None,
            phase=None,
            cycles=0,
            samples=0,
        )
    )
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"


def test_gate_zero_harmonic_valid_is_warning_only(tmp_path: Path) -> None:
    sweep = _pass_sweep(tmp_path / "data")
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["v8_harmonic"]["harmonic_valid_count"] == 0
    assert report["v8_harmonic"]["harmonic_valid_median_explained"] is None
    assert any(
        "zero harmonic_valid" in w for w in report["gate"]["warnings"]
    )

def _smooth_divfree_fields(n: int = 32):
    import numpy as np
    dx = 4.0 / (n - 1)
    yy, xx = np.mgrid[0:n, 0:n]
    y = yy.astype(np.float64) * dx
    length = 4.0
    amp = 0.2
    u = (1.0 + amp * np.sin(2.0 * np.pi * y / length)).astype(np.float32)
    v = np.zeros((n, n), np.float32)
    fluid = np.ones((n, n), dtype=bool)
    return u, v, fluid, dx


def test_native_div_rms_smooth_divfree_passes() -> None:
    from verify_lbm_dataset import DIV_RMS_MAX, _native_div_rms

    u, v, fluid, dx = _smooth_divfree_fields(32)
    rms, count, _ = _native_div_rms(u, v, fluid, dx)
    assert count > 0
    assert rms < DIV_RMS_MAX
    assert DIV_RMS_MAX == 0.05


def test_native_div_rms_transposed_fails() -> None:
    from verify_lbm_dataset import DIV_RMS_MAX, _native_div_rms

    u, v, fluid, dx = _smooth_divfree_fields(32)
    rms, _, _ = _native_div_rms(v, u, fluid, dx)
    assert rms >= DIV_RMS_MAX


def test_native_div_rms_noise_passes_after_denoise() -> None:
    from verify_lbm_dataset import DIV_RMS_MAX, _erode, _native_div_rms, _native_erode_iters

    n = 64
    dx = 0.025
    rng = np.random.default_rng(0)
    sigma = 0.002
    u = (1.0 + rng.normal(0.0, sigma, size=(n, n))).astype(np.float32)
    v = rng.normal(0.0, sigma, size=(n, n)).astype(np.float32)
    fluid = np.ones((n, n), dtype=bool)
    dudx = np.empty((n, n), dtype=np.float64)
    dvdy = np.empty((n, n), dtype=np.float64)
    a = u.astype(np.float64)
    b = v.astype(np.float64)
    dudx[:, 1:-1] = (a[:, 2:] - a[:, :-2]) / (2.0 * dx)
    dudx[:, 0] = (a[:, 1] - a[:, 0]) / dx
    dudx[:, -1] = (a[:, -1] - a[:, -2]) / dx
    dvdy[1:-1, :] = (b[2:, :] - b[:-2, :]) / (2.0 * dx)
    dvdy[0, :] = (b[1, :] - b[0, :]) / dx
    dvdy[-1, :] = (b[-1, :] - b[-2, :]) / dx
    interior = _erode(fluid, _native_erode_iters(dx))
    raw = float(np.sqrt(np.mean(((dudx + dvdy)[interior]) ** 2)))
    denoised, _, _ = _native_div_rms(u, v, fluid, dx)
    assert raw >= DIV_RMS_MAX
    assert denoised < DIV_RMS_MAX
    assert raw > 0.05
    assert denoised < 0.05


def test_native_div_rms_uniform_source_fails() -> None:
    from verify_lbm_dataset import DIV_RMS_MAX, _native_div_rms

    n = 32
    dx = 4.0 / (n - 1)
    yy, xx = np.mgrid[0:n, 0:n]
    x = (xx.astype(np.float64) * dx).astype(np.float32)
    y = (yy.astype(np.float64) * dx).astype(np.float32)
    u = (0.1 * x).astype(np.float32)
    v = (0.1 * y).astype(np.float32)
    fluid = np.ones((n, n), dtype=bool)
    rms, _, _ = _native_div_rms(u, v, fluid, dx)
    assert abs(rms - 0.2) < 1e-6
    assert rms >= DIV_RMS_MAX


def _add_bulk_v3_valid(
    builder: SweepBuilder,
    prefix: str,
    n: int,
    amp: float,
    tke_val: float,
    explained: float,
    harmonic_tke: float,
) -> None:
    sweep = builder.sweep
    for i in range(n):
        case_id = f"{prefix}_{i:03d}"
        sha = _write_v3_bins(sweep, case_id, amp=amp, tke_val=tke_val)
        builder.rows.append(
            _v3_row(
                case_id,
                sha,
                re=40.0,
                cd_mean=2.0618,
                explained=explained,
                harmonic_tke=harmonic_tke,
            )
        )


def test_gate_floors_five_valid_needs_more_harmonics(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    _add_bulk_v3_valid(builder, "bulk", 5, amp=0.01, tke_val=1e-4, explained=0.25, harmonic_tke=1e-4)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["exit_code"] == EXIT_DATA
    assert report["gate"]["data_failures"] == []
    assert report["gate"]["adapter_failures"] == []
    harm = report["v8_harmonic"]
    assert harm["harmonic_valid_count"] == 5
    assert harm["harmonic_valid_median_explained"] == pytest.approx(0.25)
    assert harm["floor_valid_count"] == 20
    assert harm["floor_median_explained"] == pytest.approx(0.45)


def test_gate_floors_twenty_valid_high_median_approved(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    _add_bulk_v3_valid(builder, "bulk", 20, amp=0.02, tke_val=1e-4, explained=1.0, harmonic_tke=1e-4)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
    harm = report["v8_harmonic"]
    assert harm["harmonic_valid_count"] == 20
    assert harm["harmonic_valid_median_explained"] == pytest.approx(1.0)
    assert harm["floor_valid_count"] == 20
    assert harm["floor_median_explained"] == pytest.approx(0.45)


def test_gate_floors_twenty_valid_low_median_needs_more(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    _add_bulk_v3_valid(builder, "bulk", 20, amp=0.01, tke_val=1e-4, explained=0.25, harmonic_tke=1e-4)
    sweep = builder.finalize()
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_DATA
    report = _report(out)
    assert report["status"] == "NEEDS_MORE_HARMONICS"
    assert report["exit_code"] == EXIT_DATA
    assert report["gate"]["data_failures"] == []
    assert report["gate"]["adapter_failures"] == []
    harm = report["v8_harmonic"]
    assert harm["harmonic_valid_count"] == 20
    assert harm["harmonic_valid_median_explained"] == pytest.approx(0.25)


def test_gate_transposed_field_fails_with_mapping_error(tmp_path: Path) -> None:
    builder = SweepBuilder(tmp_path / "data")
    builder.add_case("cyl_r020", "cylinder", 20.0, 0.0, 2.7720)
    builder.add_case("cyl_r040", "cylinder", 40.0, 0.0, 2.0618)
    sweep = builder.finalize()
    case_dir = sweep / "cases" / "cyl_r040"
    obstacle = np.fromfile(case_dir / "obstacle.f32", dtype=np.float32).reshape(NY, NX)
    fluid = obstacle < 0.5
    yy, xx = np.mgrid[0:NY, 0:NX]
    dx_nat = 4.0 / (NX - 1)
    y = yy.astype(np.float32) * np.float32(dx_nat)
    u_norm = np.zeros((NY, NX), np.float32)
    v_norm = (1.0 + 0.2 * np.sin(2.0 * np.pi * y / 4.0)).astype(np.float32)
    u_norm = (u_norm * fluid).astype(np.float32)
    v_norm = (v_norm * fluid).astype(np.float32)
    (u_norm * np.float32(U_LATTICE)).astype(np.float32).tofile(case_dir / "umean.f32")
    (v_norm * np.float32(U_LATTICE)).astype(np.float32).tofile(case_dir / "vmean.f32")
    sha = recompute_sha(case_dir, 2)
    rows = [json.loads(line) for line in (sweep / "manifest.jsonl").read_text().splitlines()]
    for row in rows:
        if row["case_id"] == "cyl_r040":
            row["sha256"] = sha
    with open(sweep / "manifest.jsonl", "w") as handle:
        for row in rows:
            handle.write(json.dumps(row) + "\n")
    out = tmp_path / "out"
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_ADAPTER
    report = _report(out)
    assert any(
        "native RMS divergence" in f and "field mapping error" in f
        for f in report["gate"]["adapter_failures"]
    )


def _v2_row(
    case_id: str,
    body: str,
    re: float,
    alpha: float,
    cd_mean: float,
    radius: float | None = None,
    width: float | None = None,
    height: float | None = None,
    naca_code: str | None = None,
    ref_length: float = 0.4,
) -> dict:
    return {
        "case_id": case_id,
        "body": body,
        "re": re,
        "alpha_deg": alpha,
        "cd_mean": cd_mean,
        "radius": radius,
        "width": width,
        "height": height,
        "naca_code": naca_code,
        "ref_length": ref_length,
    }


def test_v2_different_sizes_same_re_never_compared() -> None:
    rows = [
        _v2_row("cyl_r015_re020", "cylinder", 20.0, 0.0, 2.5693, radius=0.15, ref_length=0.3),
        _v2_row("cyl_r020_re020", "cylinder", 20.0, 0.0, 2.7720, radius=0.20, ref_length=0.4),
        _v2_row("block_030_re020", "block", 20.0, 0.0, 2.8308, width=0.3, ref_length=0.3),
        _v2_row("block_040_re020", "block", 20.0, 0.0, 3.1596, width=0.4, ref_length=0.4),
        _v2_row("small_re025", "cylinder", 25.0, 0.0, 2.0, radius=0.15, ref_length=0.3),
        _v2_row("large_re045", "cylinder", 45.0, 0.0, 2.5, radius=0.20, ref_length=0.4),
    ]
    result = v2_check_trends(rows)
    assert result["failures"] == []


def test_v2_same_size_falling_cd_passes() -> None:
    rows = [
        _v2_row("cyl_r020_re020", "cylinder", 20.0, 0.0, 2.7720, radius=0.20, ref_length=0.4),
        _v2_row("cyl_r020_re040", "cylinder", 40.0, 0.0, 2.0618, radius=0.20, ref_length=0.4),
    ]
    result = v2_check_trends(rows)
    assert result["failures"] == []


def test_v2_same_size_rising_cd_fails() -> None:
    rows = [
        _v2_row("cyl_r020_re020", "cylinder", 20.0, 0.0, 1.0, radius=0.20, ref_length=0.4),
        _v2_row("cyl_r020_re040", "cylinder", 40.0, 0.0, 5.0, radius=0.20, ref_length=0.4),
    ]
    result = v2_check_trends(rows)
    assert any("rises with Re" in f for f in result["failures"])


def test_v2_les_rows_excluded_from_bluff_trend() -> None:
    rows = [
        _v2_row("block_030_re200", "block", 200.0, 0.0, 1.8325, width=0.3, ref_length=0.3),
        _v2_row("block_030_re400", "block", 400.0, 0.0, 1.9822, width=0.3, ref_length=0.3),
    ]
    for row in rows:
        row["les"] = True
    result = v2_check_trends(rows)
    assert result["failures"] == []
