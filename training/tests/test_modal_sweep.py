"""Static contract tests for training/modal_sweep.py and the sweep stub.

No test launches a Modal job. The modal package is stubbed in the same
style as test_modal_train.py. Image, fanout, cache, diverged, secrets,
and stub guidance are pinned by reading module source plus decorator
kwargs, with local behavioral checks using tmp dirs and stubbed run.
"""

import hashlib
import inspect
import json
import struct
import sys
import types
from pathlib import Path
from types import SimpleNamespace

_D = chr(45)
_DD = _D * 2

TRAINING_DIR = Path(__file__).resolve().parent.parent
SWEEP_FILE = TRAINING_DIR / "modal_sweep.py"
TRAIN_FILE = TRAINING_DIR / "modal_train.py"


def _ensure_fake_modal():
    fake = sys.modules.get("modal")
    needs = ("App", "Image", "Volume")
    has_full = (
        fake is not None
        and all(hasattr(fake, n) for n in needs)
        and hasattr(getattr(fake.Image, "debian_slim", None), "__call__")
        and hasattr(fake.Image, "apt_install")
        and hasattr(fake.Image, "run_commands")
        and hasattr(fake.Image, "add_local_dir")
    )
    if has_full:
        if not hasattr(fake, "_function_kwargs"):
            fake._function_kwargs = {}
        if not hasattr(fake, "_volumes"):
            fake._volumes = []
        return fake
    fake = types.ModuleType("modal")
    fake._function_kwargs = {}
    fake._volumes = []

    class _App:
        def __init__(self, *args, **kwargs):
            self.name = args[0] if args else kwargs.get("name")

        def function(self, *args, **kwargs):
            def deco(fn):
                fn._modal_kwargs = dict(kwargs)
                fake._function_kwargs[fn.__name__] = dict(kwargs)
                return fn

            return deco

        def local_entrypoint(self, *args, **kwargs):
            def deco(fn):
                return fn

            return deco

    class _Image:
        @staticmethod
        def debian_slim(*args, **kwargs):
            return _Image()

        def pip_install(self, *args, **kwargs):
            return self

        def apt_install(self, *args, **kwargs):
            return self

        def run_commands(self, *args, **kwargs):
            return self

        def add_local_file(self, *args, **kwargs):
            return self

        def add_local_dir(self, *args, **kwargs):
            return self

        def env(self, *args, **kwargs):
            return self

    class _Volume:
        @staticmethod
        def from_name(*args, **kwargs):
            if args:
                fake._volumes.append(args[0])
            elif "name" in kwargs:
                fake._volumes.append(kwargs["name"])
            return _Volume()

        def __repr__(self):
            return "fake-volume"

    fake.App = _App
    fake.Image = _Image
    fake.Volume = _Volume
    sys.modules["modal"] = fake
    return fake


def _load_sweep():
    _ensure_fake_modal()
    sys.modules.pop("modal_sweep", None)
    if str(TRAINING_DIR) not in sys.path:
        sys.path.insert(0, str(TRAINING_DIR))
    import modal_sweep

    return modal_sweep


def _load_train():
    _ensure_fake_modal()
    sys.modules.pop("modal_train", None)
    if str(TRAINING_DIR) not in sys.path:
        sys.path.insert(0, str(TRAINING_DIR))
    import modal_train

    return modal_train


def _sweep_src():
    return SWEEP_FILE.read_text()


def _bin_names(version):
    names = ["umean.f32", "vmean.f32", "pmean.f32", "omegamean.f32", "tke.f32", "recirc.f32", "obstacle.f32"]
    if version >= 2:
        names = names + ["sdf.f32"]
    return names


def _write_valid_cache(worker, case_id, nx=4, ny=4, version=2):
    case_dir = worker / "case"
    case_dir.mkdir(parents=True, exist_ok=True)
    hasher = hashlib.sha256()
    count = nx * ny
    blob = struct.pack("<" + str(count) + "f", *([1.0] * count))
    for name in _bin_names(version):
        (case_dir / name).write_bytes(blob)
        hasher.update(blob)
    row = {
        "case_id": case_id,
        "status": "completed",
        "nx": nx,
        "ny": ny,
        "sha_version": version,
        "sha256": hasher.hexdigest(),
    }
    (worker / "fragment.jsonl").write_text(json.dumps(row) + "\n")
    return row


def test_image_uses_locked_release_build():
    sweep = _load_sweep()
    src = _sweep_src()
    assert "cargo build" in src
    assert (_DD + "locked") in src
    assert (_DD + "release") in src
    assert (_DD + "manifest-path") in src
    assert (_DD + "bin") in src
    assert "dataset_pilot" in src
    assert "test " + _D + "x" in src
    assert sweep.BINARY_PATH == "/root/gearflow-wasm/target/release/dataset_pilot"


def test_image_pins_toolchain_and_source_dir():
    sweep = _load_sweep()
    src = _sweep_src()
    assert sweep.RUST_TOOLCHAIN == "1.85.0"
    assert "1.85.0" in src
    assert "rustup toolchain install" in src
    assert "rust/gearflow-wasm" in src
    assert "add_local_dir" in src
    assert "build-essential" in src


def test_fanout_cap_and_worker_resources():
    fake = _ensure_fake_modal()
    _load_sweep()
    kwargs = fake._function_kwargs["run_case_remote"]
    assert kwargs.get("max_containers") == 16
    assert kwargs.get("cpu") == 4
    assert kwargs.get("memory") == 4096
    assert kwargs.get("timeout") == 1800
    assert kwargs.get("retries") == 2
    assert kwargs.get("volumes", {}).get("/sweep") is not None


def test_main_fans_out_one_container_per_case():
    sweep = _load_sweep()
    params = inspect.signature(sweep.main).parameters
    assert "sweep_id" in params
    assert "force" in params
    assert params["force"].default is False
    src = inspect.getsource(sweep.main)
    assert ".map(payloads)" in src
    assert '"force"' in src or "'force'" in src or "force" in src
    assert "cases.jsonl" in src
    assert "duplicate case_id" in src


def test_cached_verified_outputs_skip_unless_force_static():
    sweep = _load_sweep()
    src = inspect.getsource(sweep.run_case_remote)
    assert "if not force" in src
    assert "_verify_cached_bins" in src
    assert '"cached", True' in src or "'cached', True" in src or '"cached": True' in src
    for status in ("completed", "diverged", "setup_error"):
        assert status in src
    verify_src = inspect.getsource(sweep._verify_cached_bins)
    assert "sha256" in verify_src
    assert "inf" in verify_src


def test_cached_completed_with_valid_bins_returns_cached(monkeypatch, tmp_path):
    sweep = _load_sweep()
    case_id = "case01"
    worker = tmp_path / "workers" / case_id
    worker.mkdir(parents=True)
    _write_valid_cache(worker, case_id)
    monkeypatch.setattr(sweep, "_worker_dir", lambda s, c: tmp_path / "workers" / c)
    binary = tmp_path / "dataset_pilot"
    binary.write_bytes(b"run")
    monkeypatch.setattr(sweep, "BINARY_PATH", str(binary))

    def _fail(*args, **kwargs):
        raise AssertionError("subprocess must not run for verified cache")

    monkeypatch.setattr("subprocess.run", _fail)
    out = sweep.run_case_remote({"case": {"case_id": case_id}, "sweep_id": "s1"})
    assert out == {"case_id": case_id, "status": "completed", "cached": True}


def test_corrupt_cache_falls_through_to_run(monkeypatch, tmp_path):
    sweep = _load_sweep()
    case_id = "case02"
    worker = tmp_path / "workers" / case_id
    worker.mkdir(parents=True)
    _write_valid_cache(worker, case_id)
    (worker / "case" / "umean.f32").write_bytes(b"short")
    monkeypatch.setattr(sweep, "_worker_dir", lambda s, c: tmp_path / "workers" / c)
    binary = tmp_path / "dataset_pilot"
    binary.write_bytes(b"run")
    monkeypatch.setattr(sweep, "BINARY_PATH", str(binary))
    called = {}

    def _fake_run(cmd, **kwargs):
        called["ran"] = True
        idx = list(cmd).index("manifest_out") + 1
        frag = Path(cmd[idx])
        row = {"case_id": case_id, "status": "completed", "nx": 4, "ny": 4, "sha_version": 2, "sha256": "x"}
        frag.write_text(json.dumps(row) + "\n")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr("subprocess.run", _fake_run)
    out = sweep.run_case_remote({"case": {"case_id": case_id}, "sweep_id": "s1"})
    assert called.get("ran") is True
    assert out["cached"] is False
    assert out["status"] == "completed"


def test_force_bypasses_verified_cache(monkeypatch, tmp_path):
    sweep = _load_sweep()
    case_id = "case03"
    worker = tmp_path / "workers" / case_id
    worker.mkdir(parents=True)
    _write_valid_cache(worker, case_id)
    monkeypatch.setattr(sweep, "_worker_dir", lambda s, c: tmp_path / "workers" / c)
    binary = tmp_path / "dataset_pilot"
    binary.write_bytes(b"run")
    monkeypatch.setattr(sweep, "BINARY_PATH", str(binary))
    called = {}

    def _fake_run(cmd, **kwargs):
        called["ran"] = True
        idx = list(cmd).index("manifest_out") + 1
        frag = Path(cmd[idx])
        row = {"case_id": case_id, "status": "completed", "nx": 4, "ny": 4, "sha_version": 2, "sha256": "x"}
        frag.write_text(json.dumps(row) + "\n")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr("subprocess.run", _fake_run)
    out = sweep.run_case_remote({"case": {"case_id": case_id}, "sweep_id": "s1", "force": True})
    assert called.get("ran") is True
    assert out["cached"] is False


def test_diverged_cached_row_returns_success(monkeypatch, tmp_path):
    sweep = _load_sweep()
    case_id = "case04"
    worker = tmp_path / "workers" / case_id
    (worker / "case").mkdir(parents=True)
    row = {"case_id": case_id, "status": "diverged"}
    (worker / "fragment.jsonl").write_text(json.dumps(row) + "\n")
    monkeypatch.setattr(sweep, "_worker_dir", lambda s, c: tmp_path / "workers" / c)
    binary = tmp_path / "dataset_pilot"
    binary.write_bytes(b"run")
    monkeypatch.setattr(sweep, "BINARY_PATH", str(binary))

    def _fail(*args, **kwargs):
        raise AssertionError("diverged cache must not rerun")

    monkeypatch.setattr("subprocess.run", _fail)
    out = sweep.run_case_remote({"case": {"case_id": case_id}, "sweep_id": "s1"})
    assert out == {"case_id": case_id, "status": "diverged", "cached": True}


def test_diverged_fresh_run_returns_success_without_retry(monkeypatch, tmp_path):
    sweep = _load_sweep()
    fake = _ensure_fake_modal()
    assert fake._function_kwargs["run_case_remote"].get("retries") == 2
    func_src = inspect.getsource(sweep.run_case_remote)
    assert "diverged" in func_src
    assert "never" in func_src
    assert "retry" in func_src.lower()
    case_id = "case05"
    monkeypatch.setattr(sweep, "_worker_dir", lambda s, c: tmp_path / "workers" / c)
    binary = tmp_path / "dataset_pilot"
    binary.write_bytes(b"run")
    monkeypatch.setattr(sweep, "BINARY_PATH", str(binary))

    def _fake_run(cmd, **kwargs):
        idx = list(cmd).index("manifest_out") + 1
        frag = Path(cmd[idx])
        frag.write_text(json.dumps({"case_id": case_id, "status": "diverged"}) + "\n")
        return SimpleNamespace(returncode=0, stderr="", stdout="")

    monkeypatch.setattr("subprocess.run", _fake_run)
    out = sweep.run_case_remote({"case": {"case_id": case_id}, "sweep_id": "s1"})
    assert out == {"case_id": case_id, "status": "diverged", "cached": False}


def test_no_secret_reads_in_sweep_module():
    src = _sweep_src()
    lowered = src.lower()
    for needle in ("token", "password", "api_key", "apikey", "bearer", "os.environ", "os.getenv", "getenv", "modal.secret"):
        assert needle not in lowered, needle
    secret_lines = [line for line in src.splitlines() if "secret" in line.lower()]
    assert secret_lines
    assert all("no secret" in line.lower() for line in secret_lines)


def test_sweep_action_stub_guidance_in_train():
    train = _load_train()
    params = inspect.signature(train.main).parameters
    assert params["action"].default == "train"
    src = inspect.getsource(train.main)
    assert "NotImplementedError" in src
    assert "modal_sweep.py" in src
    try:
        train.main(action="sweep")
    except NotImplementedError as exc:
        assert "modal_sweep" in str(exc)
    else:
        raise AssertionError("action sweep must raise NotImplementedError")


def test_volume_layout_and_local_merge_note():
    sweep = _load_sweep()
    assert sweep.SWEEP_MOUNT == "/sweep"
    assert "gearflow-sweep" in _ensure_fake_modal()._volumes
    worker = sweep._worker_dir("pilot", "c09")
    assert worker.as_posix().endswith("/sweep/runs/pilot/workers/c09")
    assert "fragment.jsonl" in _sweep_src()
    assert "merge_sweep" in _sweep_src()
