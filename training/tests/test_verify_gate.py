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
            "radius": None,
            "width": None,
            "height": None,
            "naca_code": None,
            "ref_length": 0.4,
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


def test_gate_pass_reports_approved(tmp_path: Path) -> None:
    sweep = _pass_sweep(tmp_path / "data")
    out = tmp_path / "out"
    before = _snapshot(sweep)
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    assert _snapshot(sweep) == before
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
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
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
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
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
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
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
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
    assert verify_main([str(sweep), "--out", str(out)]) == EXIT_OK
    report = _report(out)
    assert report["status"] == "TRAIN_APPROVED"
    warnings = report["gate"]["warnings"]
    assert any(
        "compat default substitutes_for" in w and "cyl_r040" in w for w in warnings
    )
