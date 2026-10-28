"""Local entrypoint wiring for training/modal_train.py: git sha handoff."""

import inspect
import sys
import types
from pathlib import Path


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
