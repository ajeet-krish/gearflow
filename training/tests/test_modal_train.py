"""Local entrypoint wiring for training/modal_train.py: git sha handoff."""

import inspect
import sys
import types
from pathlib import Path

import pytest

_D = chr(45)
_DD = _D * 2


def _import_modal_train():
    if "modal_train" in sys.modules:
        return sys.modules["modal_train"]
    if "modal" not in sys.modules:
        fake = types.ModuleType("modal")

        class _App:
            def __init__(self, *args, **kwargs):
                pass

            def function(self, *args, **kwargs):
                def deco(fn):
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

            def add_local_file(self, *args, **kwargs):
                return self

            def env(self, *args, **kwargs):
                return self

        class _Volume:
            @staticmethod
            def from_name(*args, **kwargs):
                return _Volume()

        fake.App = _App
        fake.Image = _Image
        fake.Volume = _Volume
        sys.modules["modal"] = fake
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import modal_train

    return modal_train


def test_local_git_sha_format() -> None:
    modal_train = _import_modal_train()
    sha = modal_train._local_git_sha()
    assert sha == "unknown" or (
        len(sha) == 40 and all(c in "0123456789abcdef" for c in sha)
    )


def test_run_stage_accepts_local_git_sha() -> None:
    modal_train = _import_modal_train()
    params = inspect.signature(modal_train.run_stage).parameters
    assert "git_sha" in params
    assert params["git_sha"].default == "unknown"


class _FakeStage:
    def __init__(self) -> None:
        self.calls: list = []

    def remote(self, stage: str, run_id: str, *args: object, **kwargs: object) -> dict:
        self.calls.append(stage)
        return {"stage": stage, "runId": run_id}


class _FakeVolume:
    def __init__(self, blobs: dict) -> None:
        self.blobs = dict(blobs)
        self.reads: list = []

    def read_file(self, path: str) -> bytes:
        self.reads.append(path)
        if path in self.blobs:
            data = self.blobs[path]
            return data if isinstance(data, bytes) else str(data).encode()
        raise FileNotFoundError(path)


def _blobs_for(run_id: str, stage: str) -> dict:
    return {f"{run_id}/{stage}/{name}": f"{stage}:{name}".encode() for name in ("best.pt", "norm.json", "run_log.json")}


def _patch_entrypoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, modal_train: object, blobs: dict) -> tuple:
    stage = _FakeStage()
    volume = _FakeVolume(blobs)
    monkeypatch.setattr(modal_train, "run_stage", stage)
    monkeypatch.setattr(modal_train, "ckpt_volume", volume)
    monkeypatch.setattr(modal_train, "_local_git_sha", lambda: "unknown")
    monkeypatch.chdir(tmp_path)
    return stage, volume


def test_finetune_defaults_support_long_schedule() -> None:
    modal_train = _import_modal_train()
    assert modal_train.FINETUNE_DEFAULTS["epochs"] == 200
    assert modal_train.FINETUNE_DEFAULTS["batch"] == 8
    assert modal_train.FINETUNE_DEFAULTS["lr"] == 5e-5
    assert modal_train.FINETUNE_DEFAULTS["div_weight"] == 0.01
    assert modal_train.PRETRAIN_DEFAULTS == {"epochs": 60, "batch": 32, "lr": 3e-4, "div_weight": 0.0}


def test_validate_hparams_epochs_cap() -> None:
    modal_train = _import_modal_train()
    modal_train._validate_hparams("finetune", 8, 200, 8, 5e-5)
    modal_train._validate_hparams("pretrain", 8, 60, 32, 3e-4)
    with pytest.raises(ValueError):
        modal_train._validate_hparams("finetune", 8, 301, 8, 5e-5)
    with pytest.raises(ValueError):
        modal_train._validate_hparams("finetune", 8, 0, 8, 5e-5)


def test_download_routes_per_stage() -> None:
    modal_train = _import_modal_train()
    run_id = "r9"
    train_routes = modal_train._download_routes("train", run_id)
    assert [r for r, _ in train_routes] == [f"{run_id}/finetune/{n}" for n in modal_train.ARTIFACT_NAMES]
    assert [str(p) for _, p in train_routes] == [f"training/checkpoints/v2/{run_id}/{n}" for n in modal_train.ARTIFACT_NAMES]
    assert all("pretrain" not in str(p) for _, p in train_routes)
    finetune_routes = modal_train._download_routes("finetune", run_id)
    assert [(r, str(p)) for r, p in finetune_routes] == [(r, str(p)) for r, p in train_routes]
    pretrain_routes = modal_train._download_routes("pretrain", run_id)
    assert [r for r, _ in pretrain_routes] == [f"{run_id}/pretrain/{n}" for n in modal_train.ARTIFACT_NAMES]
    assert [str(p) for _, p in pretrain_routes] == [f"training/checkpoints/v2/{run_id}/pretrain/{n}" for n in modal_train.ARTIFACT_NAMES]
    with pytest.raises(ValueError):
        modal_train._download_routes("nope", run_id)


def test_download_routes_touch_no_volume() -> None:
    modal_train = _import_modal_train()
    src = inspect.getsource(modal_train._download_routes)
    assert "ckpt_volume" not in src
    assert "read_file" not in src


def test_pretrain_only_runs_single_stage(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "pre1"
    stage, _ = _patch_entrypoint(monkeypatch, tmp_path, modal_train, _blobs_for(run_id, "pretrain"))
    modal_train.main(action="pretrain", run_id=run_id, sweep_id="pilot")
    assert stage.calls == ["pretrain"]
    dest = tmp_path / "training" / "checkpoints" / "v2" / run_id / "pretrain"
    for name in modal_train.ARTIFACT_NAMES:
        assert (dest / name).is_file()
    assert not (tmp_path / "training" / "checkpoints" / "v2" / run_id / "best.pt").exists()


def test_finetune_only_runs_single_stage(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "ft1"
    blobs = _blobs_for(run_id, "finetune")
    blobs[modal_train._pretrain_checkpoint_remote(run_id)] = b"pretrain-best"
    stage, _ = _patch_entrypoint(monkeypatch, tmp_path, modal_train, blobs)
    modal_train.main(action="finetune", run_id=run_id, sweep_id="pilot")
    assert stage.calls == ["finetune"]
    dest = tmp_path / "training" / "checkpoints" / "v2" / run_id
    for name in modal_train.ARTIFACT_NAMES:
        assert (dest / name).is_file()


def test_train_default_runs_both_stages(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "both1"
    params = inspect.signature(modal_train.main).parameters
    assert params["action"].default == "train"
    blobs = _blobs_for(run_id, "finetune")
    blobs.update(_blobs_for(run_id, "pretrain"))
    stage, volume = _patch_entrypoint(monkeypatch, tmp_path, modal_train, blobs)
    modal_train.main(run_id=run_id, sweep_id="pilot")
    assert stage.calls == ["pretrain", "finetune"]
    dest = tmp_path / "training" / "checkpoints" / "v2" / run_id
    for name in modal_train.ARTIFACT_NAMES:
        assert (dest / name).is_file()
        assert (dest / name).read_bytes() == f"finetune:{name}".encode()
    assert f"{run_id}/finetune/best.pt" in volume.reads


def test_finetune_only_missing_checkpoint_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "missing1"
    stage, _ = _patch_entrypoint(monkeypatch, tmp_path, modal_train, _blobs_for(run_id, "finetune"))
    with pytest.raises(ValueError, match="pretrain checkpoint missing"):
        modal_train.main(action="finetune", run_id=run_id, sweep_id="pilot")
    assert stage.calls == []


def test_finetune_only_empty_probe_fails_closed(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "empty1"
    blobs = _blobs_for(run_id, "finetune")
    blobs[modal_train._pretrain_checkpoint_remote(run_id)] = b""
    stage, _ = _patch_entrypoint(monkeypatch, tmp_path, modal_train, blobs)
    with pytest.raises(ValueError, match="pretrain checkpoint missing"):
        modal_train.main(action="finetune", run_id=run_id, sweep_id="pilot")
    assert stage.calls == []


def test_pretrain_only_needs_no_checkpoint(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    modal_train = _import_modal_train()
    run_id = "nopre1"
    stage, _ = _patch_entrypoint(monkeypatch, tmp_path, modal_train, _blobs_for(run_id, "pretrain"))
    modal_train.main(action="pretrain", run_id=run_id, sweep_id="pilot")
    assert stage.calls == ["pretrain"]


def test_sweep_points_to_sweep_module() -> None:
    modal_train = _import_modal_train()
    with pytest.raises(NotImplementedError) as excinfo:
        modal_train.main(action="sweep")
    assert "modal_sweep.py" in str(excinfo.value)
    assert "not built yet" not in str(excinfo.value).lower()


def test_invalid_action_rejected() -> None:
    modal_train = _import_modal_train()
    with pytest.raises(ValueError):
        modal_train.main(action="nope")


def test_no_remote_call_on_import() -> None:
    modal_train = _import_modal_train()
    main_src = inspect.getsource(modal_train.main)
    assert main_src.count(".remote") == 2
    mod_src = (Path(__file__).resolve().parent.parent / "modal_train.py").read_text()
    pre_main = mod_src.split("def main")[0]
    assert ".remote" not in pre_main


def test_source_has_no_stale_markers() -> None:
    src = (Path(__file__).resolve().parent.parent / "modal_train.py").read_text()
    assert "not built yet" not in src.lower()
    assert _DD not in src
    assert chr(8212) not in src
