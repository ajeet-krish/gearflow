"""Unit tests for training/merge_sweep.py with tiny fabricated workers."""

import hashlib
import json
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from merge_sweep import BIN_ORDER_V2, merge_sweep

NX = 4
NY = 3


def _blob(value: float) -> bytes:
    return struct.pack(f"<{NX * NY}f", *([value] * (NX * NY)))


def _write_case(case_dir: Path, seed: float) -> str:
    case_dir.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    for pos, name in enumerate(BIN_ORDER_V2):
        blob = _blob(seed + pos)
        (case_dir / name).write_bytes(blob)
        hasher.update(blob)
    (case_dir / "meta.json").write_text(json.dumps({"case_id": case_dir.name}) + "\n")
    return hasher.hexdigest()


def _spec_row(case_id: str, sha: str, substitutes_for: str | None = None) -> dict:
    return {
        "case_id": case_id,
        "body": "block",
        "re": 40.0,
        "u_lattice": 0.06,
        "alpha_deg": 0.0,
        "les": False,
        "nx": NX,
        "ny": NY,
        "domain_width": 4.0,
        "radius": None,
        "width": 0.4,
        "height": 0.4,
        "naca_code": None,
        "ref_length": 0.4,
        "transient": 20,
        "window": 30,
        "substitutes_for": substitutes_for,
        "note": "fabricated",
        "sha_version": 2,
        "sha256": sha,
        "status": "completed",
    }


def _write_worker(workers: Path, case_id: str, row: dict, seed: float) -> None:
    worker = workers / case_id
    sha = _write_case(worker / "case", seed)
    row = dict(row)
    if row.get("status") == "completed" and not row.get("sha256"):
        row["sha256"] = sha
    (worker / "fragment.jsonl").write_text(json.dumps(row) + "\n")


def _write_spec(spec_path: Path, rows: list[dict]) -> None:
    spec_rows = []
    for row in rows:
        spec_rows.append(
            {
                "case_id": row["case_id"],
                "body": row["body"],
                "re": row["re"],
                "u_lattice": row["u_lattice"],
                "alpha_deg": row["alpha_deg"],
                "les": row["les"],
                "nx": row["nx"],
                "ny": row["ny"],
                "domain_width": row["domain_width"],
                "radius": row["radius"],
                "width": row["width"],
                "height": row["height"],
                "naca_code": row["naca_code"],
                "ref_length": row["ref_length"],
                "transient": row["transient"],
                "window": row["window"],
                "substitutes_for": row["substitutes_for"],
                "note": row["note"],
            }
        )
    with open(spec_path, "w") as handle:
        for entry in spec_rows:
            handle.write(json.dumps(entry) + "\n")


def test_merge_success_sorted_and_counts(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    rows = [_spec_row("b_case", ""), _spec_row("a_case", "")]
    _write_spec(spec_path, rows)
    for pos, row in enumerate(rows):
        worker = workers / row["case_id"]
        sha = _write_case(worker / "case", float(pos))
        full = dict(row)
        full["sha256"] = sha
        (worker / "fragment.jsonl").write_text(json.dumps(full) + "\n")
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "ok"
    assert report["counts"]["completed"] == 2
    manifest = (out_dir / "manifest.jsonl").read_text().splitlines()
    assert [json.loads(line)["case_id"] for line in manifest] == ["b_case", "a_case"]
    assert (out_dir / "cases" / "a_case" / "sdf.f32").is_file()
    assert (out_dir / "merge_report.json").is_file()


def test_merge_diverged_verbatim_and_substitute_marker(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    ok_row = _spec_row("ok_case", "")
    div_row = {
        "case_id": "div_case",
        "body": "cylinder",
        "re": 100.0,
        "u_lattice": 0.08,
        "status": "diverged",
        "error": "lbm: diverged at step 10",
        "sha_version": 2,
        "ref_length": 0.4,
        "substitutes_for": None,
        "note": "blew up",
    }
    sub_row = _spec_row("sub_case", "", substitutes_for="div_case")
    _write_spec(
        spec_path,
        [
            {**ok_row, "sha256": ""},
            {k: div_row.get(k) for k in ("case_id", "body", "re", "u_lattice") } | {
                "alpha_deg": 0.0, "les": False, "nx": NX, "ny": NY, "domain_width": 4.0,
                "radius": 0.2, "width": None, "height": None, "naca_code": None,
                "ref_length": 0.4, "transient": 20, "window": 30,
                "substitutes_for": None, "note": "blew up",
            },
            {**sub_row, "sha256": ""},
        ],
    )
    _write_worker(workers, "ok_case", ok_row, 1.0)
    div_worker = workers / "div_case"
    div_worker.mkdir(parents=True, exist_ok=True)
    (div_worker / "fragment.jsonl").write_text(json.dumps(div_row) + "\n")
    _write_worker(workers, "sub_case", sub_row, 2.0)
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "ok"
    assert report["counts"]["diverged"] == 1
    assert report["counts"]["substituted"] == 1
    rows = [json.loads(line) for line in (out_dir / "manifest.jsonl").read_text().splitlines()]
    by_id = {row["case_id"]: row for row in rows}
    assert by_id["div_case"]["error"] == "lbm: diverged at step 10"
    assert by_id["sub_case"]["substitute"] is True
    assert by_id["sub_case"]["substitutes_for"] == "div_case"
    assert not (out_dir / "cases" / "div_case").exists()


def test_merge_mismatch_fails_closed(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    row = _spec_row("tamper_case", "")
    _write_spec(spec_path, [{**row, "sha256": ""}])
    worker = workers / "tamper_case"
    sha = _write_case(worker / "case", 1.0)
    full = dict(row)
    full["sha256"] = sha
    (worker / "fragment.jsonl").write_text(json.dumps(full) + "\n")
    with open(worker / "case" / "umean.f32", "r+b") as handle:
        handle.seek(0)
        handle.write(b"\x00\x00\x80\x7f")
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "failed"
    assert not (out_dir / "manifest.jsonl").exists()
    assert not (out_dir / "cases").exists()
    assert (out_dir / "merge_report.json").is_file()


def test_merge_missing_id_fails_closed(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    workers.mkdir()
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    row = _spec_row("ghost_case", "")
    _write_spec(spec_path, [{**row, "sha256": ""}])
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "failed"
    assert (out_dir / "merge_report.json").is_file()
    assert not (out_dir / "manifest.jsonl").exists()


def test_merge_identical_duplicates_keep_first(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    row = _spec_row("dup_case", "")
    _write_spec(spec_path, [{**row, "sha256": ""}])
    worker = workers / "dup_case"
    sha = _write_case(worker / "case", 3.0)
    full = dict(row)
    full["sha256"] = sha
    (worker / "fragment.jsonl").write_text(json.dumps(full) + "\n" + json.dumps(full) + "\n")
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "ok"
    manifest = (out_dir / "manifest.jsonl").read_text().splitlines()
    assert len(manifest) == 1


def test_merge_rerun_over_existing_output(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    row = _spec_row("rerun_case", "")
    _write_spec(spec_path, [{**row, "sha256": ""}])
    worker = workers / "rerun_case"
    sha = _write_case(worker / "case", 5.0)
    full = dict(row)
    full["sha256"] = sha
    (worker / "fragment.jsonl").write_text(json.dumps(full) + "\n")
    first = merge_sweep(spec_path, workers, out_dir)
    assert first["status"] == "ok"
    first_manifest = (out_dir / "manifest.jsonl").read_text()
    second = merge_sweep(spec_path, workers, out_dir)
    assert second["status"] == "ok"
    assert (out_dir / "manifest.jsonl").read_text() == first_manifest
    assert (out_dir / "cases" / "rerun_case" / "umean.f32").is_file()
    assert not (tmp_path / "out.staging").exists()


def test_merge_failure_removes_stale_outputs(tmp_path: Path) -> None:
    workers = tmp_path / "workers"
    out_dir = tmp_path / "out"
    spec_path = tmp_path / "cases.jsonl"
    row = _spec_row("stale_case", "")
    _write_spec(spec_path, [{**row, "sha256": ""}])
    worker = workers / "stale_case"
    sha = _write_case(worker / "case", 1.0)
    full = dict(row)
    full["sha256"] = sha
    (worker / "fragment.jsonl").write_text(json.dumps(full) + "\n")
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "ok"
    assert (out_dir / "manifest.jsonl").is_file()
    with open(worker / "case" / "umean.f32", "r+b") as handle:
        handle.seek(0)
        handle.write(b"\x00\x00\x80\x7f")
    report = merge_sweep(spec_path, workers, out_dir)
    assert report["status"] == "failed"
    assert not (out_dir / "manifest.jsonl").exists()
    assert not (out_dir / "cases").exists()
    assert (out_dir / "merge_report.json").is_file()
