"""Unit tests for training/modal_upload.py with a fake Modal volume.

No test touches Modal or the network. The modal package is stubbed with a
fake volume that records batch calls, and dry run tests assert modal is
never imported. Layouts are synthetic tmp dirs, never the real data dir.
"""

import json
import struct
import sys
import types
from pathlib import Path

import modal_upload

SWEEP_ID = "sweep01"


def _write_analytic(root: Path, n_rows: int = 2, n_shards: int = 2) -> None:
    train_dir = root / "data" / "train"
    train_dir.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"id": f"a{i}", "split": "train"}) for i in range(n_rows)]
    (root / "data" / "manifest.jsonl").write_text("\n".join(lines) + "\n" if lines else "")
    for i in range(n_shards):
        (train_dir / f"shard-{i:03d}.npz").write_bytes(b"NPZ" + bytes([i]) * 100)


def _write_case(case_dir: Path, seed: float = 1.0) -> None:
    case_dir.mkdir(parents=True, exist_ok=True)
    blob = struct.pack("<4f", seed, seed + 1.0, seed + 2.0, seed + 3.0)
    (case_dir / "umean.f32").write_bytes(blob)
    (case_dir / "vmean.f32").write_bytes(blob)


def _write_sweep(root: Path, sweep_id: str = SWEEP_ID, case_ids: tuple = ("c01", "c02")) -> Path:
    sweep = root / "data" / "lbm" / sweep_id
    cases = sweep / "cases"
    rows = []
    for pos, case_id in enumerate(case_ids):
        _write_case(cases / case_id, seed=float(pos))
        rows.append({"case_id": case_id, "status": "completed", "nx": 2, "ny": 2})
    rows.append({"case_id": "d01", "status": "diverged"})
    sweep.mkdir(parents=True, exist_ok=True)
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return sweep


def _write_full_layout(root: Path) -> None:
    _write_analytic(root)
    _write_sweep(root)


class _FakeBatch:
    def __init__(self, calls: list) -> None:
        self._calls = calls

    def __enter__(self) -> "_FakeBatch":
        return self

    def __exit__(self, *exc: object) -> bool:
        return False

    def put_file(self, local_path: str, remote_path: str) -> None:
        self._calls.append(("file", str(local_path), str(remote_path)))

    def put_directory(self, local_dir: str, remote_dir: str) -> None:
        self._calls.append(("dir", str(local_dir), str(remote_dir)))


class _FakeVolume:
    def __init__(self, calls: list, seen: dict) -> None:
        self._calls = calls
        self._seen = seen

    def batch_upload(self, force: bool = False) -> _FakeBatch:
        self._seen["batches"] = self._seen.get("batches", 0) + 1
        self._seen["force"] = force
        return _FakeBatch(self._calls)


def _install_fake_modal(monkeypatch, calls: list, seen: dict) -> None:
    fake = types.ModuleType("modal")

    class _Volume:
        @staticmethod
        def from_name(name: str, create_if_missing: bool = False) -> _FakeVolume:
            seen["from_name"] = (name, create_if_missing)
            assert name == "gearflow-data"
            assert create_if_missing is False
            return _FakeVolume(calls, seen)

    fake.Volume = _Volume
    monkeypatch.setitem(sys.modules, "modal", fake)


def test_plan_full_layout(tmp_path: Path) -> None:
    _write_full_layout(tmp_path)
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["errors"] == []
    assert len(plan["entries"]) == 4
    by_remote = {e["remote_path"]: e for e in plan["entries"]}
    assert by_remote["analytic/manifest.jsonl"]["kind"] == "file"
    assert by_remote["analytic/train"]["kind"] == "dir"
    assert by_remote[f"lbm/{SWEEP_ID}/manifest.jsonl"]["kind"] == "file"
    assert by_remote[f"lbm/{SWEEP_ID}/cases"]["kind"] == "dir"
    for entry in plan["entries"]:
        assert Path(entry["local_path"]).exists()
    manifest_bytes = (tmp_path / "data" / "manifest.jsonl").stat().st_size
    assert by_remote["analytic/manifest.jsonl"]["bytes"] == manifest_bytes
    train_bytes = sum(p.stat().st_size for p in (tmp_path / "data" / "train").glob("*.npz"))
    assert by_remote["analytic/train"]["bytes"] == train_bytes
    assert plan["total_bytes"] == sum(e["bytes"] for e in plan["entries"])
    assert plan["total_bytes"] > 0
    assert plan["counts"]["entries"] == 4
    assert plan["counts"]["analytic_rows"] == 2
    assert plan["counts"]["sweep_completed"] == 2
    assert plan["counts"]["total_bytes"] == plan["total_bytes"]


def test_missing_analytic_manifest_error(tmp_path: Path) -> None:
    _write_sweep(tmp_path)
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["entries"] == []
    assert any("analytic manifest missing" in e for e in plan["errors"])


def test_missing_sweep_manifest_error(tmp_path: Path) -> None:
    _write_analytic(tmp_path)
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["entries"] == []
    assert any("sweep manifest missing" in e for e in plan["errors"])


def test_completed_row_without_case_dir_error(tmp_path: Path) -> None:
    _write_analytic(tmp_path)
    sweep = tmp_path / "data" / "lbm" / SWEEP_ID
    (sweep / "cases").mkdir(parents=True)
    rows = [
        {"case_id": "ghost", "status": "completed", "nx": 2, "ny": 2},
        {"case_id": "d01", "status": "diverged"},
    ]
    sweep.mkdir(parents=True, exist_ok=True)
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["entries"] == []
    assert any("ghost" in e and "case dir missing" in e for e in plan["errors"])


def test_completed_row_without_umean_bin_error(tmp_path: Path) -> None:
    _write_analytic(tmp_path)
    sweep = tmp_path / "data" / "lbm" / SWEEP_ID
    (sweep / "cases" / "c01").mkdir(parents=True)
    rows = [{"case_id": "c01", "status": "completed", "nx": 2, "ny": 2}]
    sweep.mkdir(parents=True, exist_ok=True)
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["entries"] == []
    assert any("umean.f32" in e for e in plan["errors"])


def test_zero_completed_rows_refused(tmp_path: Path) -> None:
    _write_analytic(tmp_path)
    sweep = tmp_path / "data" / "lbm" / SWEEP_ID
    (sweep / "cases").mkdir(parents=True)
    rows = [{"case_id": "d01", "status": "diverged"}]
    sweep.mkdir(parents=True, exist_ok=True)
    (sweep / "manifest.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    assert plan["entries"] == []
    assert any("zero completed rows" in e for e in plan["errors"])


def test_dry_run_makes_no_volume_calls(monkeypatch, tmp_path: Path, capsys) -> None:
    _write_full_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    saved = sys.modules.pop("modal", None)
    try:
        rc = modal_upload.main(["--sweep-id", SWEEP_ID, "--dry-run"])
        assert rc == 0
        assert "modal" not in sys.modules
        out = capsys.readouterr().out
        assert "upload total" in out
        assert "volume untouched" in out
    finally:
        if saved is not None:
            sys.modules["modal"] = saved


def test_skip_flags_shape_plan(tmp_path: Path) -> None:
    _write_full_layout(tmp_path)
    analytic_only = modal_upload.build_upload_plan(
        tmp_path, SWEEP_ID, include_analytic=True, include_sweep=False
    )
    assert analytic_only["errors"] == []
    assert [e["remote_path"] for e in analytic_only["entries"]] == [
        "analytic/manifest.jsonl",
        "analytic/train",
    ]
    sweep_only = modal_upload.build_upload_plan(
        tmp_path, SWEEP_ID, include_analytic=False, include_sweep=True
    )
    assert sweep_only["errors"] == []
    assert [e["remote_path"] for e in sweep_only["entries"]] == [
        f"lbm/{SWEEP_ID}/manifest.jsonl",
        f"lbm/{SWEEP_ID}/cases",
    ]
    neither = modal_upload.build_upload_plan(
        tmp_path, SWEEP_ID, include_analytic=False, include_sweep=False
    )
    assert neither["entries"] == []
    assert any("both skipped" in e for e in neither["errors"])


def test_skip_flags_cli(monkeypatch, tmp_path: Path, capsys) -> None:
    _write_full_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    calls: list = []
    seen: dict = {}
    _install_fake_modal(monkeypatch, calls, seen)
    rc = modal_upload.main(["--sweep-id", SWEEP_ID, "--skip-sweep"])
    assert rc == 0
    assert [c[2] for c in calls] == ["analytic/manifest.jsonl", "analytic/train"]
    out = capsys.readouterr().out
    assert "upload total: entries=2" in out


def test_force_passthrough_single_batch(monkeypatch, tmp_path: Path) -> None:
    _write_full_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    calls: list = []
    seen: dict = {}
    _install_fake_modal(monkeypatch, calls, seen)
    assert modal_upload.main(["--sweep-id", SWEEP_ID]) == 0
    assert seen["force"] is False
    assert seen["batches"] == 1
    assert len(calls) == 4
    assert calls[0][0] == "file" and calls[0][2] == "analytic/manifest.jsonl"
    assert calls[1][0] == "dir" and calls[1][2] == "analytic/train"
    assert calls[2][0] == "file" and calls[2][2] == f"lbm/{SWEEP_ID}/manifest.jsonl"
    assert calls[3][0] == "dir" and calls[3][2] == f"lbm/{SWEEP_ID}/cases"
    calls.clear()
    seen.clear()
    assert modal_upload.main(["--sweep-id", SWEEP_ID, "--force"]) == 0
    assert seen["force"] is True
    assert seen["batches"] == 1
    assert len(calls) == 4


def test_byte_totals_printed(monkeypatch, tmp_path: Path, capsys) -> None:
    _write_full_layout(tmp_path)
    monkeypatch.chdir(tmp_path)
    calls: list = []
    seen: dict = {}
    _install_fake_modal(monkeypatch, calls, seen)
    assert modal_upload.main(["--sweep-id", SWEEP_ID, "--dry-run"]) == 0
    out = capsys.readouterr().out
    plan = modal_upload.build_upload_plan(tmp_path, SWEEP_ID)
    for entry in plan["entries"]:
        assert f"bytes={entry['bytes']}" in out
    assert f"bytes={plan['total_bytes']}" in out


def test_no_secret_reads_in_upload_module() -> None:
    src = Path(modal_upload.__file__).read_text().lower()
    for needle in ("token", "password", "api_key", "apikey", "bearer", "os.environ", "os.getenv", "getenv"):
        assert needle not in src, needle
    assert "no secret" in src
    assert "no credential" in src
